-- ============================================================
-- ResoFly — Galerij: zes nieuwe coverontwerpen + zelf je cover kiezen
-- Date: 2026-08-18
--
-- Aanleiding:
-- - De openingen dekten wel vier smaken, maar binnen elke smaak was er weinig
--   te kiezen. Er komen zes ontwerpen bij: 'fade' (Basis), 'cutout' en
--   'duotone' (Modern), 'arch' en 'stack' (Klassiek) en 'slideshow'
--   (Spectaculair).
-- - De cover aanwijzen kon alleen met het sterretje in de lightbox: je moest
--   eerst een foto groot openen om te ontdekken dát het kon. De cover is nu
--   een eigen keuze in het venster "Opening", en die keuze is breder:
--     a. een beeld uit de galerij (het bestaande `cover_item_id`), of
--     b. een eigen coverbeeld dat NIET in de galerij zit — een ontworpen
--        titelkaart of een foto die je niet meelevert.
-- - Elke opening snijdt hard bij (21:9, 2:1, een boog). Zonder focuspunt
--   verdwijnt een hoofd net buiten beeld, dus komt de uitsnede erbij.
--
-- Ontwerp:
-- - Het eigen coverbeeld ligt in R2 onder de galerij-prefix
--   `{org}/gallery/{gallery_id}/{uuid}/…`. Dat is bewust: het kijk-token van
--   de galerij dekt precies die prefix, dus het portaal én de publieke
--   deellink kunnen de cover tonen zonder een tweede tokensoort. Een trigger
--   bewaakt dat de key ook echt binnen die prefix valt — anders zou een
--   handmatige update naar de prefix van een andere tenant kunnen wijzen.
-- - Alleen de weergavevarianten (preview + thumb) worden bewaard; het
--   origineel heeft geen doel, want een cover wordt nooit gedownload.
-- - `cover_bytes` telt mee in de opslagmeter. Zonder dat zou een coverbeeld
--   gratis zijn: het hangt niet aan een `gallery_items`-rij, en dáár rekent
--   organization_storage_status de galerij-bytes uit.
--
-- Scope:
-- 1. galleries.hero_template accepteert zes extra waarden.
-- 2. galleries krijgt cover_preview_key/cover_thumb_key/cover_bytes en
--    cover_focus_x/cover_focus_y.
-- 3. Trigger die de coverkey binnen de eigen galerij houdt en losse resten
--    opruimt als de cover wordt weggehaald.
-- 4. organization_storage_status telt cover_bytes mee.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Zes extra openingen
-- ------------------------------------------------------------
alter table public.galleries drop constraint if exists galleries_hero_template_check;
alter table public.galleries
  add constraint galleries_hero_template_check
  check (hero_template in (
    -- Basis
    'full', 'minimal', 'fade',
    -- Modern
    'editorial', 'frame', 'split', 'cutout', 'duotone',
    -- Klassiek
    'classic', 'collage', 'arch', 'stack',
    -- Spectaculair
    'cinematic', 'mosaic', 'slideshow', 'netflix'
  ));

comment on column public.galleries.hero_template is
  'Opening van de galerij. Basis: full/minimal/fade. Modern: editorial/frame/split/cutout/duotone. Klassiek: classic/collage/arch/stack. Spectaculair: cinematic/mosaic/slideshow/netflix. Het coverbeeld is cover_item_id, of — als die gevuld is — cover_preview_key.';

-- ------------------------------------------------------------
-- 2. Eigen coverbeeld + uitsnede
-- ------------------------------------------------------------
alter table public.galleries
  add column if not exists cover_preview_key text,
  add column if not exists cover_thumb_key text,
  add column if not exists cover_bytes bigint not null default 0,
  add column if not exists cover_focus_x smallint not null default 50,
  add column if not exists cover_focus_y smallint not null default 50;

alter table public.galleries drop constraint if exists galleries_cover_bytes_check;
alter table public.galleries
  add constraint galleries_cover_bytes_check check (cover_bytes >= 0);

alter table public.galleries drop constraint if exists galleries_cover_focus_check;
alter table public.galleries
  add constraint galleries_cover_focus_check
  check (cover_focus_x between 0 and 100 and cover_focus_y between 0 and 100);

comment on column public.galleries.cover_preview_key is
  'R2-key van een eigen coverbeeld dat niet in de galerij zit. Ligt onder {org}/gallery/{id}/ zodat het kijk-token van de galerij het dekt. Leeg = de cover komt uit cover_item_id.';
comment on column public.galleries.cover_focus_x is
  'Horizontaal focuspunt van de uitsnede in procenten (0 = links, 100 = rechts). Wordt object-position in de opening.';
comment on column public.galleries.cover_focus_y is
  'Verticaal focuspunt van de uitsnede in procenten (0 = boven, 100 = onder).';

-- ------------------------------------------------------------
-- 3. De coverkey moet binnen de eigen galerij liggen
-- ------------------------------------------------------------
create or replace function public.enforce_gallery_cover_guard()
returns trigger
language plpgsql
as $$
declare
  v_prefix text := new.organization_id::text || '/gallery/' || new.id::text || '/';
