-- ============================================================
-- ResoFly — De gekoppelde AI mag rechtstreeks uitvoeren (MCP fase D)
-- Date: 2026-09-18
--
-- Aanleiding:
-- Fase A liet de eigen AI van een klant meelezen, fase B liet hem wijzigingen
-- KLAARZETTEN in de goedkeurwachtrij. Dat is de veilige standaard en blijft dat,
-- maar het is niet altijd het antwoord dat iemand wil. Wie zijn AI vraagt "zet
-- die factuur op betaald", wil niet horen dat het klaarstaat; hij wil dat het
-- gebeurd is.
--
-- Dus een derde stand, die de gebruiker ZELF aanzet — en uitzet — onder
-- Instellingen → AI.
--
-- TWEE SCHAKELAARS, GEEN ÉÉN
-- "Rechtstreeks uitvoeren" is één wens maar niet één risico. Een projectstatus
-- die verkeerd gezet wordt zet je terug; een aanmaning die naar de verkeerde
-- klant ging niet. De registry weet dat verschil al (`risk: 'high'` op 69 van de
-- 188 schrijf-handelingen — dat is waarom de knop in de app daar "Definitief
-- uitvoeren" heet), en dat verschil loopt hier door:
--   scope `execute`       — omkeerbare handelingen, rechtstreeks.
--   scope `execute_high`  — ook de onomkeerbare. Apart aan te zetten, standaard uit.
-- Zou dat één schakelaar zijn, dan zet iemand ze samen aan of samen uit — en dan
-- kiest hij tussen "mijn AI mag niets doen" en "mijn AI mag mailen naar klanten".
--
-- WAT DE DATABASE HIERVOOR NODIG HEEFT
-- Bijna niets, en dat is geen toeval: het uitvoeren zelf zit in de edge function
-- (supabase/functions/_shared/actions/apply.ts) en het resultaat landt in
-- `ai_action_audit`, waar de status 'auto_executed' al bestaat sinds de geplande
-- agents. Wat er wél bij moet is de vraag WIE de schakelaar mag omzetten, en dat
-- is precies wat deze migratie regelt.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Het plafond van de client, bewaard bij de koppeling ──────────────────
--
-- `scope` is wat deze koppeling NU mag. Daarnaast hoort vast te liggen wat de
-- AI-client bij het koppelen ten hoogste vroeg: een client die uitdrukkelijk
-- alleen wilde meelezen, hoort geen uitvoerrechten te kunnen krijgen doordat de
-- gebruiker later een schakelaar omzet. Tot nu toe stond dat plafond alleen in
-- het ondertekende koppelverzoek — dat is weg zodra het koppelen klaar is, en
-- daarna is er niets meer om de schakelaar aan te toetsen.
--
-- Bestaande rijen krijgen het volle plafond. Wat die clients destijds vroegen is
-- niet meer te achterhalen, en in de praktijk vraagt vrijwel geen enkele client
-- scopes op naam (dan bieden we alles aan en kiest de gebruiker). De veilige
-- kant zit hier niet in het plafond maar in `scope` zelf: die blijft staan zoals
-- hij was, en alleen de gebruiker kan hem zelf verruimen.
alter table public.mcp_grants
  add column if not exists scope_ceiling text not null default 'read propose execute execute_high';

comment on column public.mcp_grants.scope_ceiling is
  'Wat de AI-client bij het koppelen ten hoogste vroeg. De gebruiker kan onder Instellingen → AI alleen binnen dit plafond schuiven.';

-- ── 2. Wie mag wat wijzigen aan een koppeling ───────────────────────────────
--
-- De update-policy uit 20260917020000 laat ELKE kolom toe; een trigger houdt de
-- rest dicht. Dat blijft zo, met één opening erbij: de EIGENAAR van de koppeling
-- mag zijn eigen scope wijzigen. Dat is de schakelaar onder Instellingen → AI.
--
-- De drie regels die daarbij gelden, en waarom:
--
--  1. ALLEEN DE EIGENAAR. Een owner of admin ziet de koppelingen van zijn team
--     en kan ze stoppen — dat is toezicht. Maar iemand anders MEER laten doen
--     met een AI-koppeling is geen toezicht; dat is namens hem een keuze maken
--     die zijn rechten gebruikt. Stoppen kan altijd, verruimen alleen zelf.
--  2. BINNEN HET PLAFOND. Zie hierboven: nooit meer dan de client vroeg.
--  3. GEEN LOSSE TREDEN. `execute_high` zonder `execute`, of wat dan ook zonder
--     `read`, is een stand die de edge function niet kent. Zulke rijen horen niet
--     te kunnen ontstaan, ook niet via een rechtstreekse PostgREST-aanroep — het
--     scherm is geen slot.
--
-- De service-role (de autorisatieserver, die scope en plafond bijwerkt bij het
-- koppelen) blijft erlangs kunnen: die heeft geen auth.uid().
create or replace function public.mcp_grants_guard_client_update()
returns trigger
language plpgsql
as $$
declare
  v_scopes   text[];
  v_ceiling  text[];
  v_unknown  text;
begin
  if auth.uid() is null then return new; end if;

  if new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id
     or new.client_id is distinct from old.client_id
     or new.scope_ceiling is distinct from old.scope_ceiling
     or new.created_at is distinct from old.created_at then
    raise exception 'Vanuit de app is aan een AI-koppeling alleen intrekken, hernoemen en het wijzigen van je eigen rechten toegestaan.'
      using errcode = '42501';
  end if;

  if new.scope is distinct from old.scope then
    -- Regel 1: alleen de eigenaar. Een admin die hier komt, komt via de
    -- overzichtspolicy — en die is er om te stoppen, niet om te verruimen.
    if auth.uid() is distinct from old.user_id then
      raise exception 'Alleen de eigenaar van een AI-koppeling kan wijzigen wat die AI mag. Stoppen kan wel.'
        using errcode = '42501';
    end if;
    -- Een ingetrokken koppeling verruimen zou hem stilletjes weer bruikbaar
    -- laten lijken; de tokens zijn weg, maar de lijst zou iets anders zeggen.
    if old.revoked_at is not null then
      raise exception 'Deze AI-koppeling is ingetrokken; wijzigen kan niet meer.' using errcode = '42501';
    end if;

    v_scopes  := string_to_array(btrim(coalesce(new.scope, '')), ' ');
    v_ceiling := string_to_array(btrim(coalesce(old.scope_ceiling, '')), ' ');

    select s into v_unknown from unnest(v_scopes) as s
     where s not in ('read', 'propose', 'execute', 'execute_high') limit 1;
    if v_unknown is not null then
      raise exception 'Onbekend recht "%" voor een AI-koppeling.', v_unknown using errcode = '22023';
    end if;

    -- Regel 2: binnen het plafond van de client.
    select s into v_unknown from unnest(v_scopes) as s
     where not (s = any(v_ceiling)) limit 1;
    if v_unknown is not null then
      raise exception 'Deze AI-client heeft "%" nooit gevraagd; koppel opnieuw vanuit de AI-app als je dit wilt geven.', v_unknown
        using errcode = '42501';
    end if;

    -- Regel 3: geen losse treden.
    if not ('read' = any(v_scopes)) then
      raise exception 'Een AI-koppeling zonder leesrecht heeft geen betekenis; trek hem in als je hem niet meer wilt.'
        using errcode = '22023';
    end if;
    if 'execute_high' = any(v_scopes) and not ('execute' = any(v_scopes)) then
      raise exception 'Onomkeerbare handelingen rechtstreeks uitvoeren kan alleen als rechtstreeks uitvoeren aan staat.'
        using errcode = '22023';
    end if;
    if 'execute' = any(v_scopes) and not ('propose' = any(v_scopes)) then
      raise exception 'Rechtstreeks uitvoeren valt terug op klaarzetten; dat recht hoort er dan bij.'
        using errcode = '22023';
    end if;
  end if;

  -- Intrekken is definitief; een ingetrokken koppeling komt niet terug.
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'Een ingetrokken koppeling kan niet opnieuw worden geactiveerd. Koppel opnieuw vanuit de AI-app.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists mcp_grants_guard_client_update on public.mcp_grants;
create trigger mcp_grants_guard_client_update
  before update on public.mcp_grants
  for each row execute function public.mcp_grants_guard_client_update();

-- ── 3. Een melding ook als er NIETS meer te keuren valt ─────────────────────
--
-- De push uit 20260917010000 gaat af zodra een gekoppelde AI iets klaarzet:
-- "Claude heeft iets klaargezet". Dat belletje is er omdat een voorstel anders
-- blijft staan zonder dat iemand het ziet.
--
-- Bij een rechtstreekse uitvoering is er niets dat blijft staan — en dat is
-- precies waarom er dan óók een melding hoort te zijn. Nu is het de enige plek
-- waar de gebruiker terugziet dat zijn AI iets in zijn administratie heeft
-- gewijzigd op een moment dat hij misschien in een heel ander gesprek zat. De
-- eerste melding vraagt om een klik; deze vertelt wat er al gebeurd is.
--
-- Hetzelfde push-type ('mcp_proposal'), dus de CHECKs en de voorkeuren blijven
-- ongemoeid: wie het belletje van zijn AI uit heeft gezet, heeft het voor allebei
-- uit staan. Dat is één knop voor één soort melding — van jouw AI, over jouw
-- koppeling.
create or replace function public.push_on_mcp_proposal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_label   text;
  v_title   text;
  v_done    boolean;
begin
  -- Alleen een voorstel of een uitvoering van een KOPPELING. Opvragingen
  -- (executed/failed) en voorstellen van Gerrie zelf (geen mcp_grant_id) horen
  -- hier niet.
  if new.mcp_grant_id is null or new.status not in ('proposed', 'auto_executed') then
    return null;
  end if;
  v_done := new.status = 'auto_executed';

  begin
    select g.user_id, g.label into v_user_id, v_label
      from public.mcp_grants g
     where g.id = new.mcp_grant_id;
    if v_user_id is null then return null; end if;

    v_title := coalesce(nullif(btrim(new.params->>'title'), ''),
                        case when v_done then 'Je AI heeft iets gewijzigd' else 'Een voorstel wacht op je akkoord' end);

    perform public.push_enqueue(
      new.organization_id, 'mcp_proposal',
      array[v_user_id],
      jsonb_build_object(
        'title', coalesce(nullif(btrim(v_label), ''), 'Je AI')
                 || case when v_done then ' heeft iets uitgevoerd' else ' heeft iets klaargezet' end,
        'body',  v_title,
        'url',   '/',
        -- Eén tag per koppeling: drie berichten achter elkaar worden één melding
        -- die zichzelf bijwerkt, geen drie losse pings.
        'tag',   'mcp:' || new.mcp_grant_id::text));
  exception when others then
    -- Een melding die niet wegkomt mag het voorstel of de uitvoering zelf nooit
    -- tegenhouden.
    raise warning 'push_on_mcp_proposal: %', sqlerrm;
  end;
  return null;
end;
$$;

commit;
