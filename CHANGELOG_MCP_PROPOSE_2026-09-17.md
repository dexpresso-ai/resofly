# De gekoppelde AI mag nu ook dingen klaarzetten

**17 september 2026 · fase B · volgt op [CHANGELOG_MCP_CONNECTOR_2026-09-16.md](CHANGELOG_MCP_CONNECTOR_2026-09-16.md)**

Fase A liet de eigen AI van een klant meelezen. Vanaf nu kan hij ook iets in gang zetten: "stuur Jansen een herinnering" of "zet die uren op het project" belandt als kaart in de goedkeurwachtrij in ResoFly. Wat een gekoppelde AI kan, kan Gerrie ook — het verschil zit niet in wat er mag, maar in wiens model het is en wie ervoor betaalt.

## Klaarzetten, niet uitvoeren

Er is geen pad bijgekomen waarlangs een model iets doet. `propose_action` roept `plan()` aan uit de handelingenregistry; dat bouwt een **voorstel** — een titel, een onderschrift en een payload — en dat gaat als `proposed` het auditlog in. Daar pikt de goedkeurwachtrij het op. Klikt niemand, dan gebeurt er niets.

Dat is dezelfde weg die een geplande Gerrie-agent al neemt, en om dezelfde reden: allebei zijn ze headless, allebei zetten ze iets klaar terwijl er niemand kijkt. De hele schrijfkant bestond dus al; er hoefde maar één ding bij, namelijk waar een voorstel vandaan komt (`ai_action_audit.mcp_grant_id`).

Het **uitvoeren** gebeurt in de browser van degene die klikt, onder zijn eigen sessie. Daar geldt RLS, gelden de modulepoorten en gelden de tenant-triggers. De service-role komt er niet aan te pas.

## De klantgrens, niet beloofd maar getest

De harde eis was: een gekoppelde AI mag nooit bij een andere klant kunnen. Drie sloten, die los van elkaar werken:

1. **De organisatie komt uit de koppeling.** Een token wijst naar één rij in `mcp_grants`: één gebruiker, één organisatie. Die `organization_id` gaat als `ActionCtx.organizationId` de handeling in. Het model kan hem niet meesturen — er is geen invoerveld voor.
2. **Elke query filtert erop.** De registry draait op de service-role en slaat RLS dus over; dat filter is daar de enige grens. Een id van een andere organisatie loopt stuk op `row()` met *"niet gevonden in deze organisatie"*.
3. **Uitvoeren gebeurt onder een menselijke sessie**, waar RLS alsnog weigert wat er niet hoort.

Het tweede slot was tot nu toe een afspraak. Nu is het `actionTenancy.test.ts`: die leest de hele registry na en faalt op een query zonder org-filter, een RPC zonder organisatie, en op elke poging een organisatie-id uit de invoer van het model te lezen. Nagemeten op de huidige registry: 166 keer `orgQuery`, 183 keer `row()`, 19 rechtstreekse queries die allemaal zelf filteren, en 20 RPC's met `p_organization_id: ctx.organizationId` — de enige zonder organisatie is een landelijk belastingtarief op datum, en die staat met die reden op een benoemde uitzonderingslijst.

De test is ook van de verkeerde kant nagelopen: alle zeven manieren om de grens te omzeilen (met enkele én dubbele aanhalingstekens) worden betrapt, en geldige code die afwijkt van de huisstijl geeft geen vals alarm.

## Wie beslist wat er mag

Een AI-client vraagt onze scopes niet op naam — hij kent ze niet. Daarom is wat de client meestuurt een **plafond** en kiest de gebruiker daarbinnen, op het toestemmingsscherm. Dat scherm heeft er één keuze bij: *laat deze AI ook wijzigingen klaarzetten*. Standaard aan, één vinkje uit houdt het bij meelezen.

De keuze wordt teruggeknipt op het ondertekende aanbod, dus een aangepast formulier levert nooit meer op dan er bij `/authorize` is vastgelegd. Ontbreekt het veld, dan wordt het meelezen: een koppeling die per ongeluk te weinig mag, merkt de gebruiker meteen — een die per ongeluk te veel mag, merkt niemand.

Daarbovenop gelden de gewone modulerechten. Een member met Financiën op "lezen" kan via zijn AI geen factuur klaarzetten, precies zoals in het scherm. En een koppeling die alleen mag meelezen, krijgt `propose_action` niet eens in zijn toollijst — wat er niet is, kan een model ook niet proberen.

## Wat de gebruiker ziet

- **Toestemmingsscherm:** vier feiten in plaats van drie. Mag meelezen · mag wijzigingen klaarzetten (of: kan niets wijzigen) · voert nooit zelf iets uit · altijd in te trekken. Plus het vinkje.
- **Goedkeurwachtrij:** voorstellen van een gekoppelde AI krijgen een eigen, tonaal merkteken en het label *gekoppelde AI* — bewust niet het gouden embleem van een Gerrie-agent. Het komt van een model dat niet van ons is, en dat hoor je te zien voordat je op Uitvoeren klikt.
- **Instellingen → AI:** per koppeling staat er nu bij of hij meeleest of ook klaarzet.
- **Intrekken** annuleert wat er nog klaarstond. Zou dat niet gebeuren, dan drukt iemand op intrekken omdat er iets mis is en staat er daarna nog een rij klaar die die AI had opgesteld.

## Wat het model te horen krijgt

De `instructions` bij het koppelen zijn aangevuld met de regel waar een model anders overheen leest: *na een `propose_action` is er nog niets gebeurd — geen mail verstuurd, geen factuur aangemaakt. Schrijf "ik heb het klaargezet", nooit "ik heb het verstuurd".* Het antwoord van de tool herhaalt dat nog eens. We leunen er niet op — de echte grens is dat er niets uitgevoerd kán worden — maar een AI die de gebruiker verkeerd informeert is ook zonder dataschade een probleem.

## Wat er níét in zit

| Niet gebouwd | Waarom |
|---|---|
| Zelf uitvoeren zonder klik | De invariant. Ook op verzoek van de gebruiker niet. |
| Bevestigen binnen de AI-app (MCP elicitation) | Die bevestiging wordt gerenderd door een client die niet van ons is; wat er dan op het scherm staat, bepaalt het model. Een akkoord hoort in onze app, op onze tekst. |
| Server-side uitvoerders voor de 188 schrijf-handelingen | Dubbele implementatie, en het haalt juist het slot weg dat het uitvoeren onder een menselijke sessie legt. |
| Melding bij een nieuw AI-voorstel | De push-infrastructuur ligt er (`decision_digest`); een variant hiervoor is een losse toevoeging. |

Nagemeten: `npm test` 178 tests groen (169 + 6 grensbewaking + 3 scope), `npm run typecheck` en `npm run build` groen. De edge functions zijn met `tsc --noResolve` gecontroleerd; `deno check` kon in deze omgeving niet draaien en hoort vóór het uitrollen alsnog te lopen.
