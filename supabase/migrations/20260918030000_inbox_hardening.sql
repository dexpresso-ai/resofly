-- ============================================================
-- ResoFly — Hardening van de factuur-inbox
-- Date: 2026-09-18
--
-- Drie dingen die uit een review op de factuur-inbox kwamen. Alle drie zijn
-- vooruit-repareerbaar: deze migratie draait ook als 20260918010000 al gedraaid
-- heeft, en ook als dat nog niet zo is.
--
-- 1. Twee facturen die tegelijk binnenkomen konden HETZELFDE interne nummer
--    krijgen. `next_purchase_invoice_number` deed `max(...) + 1` zonder enige
--    serialisatie, en `internal_number` had geen unieke index. Twee mails in
--    dezelfde seconde — en mail-inbound start de verwerking in de achtergrond,
--    dus dat gebeurt — leverden twee keer 'INK-2026-0042' op. De
--    bankafletteraar matcht op internal_number en koppelt dan de verkeerde
--    betaling aan de verkeerde factuur.
--
-- 2. De gereserveerde-slug-controle wees alleen de slug 'facturen' exact af.
--    Een organisatie met slug 'facturen-bv' kreeg een gewoon mailadres dat de
--    Email Worker als FACTUURADRES leest (hij kijkt naar `facturen-`), en die
--    propt dan van élke klantmail de bijlagen base64 in de payload.
--
-- 3. `purchase_invoices.internal_number` krijgt een unieke index als backstop.
--    Voorzichtig: bestaan er al dubbelen (handmatig ingevoerd), dan zou een
--    harde CREATE UNIQUE INDEX deze deploy laten klappen. Daarom eerst tellen
--    en anders een duidelijke melding — een deploy die vastloopt op andermans
--    boekhouding helpt niemand.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Een nummerreeks die niet kan botsen
-- ------------------------------------------------------------
-- Zelfde vorm als organization_client_number_sequences (migratie 20260520000000):
-- één rij per reeks, `select … for update` serialiseert de uitgifte, en het
-- volgnummer wordt in dezelfde transactie opgehoogd. Daardoor krijgt een
-- tweede aanvrager gegarandeerd een ander nummer, óók als hij een milliseconde
-- later binnenkomt.
--
-- Per (organisatie, jaar), want het nummer bevat het jaar: INK-2026-0001.
create table if not exists public.organization_purchase_invoice_number_sequences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  year integer not null check (year between 2000 and 2100),
  next_number integer not null default 1 check (next_number > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, year)
);

comment on table public.organization_purchase_invoice_number_sequences is
  'Volgnummer per organisatie en jaar voor interne inkoopfactuurnummers (INK-JJJJ-NNNN). Uitgifte serialiseert op deze rij.';

alter table public.organization_purchase_invoice_number_sequences enable row level security;

-- Lezen mag een org-beheerder (zelfde lijn als de klantnummerreeks); schrijven
-- gebeurt uitsluitend in de security-definer-functie hieronder.
drop policy if exists "purchase invoice number sequences read" on public.organization_purchase_invoice_number_sequences;
create policy "purchase invoice number sequences read"
  on public.organization_purchase_invoice_number_sequences
  for select using (public.can_admin_org(organization_id));

drop trigger if exists purchase_invoice_number_sequences_updated on public.organization_purchase_invoice_number_sequences;
create trigger purchase_invoice_number_sequences_updated
  before update on public.organization_purchase_invoice_number_sequences
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 2. De uitgifte zelf
-- ------------------------------------------------------------
-- `volatile` (was `stable`): deze functie schrijft nu. Dat is geen detail —
-- een `stable` functie mag door de planner in dezelfde transactie hergebruikt
-- worden en mag niet schrijven.
create or replace function public.next_purchase_invoice_number(p_organization_id uuid, p_date date default current_date)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_year    integer := extract(year from coalesce(p_date, current_date))::integer;
  v_prefix  text    := 'INK-' || v_year::text || '-';
  v_seen    integer;
  v_number  integer;
  v_code    text;
