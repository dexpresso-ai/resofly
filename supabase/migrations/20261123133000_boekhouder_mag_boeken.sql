-- ════════════════════════════════════════════════════════════════════════════
-- ResoFly — De boekhouder mag boeken (als de eigenaar dat aanzet)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Controle boekhouder van 22 november 2026, bevinding 6. De boekhouder (het
-- gratis gastaccount, 20261011000000) kon alleen lezen. Een memoriaal, de
-- btw-aangifte afsluiten, een boekjaar heropenen, het profiel voor de aangifte
-- inkomstenbelasting: alles gaf 403. Een zzp'er laat zijn aangifte juist door
-- een boekhouder doen omdat die de correcties maakt. Nu moest de boekhouder
-- elke boeking dicteren, of de zzp'er maakte hem teamlid met Financiën bewerken:
-- een betaalde licentie, en standaard ook toegang tot de andere modules.
--
-- De keuze: de eigenaar of een beheerder kan per boekhouder "mag boeken"
-- aanzetten. De boekhouder corrigeert en sluit af; de dagelijkse administratie
-- blijft van de ondernemer.
--
--   Wel:  memoriaal en tegenboeken, de beginbalans, vooruitbetaalde kosten
--         (overlopende posten), afschrijvingen boeken, de btw-aangifte afsluiten,
--         op ingediend/betaald zetten en een suppletie maken, boekjaren openen,
--         afsluiten en heropenen (met de resultaatbestemming), en het profiel, de correcties en de
--         KIA-uitsluitingen voor de aangifte inkomstenbelasting.
--   Niet: offertes, facturen en creditnota's (die gaan naar een klant),
--         inkoopfacturen en de bank (de dagelijkse administratie), betalingen
--         en Mollie, klanten, het team, instellingen, bestanden, en het
--         rekeningschema en de btw-codes.
--
-- Hoe, en waarom zo. De vaste regel per module blijft wat hij was: de boekhouder
-- heeft Financiën "lezen" (member_module_level, en de spiegels in roles.ts,
-- permissions.ts en de media-worker). Was dat "bewerken" geworden, dan ging
-- alles open dat alleen naar de module kijkt: tabellen via REST, edge functions
-- en de worker. In plaats daarvan staat hier één lijst van functies. Alleen
-- terwijl de boekhouder zo'n functie zelf aanroept (hij is het beginpunt van de
-- aanroep), zeggen can_write_org en can_write_module('finance') ja. Rechtstreeks
-- schrijven via REST, elke andere functie en elke edge function blijven dicht.
-- De functies zelf (finalize_vat_return, close_fiscal_year, …) veranderen niet.
--
-- Bestaande gegevens: één kolom erbij op organization_members, standaard uit.
-- Gaat een boekhouder weg of wordt hij teamlid, dan gaat de stand vanzelf uit.
-- Voor bestaande boekhouders verandert er niets tot iemand het aanzet. Voor
-- alle andere rollen geven de drie rechtenfuncties hetzelfde antwoord als
-- voorheen.
--
-- Veilig om opnieuw te draaien.

-- ── 1. De stand "mag boeken" ────────────────────────────────────────────────

alter table public.organization_members
  add column if not exists accountant_can_book boolean not null default false;

comment on column public.organization_members.accountant_can_book is
  'Alleen bij de rol accountant: mag deze boekhouder boeken en afsluiten (memoriaal, btw-aangifte, boekjaar, IB)? Zet je met set_accountant_booking (20261123133000).';

alter table public.organization_members drop constraint if exists organization_members_accountant_can_book_check;
alter table public.organization_members add constraint organization_members_accountant_can_book_check
  check (not accountant_can_book or role = 'accountant');

