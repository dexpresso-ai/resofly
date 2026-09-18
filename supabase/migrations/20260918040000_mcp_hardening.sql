-- ============================================================
-- ResoFly — Hardening van de MCP-connector
-- Date: 2026-09-18
--
-- Uit een review op alles wat deze week gebouwd is. De organisatiegrens zelf
-- houdt stand — een gekoppelde AI komt nergens bij een andere organisatie of
-- een andere gebruiker — maar de aanroeplimiet stelde in de praktijk weinig
-- voor, en het opruimen gebeurde niet.
--
-- 1. De limiet was een lees-wijzig-schrijf in de edge-functie. Honderd
--    parallelle verzoeken lazen allemaal dezelfde teller, lieten allemaal de
--    controle passeren en schreven allemaal 1. Precies het gedrag van een agent
--    die zijn gereedschapsaanroepen naast elkaar doet. Nu één statement met een
--    rijvergrendeling.
-- 2. De teller was via PostgREST te resetten. De UPDATE-policies zijn per rij,
--    niet per kolom, en de guard-trigger keek niet naar calls_in_window /
--    calls_window_start — dus een PATCH met {"calls_in_window": 0} slaagde, en
--    daarmee was het plafond weg.
-- 3. mcp_purge_expired() werd nergens aangeroepen, terwijl de migratie van
--    16 september belooft dat de connector dat zelf doet. Met roterende tokens
--    groeit mcp_tokens anders met duizenden rijen per koppeling per jaar.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Aanroepen afboeken in één statement
-- ------------------------------------------------------------
-- Geeft het nieuwe aantal in het venster terug, of -1 als het plafond bereikt
-- is (dan is er niets afgeboekt). De `for update` serialiseert gelijktijdige
-- aanroepen op dezelfde koppeling; dát is wat de limiet een limiet maakt.
create or replace function public.mcp_consume_rate_limit(
  p_grant_id uuid,
  p_cost integer default 1,
  p_window_seconds integer default 60,
  p_max_calls integer default 120
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_used  integer;
  v_cost  integer := greatest(coalesce(p_cost, 1), 0);
  v_fresh boolean;
begin
  -- Alleen de service-role (de connector) boekt af. Zou een gewone gebruiker
  -- dit mogen aanroepen, dan kon hij zijn eigen venster leegdraaien.
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de connector kan de aanroeplimiet bijwerken.' using errcode = '42501';
  end if;

  if v_cost = 0 then return 0; end if;

  select calls_window_start, calls_in_window
    into v_start, v_used
    from public.mcp_grants
   where id = p_grant_id
   for update;

  if not found then
    raise exception 'Deze AI-koppeling bestaat niet meer.' using errcode = 'P0002';
  end if;

  v_fresh := v_start is null or (now() - v_start) > make_interval(secs => greatest(p_window_seconds, 1));
  if v_fresh then v_used := 0; end if;

  -- Bewust vóór het ophogen: een batch die er niet meer bij past, wordt in zijn
  -- geheel geweigerd in plaats van half uitgevoerd.
  if coalesce(v_used, 0) + v_cost > greatest(p_max_calls, 1) then
    return -1;
  end if;

  update public.mcp_grants
     set calls_window_start = case when v_fresh then now() else calls_window_start end,
         calls_in_window = coalesce(v_used, 0) + v_cost,
         last_used_at = now()
   where id = p_grant_id;

  -- Opruimen "een op de zoveel aanroepen", zoals 20260916000000 het beschrijft
  -- maar nooit aanriep. Eén procent is vaak genoeg om bij te blijven en zeldzaam
  -- genoeg om geen enkele aanroep merkbaar te vertragen.
  if random() < 0.01 then
    perform public.mcp_purge_expired();
  end if;

  return coalesce(v_used, 0) + v_cost;
end;
$$;

comment on function public.mcp_consume_rate_limit(uuid, integer, integer, integer) is
  'Boekt aanroepen af op een MCP-koppeling en geeft het nieuwe aantal terug, of -1 als het plafond bereikt is. Serialiseert op de grant-rij.';

revoke all on function public.mcp_consume_rate_limit(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.mcp_consume_rate_limit(uuid, integer, integer, integer) to service_role;

-- ------------------------------------------------------------
-- 2. De teller is niet van de gebruiker
-- ------------------------------------------------------------
-- De guard liet calls_in_window en calls_window_start ongemoeid, en de
-- UPDATE-policies zijn per rij. Een PATCH op de eigen koppeling kon het venster
-- dus terugzetten naar nul — en een owner/admin kon dat bij een collega doen.
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
     or new.created_at is distinct from old.created_at
     -- De boekhouding van de connector hoort niet aan de gebruiker. De
     -- UPDATE-policies zijn per rij en niet per kolom, dus zonder deze regels
     -- slaagde een PATCH met {"calls_in_window": 0} op je eigen koppeling —
     -- en een owner of admin kon dat bij een collega doen. Daarmee was het
     -- plafond van 120 per minuut met één extra verzoek weg te poetsen.
     or new.calls_in_window is distinct from old.calls_in_window
     or new.calls_window_start is distinct from old.calls_window_start
     or new.last_used_at is distinct from old.last_used_at then
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

commit;