begin
  if auth.role() is distinct from 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  -- Reeks aanmaken als hij nog niet bestaat, en meteen bijtrekken tot voorbij
  -- wat er al aan facturen ligt. Dat laatste is nodig voor bestaande
  -- administraties én voor nummers die met de hand zijn ingevoerd.
  insert into public.organization_purchase_invoice_number_sequences (organization_id, year, next_number)
  values (p_organization_id, v_year, 1)
  on conflict (organization_id, year) do nothing;

  -- FOR UPDATE: vanaf hier wacht een gelijktijdige tweede aanvrager tot deze
  -- transactie klaar is. Dát is wat de botsing onmogelijk maakt.
  select next_number into v_number
    from public.organization_purchase_invoice_number_sequences
   where organization_id = p_organization_id and year = v_year
   for update;

  select coalesce(max((regexp_match(substr(pi.internal_number, length(v_prefix) + 1), '^\d+'))[1]::integer), 0)
    into v_seen
    from public.purchase_invoices pi
   where pi.organization_id = p_organization_id
     and pi.internal_number like v_prefix || '%';

  v_number := greatest(coalesce(v_number, 1), coalesce(v_seen, 0) + 1);
  v_code := v_prefix || lpad(v_number::text, 4, '0');

  -- Vangnet voor een nummer dat toch al bezet is (handmatig ingevoerd met een
  -- afwijkend patroon, of een hersteloperatie): doorschuiven tot het vrij is.
  -- Zelfde lus als in de klantnummergenerator.
  while exists (
    select 1 from public.purchase_invoices pi
     where pi.organization_id = p_organization_id
       and pi.internal_number = v_code
  ) loop
    v_number := v_number + 1;
    v_code := v_prefix || lpad(v_number::text, 4, '0');
  end loop;

  update public.organization_purchase_invoice_number_sequences
     set next_number = v_number + 1
   where organization_id = p_organization_id and year = v_year;

  return v_code;
end;
$$;

comment on function public.next_purchase_invoice_number(uuid, date) is
  'Geeft het volgende interne inkoopfactuurnummer uit. Serialiseert op de reeksrij (for update), zodat twee gelijktijdige aanvragen nooit hetzelfde nummer krijgen.';

revoke all on function public.next_purchase_invoice_number(uuid, date) from public, anon;
grant execute on function public.next_purchase_invoice_number(uuid, date) to authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Backstop: hetzelfde nummer kan niet twee keer bestaan
-- ------------------------------------------------------------
-- Alleen aanleggen als er nu geen dubbelen zijn. Zijn die er wel, dan is dat
-- bestaande boekhouding die iemand moet nalopen — daar mag een deploy niet
-- eigenmachtig in snijden, en hij mag er ook niet op stuklopen.
do $$
declare
  v_duplicates integer;
begin
  select count(*) into v_duplicates
    from (
      select organization_id, internal_number
        from public.purchase_invoices
       where internal_number is not null and btrim(internal_number) <> ''
       group by organization_id, internal_number
      having count(*) > 1
    ) d;

  if v_duplicates = 0 then
    create unique index if not exists uidx_purchase_invoices_org_internal_number
      on public.purchase_invoices (organization_id, internal_number)
      where internal_number is not null and btrim(internal_number) <> '';
  else
    raise notice
      'Unieke index op purchase_invoices.internal_number NIET aangelegd: er zijn % nummers die meer dan één keer voorkomen. Loop die na en draai daarna: create unique index uidx_purchase_invoices_org_internal_number on public.purchase_invoices (organization_id, internal_number) where internal_number is not null and btrim(internal_number) <> '''';',
      v_duplicates;
  end if;
end $$;

-- ------------------------------------------------------------
-- 4. Een slug die met "facturen" begint is ook gereserveerd
-- ------------------------------------------------------------
-- De Email Worker beslist puur op het voorvoegsel `facturen-` of hij de
-- bijlagen moet meesturen. Een organisatie met slug 'facturen-bv' kreeg
-- daardoor een gewoon doorstuuradres dat als factuuradres gelezen werd.
create or replace function public.generate_inbound_alias_local_part(p_organization_id uuid, p_prefix text default null)
returns text language plpgsql volatile set search_path = public, extensions as $$
declare
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  v_reserved constant text[] := array['reply','organizer','postmaster','abuse','noreply','mailer-daemon','in','facturen'];
  v_prefix text := nullif(lower(regexp_replace(coalesce(p_prefix, ''), '[^a-zA-Z0-9]+', '', 'g')), '');
  v_max_slug integer := 23 - coalesce(length(v_prefix) + 1, 0);
  v_slug text;
  v_rand text := '';
  v_bytes bytea;
  i integer;
begin
  select lower(regexp_replace(coalesce(o.slug, ''), '[^a-zA-Z0-9]+', '-', 'g'))
    into v_slug
    from public.organizations o
   where o.id = p_organization_id;

  v_slug := btrim(coalesce(nullif(v_slug, ''), 'resofly'), '-');
  v_slug := btrim(left(v_slug, v_max_slug), '-');

  -- Niet alleen een exacte treffer op de gereserveerde lijst, maar ook élke
  -- slug die met 'facturen' begint: 'facturen-bv' zou anders het adres
  -- facturen-bv-<16> opleveren, en dat leest de Worker als factuuradres.
  if v_slug = '' or v_slug = any(v_reserved) or v_slug like 'facturen%' then
    v_slug := left('resofly', v_max_slug);
  end if;

  v_bytes := gen_random_bytes(16);
  for i in 0..15 loop
    v_rand := v_rand || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;

  return coalesce(v_prefix || '-', '') || v_slug || '-' || v_rand;
end; $$;

commit;
