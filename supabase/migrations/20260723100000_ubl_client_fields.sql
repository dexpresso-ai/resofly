-- ============================================================
-- UBL/Peppol e-facturatie — kopervelden op clients (het "Blok C"-gat).
--
-- NLCIUS/Peppol BIS 3.0 vereist voor de AccountingCustomerParty minimaal het
-- land (BT-55) en voor NL-klanten ook het volledige adres (NL-R-004) en een
-- KVK-/OIN-nummer (NL-R-005). Voor verlegd (AE) en intracommunautair (K) is
-- het btw-nummer van de koper verplicht. De clients-tabel had geen van deze
-- velden; suppliers (de spiegel voor de inkoopkant) heeft ze al sinds
-- 20260618000000 — we kopiëren dat kolommenblok 1-op-1 voor consistentie.
--
-- LET OP: create_client_with_next_code whitelist kolommen expliciet in zijn
-- INSERT. Zonder herdefinitie zouden de nieuwe velden bij het AANMAKEN van een
-- klant stilzwijgend verloren gaan (bewerken loopt via PostgREST en werkt wel).
-- We herdefiniëren de RPC op basis van de NIEUWSTE versie (20260722000000,
-- sectie 13 — mét client_kind) zodat de dunning-fix niet wordt teruggedraaid.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Kopervelden (zelfde namen/types als suppliers).
-- ------------------------------------------------------------
alter table public.clients
  add column if not exists vat_number text,
  add column if not exists kvk_number text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists postal_code text,
  add column if not exists city text,
  add column if not exists country text;

comment on column public.clients.vat_number is 'Btw-nummer van de klant (bv. NL123456789B01) — verplicht voor verlegde/intra-EU e-facturen (UBL categorie AE/K).';
comment on column public.clients.kvk_number is 'KVK- of OIN-nummer — Peppol NL-R-005 vereist dit voor NL-zakelijke kopers (schemeID 0106/0190).';
comment on column public.clients.country is 'Land van de klant (vrije tekst, bv. ''Nederland''); de UBL-generator normaliseert naar ISO 3166-1 alpha-2.';

-- ------------------------------------------------------------
-- 2. create_client_with_next_code opnieuw, mét de nieuwe velden.
--    Basis = 20260722000000 (nieuwste versie, incl. client_kind);
--    toegevoegd: vat_number/kvk_number/adres/land uit de payload.
-- ------------------------------------------------------------
create or replace function public.create_client_with_next_code(p_organization_id uuid, p_payload jsonb default '{}'::jsonb)
returns public.clients
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients;
  v_user_id uuid := auth.uid();
  v_status text := coalesce(nullif(btrim(p_payload ->> 'status'), ''), 'active');
  v_color text := coalesce(nullif(btrim(p_payload ->> 'color'), ''), '#FFD966');
  v_client_kind text := coalesce(nullif(btrim(p_payload ->> 'client_kind'), ''), 'business');
  v_value_eur numeric(12,2) := 0;
  v_tags text[] := '{}';
  v_client_code text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if v_status not in ('active','prospect','inactive') then
    raise exception 'Ongeldige klantstatus.' using errcode = '23514';
  end if;

  if v_client_kind not in ('business','consumer') then
    raise exception 'Ongeldig klanttype.' using errcode = '23514';
  end if;

  if jsonb_typeof(p_payload -> 'tags') = 'array' then
    select coalesce(array_agg(nullif(btrim(value), '')) filter (where nullif(btrim(value), '') is not null), '{}')
      into v_tags
    from jsonb_array_elements_text(p_payload -> 'tags') as tags(value);
  end if;

  if nullif(p_payload ->> 'value_eur', '') is not null then
    v_value_eur := (p_payload ->> 'value_eur')::numeric(12,2);
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('clients_duplicate_guard'));
  v_client_code := public.allocate_next_client_code(p_organization_id);

  perform set_config('resofly.client_code_generated', 'true', true);

  insert into public.clients(
    organization_id,
    created_by,
    name,
    client_code,
    contact_name,
    email,
    phone,
    notes,
    color,
    status,
    client_kind,
    tags,
    value_eur,
    follow_up,
    vat_number,
    kvk_number,
    address_line1,
    address_line2,
    postal_code,
    city,
    country
  ) values (
    p_organization_id,
    v_user_id,
    btrim(coalesce(p_payload ->> 'name', '')),
    v_client_code,
    nullif(btrim(p_payload ->> 'contact_name'), ''),
    nullif(lower(btrim(p_payload ->> 'email')), ''),
    nullif(btrim(p_payload ->> 'phone'), ''),
    nullif(btrim(p_payload ->> 'notes'), ''),
    v_color,
    v_status,
    v_client_kind,
    v_tags,
    v_value_eur,
    nullif(p_payload ->> 'follow_up', '')::date,
    nullif(btrim(p_payload ->> 'vat_number'), ''),
    nullif(btrim(p_payload ->> 'kvk_number'), ''),
    nullif(btrim(p_payload ->> 'address_line1'), ''),
    nullif(btrim(p_payload ->> 'address_line2'), ''),
    nullif(btrim(p_payload ->> 'postal_code'), ''),
    nullif(btrim(p_payload ->> 'city'), ''),
    nullif(btrim(p_payload ->> 'country'), '')
  )
  returning * into v_client;

  return v_client;
end;
$$;

commit;