-- Alleen een eigenaar of beheerder zet het aan of uit. De update-policy laat
-- alleen eigenaren aan de ledentabel komen; deze trigger houdt het ook dicht
-- voor elke latere weg.
--
-- Is iemand geen actieve boekhouder meer (toegang ingetrokken, of opnieuw
-- uitgenodigd als teamlid), dan gaat "mag boeken" vanzelf uit. Eerst bleef het
-- staan: accept_organization_invitation zet bij een nieuwe uitnodiging de rol
-- om, en dan weigerde de check hierboven en lukte het accepteren niet. En een
-- boekhouder die later opnieuw werd uitgenodigd, mocht meteen weer boeken
-- zonder dat de eigenaar dat opnieuw had gekozen.
create or replace function public.organization_members_accountant_booking_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.role is distinct from 'accountant' or new.status is distinct from 'active' then
    new.accountant_can_book := false;
    return new;
  end if;
  if new.accountant_can_book is distinct from old.accountant_can_book
     and auth.uid() is not null
     and not public.user_has_org_role(new.organization_id, array['owner', 'admin']) then
    raise exception 'Alleen een eigenaar of beheerder bepaalt of de boekhouder mag boeken.' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function public.organization_members_accountant_booking_guard() from public, anon, authenticated;

drop trigger if exists organization_members_accountant_booking_guard on public.organization_members;
create trigger organization_members_accountant_booking_guard
  before update of accountant_can_book, role, status on public.organization_members
  for each row execute function public.organization_members_accountant_booking_guard();

create or replace function public.set_accountant_booking(p_member_id uuid, p_enabled boolean)
returns public.organization_members
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_member public.organization_members;
begin
  if auth.uid() is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;
  select * into v_member from public.organization_members where id = p_member_id for update;
  if not found then
    raise exception 'Boekhouder niet gevonden' using errcode = 'P0002';
  end if;
  if not public.user_has_org_role(v_member.organization_id, array['owner', 'admin']) then
    raise exception 'Alleen een eigenaar of beheerder bepaalt of de boekhouder mag boeken.' using errcode = '42501';
  end if;
  if v_member.role <> 'accountant' then
    raise exception 'Dit is geen boekhouder. De rechten van een teamlid stel je in bij Rechten.' using errcode = '23514';
  end if;
  update public.organization_members
  set accountant_can_book = coalesce(p_enabled, false), updated_at = now()
  where id = p_member_id
  returning * into v_member;
  return v_member;
end;
$function$;

revoke all on function public.set_accountant_booking(uuid, boolean) from public, anon;
grant execute on function public.set_accountant_booking(uuid, boolean) to authenticated, service_role;

-- ── 2. Eén lijst: wat de boekhouder mag aanroepen ───────────────────────────
--
-- Waar: de ingelogde gebruiker is een actieve boekhouder van deze organisatie
-- met "mag boeken", én de aanroep is begonnen bij een functie uit de lijst.
-- Het beginpunt staat onderaan de aanroepstapel (PG_CONTEXT). Bewust het
-- beginpunt en niet "ergens in de stapel": een andere functie die onderweg
-- post_journal_entry aanroept, wordt daar niet ineens mee toegestaan.
--
-- p_admin: de lijst voor wat anders alleen een eigenaar of beheerder mag
-- (can_admin_org). Daar staat alleen het heropenen van een boekjaar in.
create or replace function public.accountant_booking_context(p_organization_id uuid, p_admin boolean default false)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
cost 1000
as $function$
declare
  v_context text;
  v_lines text[];
  v_entry text;
  v_allowed text := case when p_admin then
      -- Een boekjaar met een resultaatbestemming (bv, vof) heropen je pas als
      -- die bestemming is teruggedraaid: zonder die tweede kon de boekhouder
      -- zo'n boekjaar niet heropenen.
      'reopen_fiscal_year|reverse_result_appropriation'
    else
      -- Grootboek
      'post_journal_entry|reverse_journal_entry|create_opening_balance'
      -- Vooruitbetaalde kosten (overlopende posten)
      || '|save_prepaid_expense|delete_prepaid_expense|book_prepaid_expense_start|post_prepaid_releases|end_prepaid_expense'
      -- Afschrijvingen
      || '|generate_depreciation_schedule|post_asset_depreciation'
      -- Btw-aangifte
      || '|finalize_vat_return|close_vat_period|create_vat_supplement|set_vat_return_status'
      -- Boekjaren
      || '|open_fiscal_year|open_initial_fiscal_years|close_fiscal_year|reopen_fiscal_year|delete_open_fiscal_year'
      -- Het resultaat van een afgesloten boekjaar bestemmen hoort bij het
      -- afsluiten; het scherm toonde de knoppen al en de database weigerde.
      || '|appropriate_result|reverse_result_appropriation'
      -- Aangifte inkomstenbelasting
      || '|save_income_tax_profile|add_income_tax_correction|delete_income_tax_correction|set_income_tax_kia_exclusion'
    end;
