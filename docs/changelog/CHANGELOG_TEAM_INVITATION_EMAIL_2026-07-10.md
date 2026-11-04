# Teamuitnodiging — e-mail wordt nu daadwerkelijk verstuurd (2026-07-10)

## Probleem
Bij het uitnodigen van een teamlid (Instellingen → Team → "Uitnodigen") kwam er
geen e-mail aan bij de uitgenodigde persoon.

**Oorzaak:** de flow maakte alléén een databaserij aan. `inviteOrganizationMember`
→ RPC `invite_organization_member` doet enkel een `INSERT` in
`organization_invitations`. De triggers op die tabel doen identity-guard, audit
en licentiecapaciteit — geen enkele verstuurt e-mail. De `mail`-edge function had
ook geen actie voor teamuitnodigingen. De uitnodiging was daardoor alleen
zichtbaar als de uitgenodigde toevallig zelf inlogde (magic link) en de sectie
"Openstaande uitnodigingen voor jou" opende.

## Oplossing
Nieuwe actie `sendTeamInvitation` in de bestaande `mail`-edge function (zelfde
Resend-patroon als de klantwelkomstmail), aangeroepen direct nadat de uitnodiging
is aangemaakt.

- `supabase/functions/mail/index.ts`
  - Nieuwe actie `sendTeamInvitation` (owner/admin-only): laadt de pending
    uitnodiging server-side, bouwt een gebrande HTML/plaintext-mail met uitleg +
    inloglink en verstuurt via Resend met `resolveSenderIdentity` (eigen
    verzenddomein indien geverifieerd, anders `RESEND_FROM_EMAIL`).
  - `APP_BASE_URL` (env-fallback `APP_PUBLIC_URL` → `CLIENT_PORTAL_BASE_URL` →
    `QUOTE_PUBLIC_BASE_URL` → `INVOICE_PUBLIC_BASE_URL`, anders de request-origin).
  - Idempotency-key op `invitation-id + updated_at`: re-invite verstuurt opnieuw,
    dubbelklik wordt door Resend ontdubbeld.
- `src/lib/repository.ts` — `sendTeamInvitationEmail(organizationId, invitationId)`.
- `src/main.tsx` — `inviteMember` roept na de invite de mail aan; een mislukte
  mail draait de uitnodiging niet terug maar wordt apart teruggegeven.
- `src/features/SimplePages.tsx` — toont "Uitnodiging verstuurd naar …" bij
  succes, of een eerlijke waarschuwing als alleen de mail mislukte (met het
  alternatief dat het teamlid ook zelf kan inloggen om te accepteren).

## Ontwerpkeuze
De uitnodigingsmail bevat geen aparte accepteer-token/link; de acceptatie loopt
via de bestaande in-app flow. De mail vraagt de ontvanger in te loggen met exact
dit e-mailadres — na de magic-link-login verschijnt de uitnodiging vanzelf onder
"Openstaande uitnodigingen voor jou".

## Deploy (vereist)
De codewijziging aan de edge function werkt pas na uitrollen:

```
supabase functions deploy mail
```

Vereist geen nieuwe secrets. `RESEND_FROM_EMAIL` en `MAIL_ALLOWED_ORIGINS`
(of `QUOTE_ALLOWED_ORIGINS`) worden al gebruikt door de bestaande mailacties.
`APP_PUBLIC_URL` is optioneel — zonder deze valt de inloglink terug op de origin
van de app waar de admin op dat moment werkt.

## Test
1. Deploy de `mail`-functie.
2. Instellingen → Team → nodig een e-mailadres uit dat je kunt inzien.
3. Controleer dat de mail binnenkomt ("Je bent uitgenodigd voor …").
4. Log met dat e-mailadres in via de magic link → uitnodiging staat klaar →
   accepteren.
