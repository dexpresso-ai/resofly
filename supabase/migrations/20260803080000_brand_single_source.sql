-- ============================================================
-- ResoFly — Eén merk: kleur, logo en lettertype op één plek
-- Date: 2026-08-03
--
-- Aanleiding:
-- - De accentkleur stond op twee plekken: `invoice_accent_color` (al in
--   gebruik door facturen, offertes, contracten én alle e-mailsjablonen) en
--   het nieuwere `brand_accent_color` van de galerij. Twee velden voor één
--   merk levert onvermijdelijk verschillen op.
--
-- Ontwerp:
-- - `brand_accent_color` wordt de ENIGE bewerkplek (Instellingen → Huisstijl).
-- - `invoice_accent_color` blijft bestaan als afgeleide waarde en wordt door
--   een trigger gelijkgehouden. Zo hoeven de negentien plekken die er al op
--   lezen (PDF-opbouw, edge functions, e-mailsjablonen) niet aangepast te
--   worden en kan er geen enkele consument achterblijven.
-- - Eerst backfillen: wie al een factuurkleur had ingesteld behoudt die als
--   merkkleur, in plaats van terug te vallen op het standaardgoud.
-- ============================================================

begin;

-- 1) Bestaande factuurkleur wint: die was tot nu toe de echte merkkleur.
update public.company_settings
set brand_accent_color = invoice_accent_color
where brand_accent_color = '#FFD966'
  and invoice_accent_color is not null
  and invoice_accent_color <> '#FFD966'
  and invoice_accent_color ~ '^#[0-9A-Fa-f]{6}$';

-- 2) Vanaf nu volgt de factuurkleur de merkkleur, wat de schrijver ook meestuurt.
create or replace function public.sync_invoice_accent_from_brand()
returns trigger
language plpgsql
as $$
begin
  if new.brand_accent_color is not null and new.brand_accent_color ~ '^#[0-9A-Fa-f]{6}$' then
    new.invoice_accent_color := new.brand_accent_color;
  end if;
  return new;
end;
$$;

drop trigger if exists company_settings_sync_brand_accent on public.company_settings;
create trigger company_settings_sync_brand_accent
  before insert or update of brand_accent_color, invoice_accent_color
  on public.company_settings
  for each row execute function public.sync_invoice_accent_from_brand();

comment on column public.company_settings.invoice_accent_color is
  'AFGELEID van brand_accent_color (trigger company_settings_sync_brand_accent). Niet los bewerken; de merkkleur staat in Instellingen → Huisstijl.';
comment on column public.company_settings.brand_accent_color is
  'De merkkleur van de organisatie: galerij, facturen, offertes, contracten en e-mails.';

commit;
