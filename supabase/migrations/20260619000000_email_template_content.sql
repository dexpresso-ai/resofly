-- ResoFly: per-organisatie aanpasbare e-mailteksten.
--
-- Context:
-- De uitgaande e-mails (offerte, factuur, betalingsherinneringen niveau 1-3 en
-- creditfactuur) worden server-side gerenderd door de Edge Functions met een
-- centrale template-registry (_shared/emailTemplates). De tekst stond tot nu toe
-- hardcoded in de templatecode, gelijk voor elke organisatie.
--
-- Deze migratie voegt een per-organisatie tekstlaag toe: onderwerp, aanhef/intro,
-- afsluiting en knoptekst. De structurele inhoud (bedragen, datums, beveiligde
-- link, PDF-bijlage) blijft door de Edge Function bepaald en is bewust NIET
-- aanpasbaar — dat houdt de mails correct en voorkomt HTML-injectie in
-- klantmails. Lege/ontbrekende velden vallen terug op de ingebouwde standaardtekst
-- in de templatecode, dus bestaande organisaties merken niets tot ze zelf iets
-- aanpassen.
--
-- Rechten spiegelen company_settings: lezen mag elk lid (can_read_org), aanpassen
-- alleen owners/admins (can_admin_org). De Edge Functions lezen met de service-
-- role en omzeilen RLS.

begin;

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  -- Eén van de vaste template-sleutels; de Edge Function bepaalt welke sleutel bij
  -- welke verzendactie hoort. Herinneringen hebben een sleutel per niveau zodat de
  -- toon per niveau apart te schrijven is.
  template_key text not null check (template_key in (
    'quote.sent',
    'invoice.sent',
    'invoice.reminder.1',
    'invoice.reminder.2',
    'invoice.reminder.3',
    'creditNote.sent'
  )),
  enabled boolean not null default true,
  subject text,
  intro text,
  closing text,
  cta_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, template_key),
  -- Begrens de veldlengtes zodat een mail nooit ontspoort; ruim genoeg voor copy.
  constraint email_templates_subject_len check (subject is null or char_length(subject) <= 300),
  constraint email_templates_intro_len check (intro is null or char_length(intro) <= 4000),
  constraint email_templates_closing_len check (closing is null or char_length(closing) <= 4000),
  constraint email_templates_cta_label_len check (cta_label is null or char_length(cta_label) <= 120)
);

create index if not exists idx_email_templates_org
  on public.email_templates(organization_id, template_key);

-- updated_at automatisch bijwerken (zelfde helper als company_settings).
drop trigger if exists email_templates_updated on public.email_templates;
create trigger email_templates_updated
  before update on public.email_templates
  for each row execute function public.set_updated_at();

-- organization_id mag na aanmaak niet meer wijzigen.
drop trigger if exists email_templates_prevent_org_change on public.email_templates;
create trigger email_templates_prevent_org_change
  before update of organization_id on public.email_templates
  for each row execute function public.prevent_organization_id_change();

alter table public.email_templates enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'email_templates' and policyname = 'email templates read') then
    create policy "email templates read" on public.email_templates for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'email_templates' and policyname = 'email templates insert') then
    create policy "email templates insert" on public.email_templates for insert with check (public.can_admin_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'email_templates' and policyname = 'email templates update') then
    create policy "email templates update" on public.email_templates for update using (public.can_admin_org(organization_id)) with check (public.can_admin_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'email_templates' and policyname = 'email templates delete') then
    create policy "email templates delete" on public.email_templates for delete using (public.can_admin_org(organization_id));
  end if;
end $$;

commit;