begin
  if auth.uid() is null or p_organization_id is null then
    return false;
  end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = 'accountant'
      and m.accountant_can_book
  ) then
    return false;
  end if;
  get diagnostics v_context = pg_context;
  v_lines := regexp_split_to_array(v_context, E'\n');
  v_entry := v_lines[array_upper(v_lines, 1)];
  return v_entry ~ ('^PL/pgSQL function (public\.)?(' || v_allowed || ')\(');
end;
$function$;

revoke all on function public.accountant_booking_context(uuid, boolean) from public, anon;
grant execute on function public.accountant_booking_context(uuid, boolean) to authenticated, service_role;

-- De drie rechtenfuncties, met de boekhouder erbij. Basis: 20260427000000
-- (can_write_org, can_admin_org) en 20260730100000 (can_write_module). Voor
-- een eigenaar, beheerder of teamlid is het eerste deel al waar en komt het
-- tweede niet aan bod.
create or replace function public.can_write_org(p_organization_id uuid)
returns boolean
language sql
stable
as $function$
  select public.user_has_org_role(p_organization_id, array['owner','admin','member'])
      or public.accountant_booking_context(p_organization_id, false);
$function$;

create or replace function public.can_admin_org(p_organization_id uuid)
returns boolean
language sql
stable
as $function$
  select public.user_has_org_role(p_organization_id, array['owner','admin'])
      or public.accountant_booking_context(p_organization_id, true);
$function$;

create or replace function public.can_write_module(p_organization_id uuid, p_module text)
returns boolean
language sql
stable
as $function$
  select coalesce(public.org_module_level(p_organization_id, p_module), 'none') = 'write'
      or (p_module = 'finance' and public.accountant_booking_context(p_organization_id, false));
$function$;

revoke all on function public.can_write_org(uuid) from public, anon;
grant execute on function public.can_write_org(uuid) to authenticated, service_role;
revoke all on function public.can_admin_org(uuid) from public, anon;
grant execute on function public.can_admin_org(uuid) to authenticated, service_role;
revoke all on function public.can_write_module(uuid, text) from public, anon;
grant execute on function public.can_write_module(uuid, text) to authenticated, service_role;

-- ── 3. De status van een btw-aangifte, als functie ──────────────────────────
-- "Ingediend" en "betaald" zette de app met een PATCH op vat_returns. Dat is
-- rechtstreeks schrijven, en dat blijft voor de boekhouder dicht. Dezelfde
-- overgangen als guard_vat_return_client_update toestaat.
create or replace function public.set_vat_return_status(p_organization_id uuid, p_vat_return_id uuid, p_status text)
returns public.vat_returns
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_return public.vat_returns;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  select * into v_return from public.vat_returns
  where id = p_vat_return_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Btw-aangifte niet gevonden.' using errcode = '02000';
  end if;
  if not ((v_return.status = 'finalized' and p_status = 'filed')
       or (v_return.status = 'filed' and p_status = 'paid')) then
    raise exception 'Deze statuswijziging van de btw-aangifte is niet toegestaan.' using errcode = '23514';
  end if;
  update public.vat_returns set status = p_status, updated_at = now()
  where id = v_return.id
  returning * into v_return;
  return v_return;
end;
$function$;

revoke all on function public.set_vat_return_status(uuid, uuid, text) from public, anon;
grant execute on function public.set_vat_return_status(uuid, uuid, text) to authenticated, service_role;