begin
  new.cover_preview_key := nullif(btrim(coalesce(new.cover_preview_key, '')), '');
  new.cover_thumb_key := nullif(btrim(coalesce(new.cover_thumb_key, '')), '');

  -- Zonder preview is er geen eigen cover; dan horen de thumb en de bytes ook
  -- weg te vallen, anders blijft er een spookregel in de opslagmeter staan.
  if new.cover_preview_key is null then
    new.cover_thumb_key := null;
    new.cover_bytes := 0;
    return new;
  end if;

  if position(v_prefix in new.cover_preview_key) <> 1
     or (new.cover_thumb_key is not null and position(v_prefix in new.cover_thumb_key) <> 1) then
    raise exception 'Het coverbeeld hoort niet bij deze galerij.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists galleries_cover_guard on public.galleries;
create trigger galleries_cover_guard
  before insert or update of cover_preview_key, cover_thumb_key, cover_bytes
  on public.galleries
  for each row execute function public.enforce_gallery_cover_guard();

-- ------------------------------------------------------------
-- 4. Coverbeelden tellen mee in de opslagmeter
--
-- Ongewijzigd overgenomen uit 20260807000000, op één regel na: de bytes van
-- eigen coverbeelden komen bij de galerij-bytes.
-- ------------------------------------------------------------
create or replace function public.organization_storage_status(p_organization_id uuid)
returns table (
  used_bytes bigint,
  attachments_bytes bigint,
  documents_bytes bigint,
  recordings_bytes bigint,
  gallery_bytes bigint,
  contracts_bytes bigint,
  limit_bytes bigint,
  plan_storage_gb integer,
  storage_addons integer,
  storage_addon_gb integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_attachments bigint := 0;
  v_documents bigint := 0;
  v_recordings bigint := 0;
  v_gallery bigint := 0;
  v_covers bigint := 0;
  v_contracts bigint := 0;
  v_contract_expr text;
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
  v_plan_gb integer;
  v_addon_gb integer;
  v_addons integer := 0;
  v_limit bigint;
  v_family uuid[];
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot het opslagverbruik van deze organisatie.' using errcode = '42501';
  end if;

  -- Eén opslagbundel per abonnement: alle administraties van de klant tellen
  -- samen tegen de limiet van de moeder.
  select array(select public.org_family(p_organization_id)) into v_family;

  select coalesce(sum(a.size_bytes), 0) into v_attachments
  from public.attachments a where a.organization_id = any(v_family);

  select coalesce(sum(coalesce(d.size_bytes, 0)), 0) into v_documents
  from public.documents d where d.organization_id = any(v_family);

  select coalesce(sum(coalesce(mr.size_bytes, 0)), 0) into v_recordings
  from public.meeting_recordings mr where mr.organization_id = any(v_family);

  select coalesce(sum(gi.size_bytes + gi.derived_bytes), 0) into v_gallery
  from public.gallery_items gi where gi.organization_id = any(v_family);

  -- Een eigen coverbeeld hangt niet aan een item, maar staat wél in R2.
  select coalesce(sum(coalesce(g.cover_bytes, 0)), 0) into v_covers
  from public.galleries g where g.organization_id = any(v_family);
  v_gallery := v_gallery + v_covers;

  -- Contracten staan óók in R2 (office-.docx + getekende PDF) maar hebben geen
  -- attachments-rij. De kolommen komen uit andere migraties en kunnen per
  -- omgeving nog ontbreken, dus dynamisch samenstellen i.p.v. hard verwijzen.
  select nullif(concat_ws(' + ',
    case when exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'contracts' and column_name = 'body_size_bytes')
      then 'coalesce(c.body_size_bytes, 0)' end,
    case when exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'contracts' and column_name = 'signed_pdf_size_bytes')
      then 'coalesce(c.signed_pdf_size_bytes, 0)' end
  ), '') into v_contract_expr;

  if v_contract_expr is not null then
    execute format('select coalesce(sum(%s), 0)::bigint from public.contracts c where c.organization_id = any($1)', v_contract_expr)
      into v_contracts using v_family;
  end if;

  select * into v_profile
  from public.organization_billing_profiles p
  where p.organization_id = public.billing_root_organization(p_organization_id);

  if found and not v_profile.billing_exempt then
    select * into v_plan from public.billing_plans bp where bp.plan_key = v_profile.plan_key;
    if found and (v_plan.limits ? 'storage_gb') then
      v_plan_gb := nullif(v_plan.limits->>'storage_gb', '')::integer;
      v_addon_gb := coalesce(nullif(v_plan.limits->>'storage_addon_gb', '')::integer, 100);
      v_addons := coalesce(v_profile.storage_addons, 0);
      if v_plan_gb is not null then
        v_limit := (v_plan_gb::bigint + v_addons::bigint * v_addon_gb::bigint) * 1073741824;
      end if;
    end if;
  end if;

  return query select
    (v_attachments + v_documents + v_recordings + v_gallery + v_contracts),
    v_attachments,
    v_documents,
    v_recordings,
    v_gallery,
    v_contracts,
    v_limit,
    v_plan_gb,
    v_addons,
    v_addon_gb;
end;
$$;

revoke all on function public.organization_storage_status(uuid) from public;
grant execute on function public.organization_storage_status(uuid) to authenticated, service_role;

commit;
