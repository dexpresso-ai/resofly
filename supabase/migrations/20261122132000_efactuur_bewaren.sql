-- ════════════════════════════════════════════════════════════════════════════
-- ResoFly — De e-factuur blijft bewaard zoals hij verstuurd is
-- ════════════════════════════════════════════════════════════════════════════
--
-- Controle boekhouder van 22 november 2026, bevinding 2. Van een verstuurde
-- e-factuur (UBL) bewaarden we alleen de bestandsnaam, de grootte en de hash. De
-- XML zelf werd bij elke download opnieuw opgebouwd uit de gegevens van vandaag:
-- na een verhuizing van de klant of een nieuw IBAN was "E-factuur downloaden"
-- een ander document dan de klant kreeg, en voor een gecrediteerde factuur kwam
-- er geen meer. Bij een klant met e-facturatie is de XML de factuur, en een
-- elektronische factuur bewaar je in de vorm waarin je hem verstuurde.
--
-- Nu krijgt elke e-factuur en e-creditnota die ResoFly verstuurt een rij in
-- sent_e_invoices, met het bestand zelf: in R2 (map e-invoices, die de
-- media-worker niet wist of overschrijft) of, zonder R2, in de rij. De rij ligt
-- vast: alleen het moment van versturen wordt er één keer bij gezet.
--
-- Bestaande gegevens: een nieuwe, lege tabel. Van e-facturen die al verstuurd
-- zijn, is het origineel niet terug te halen (er is alleen een hash); daar
-- blijft de download een opnieuw opgebouwd bestand, en het scherm zegt dat erbij.
--
-- Veilig om opnieuw te draaien.

create table if not exists public.sent_e_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  credit_note_id uuid references public.credit_notes(id) on delete cascade,
  delivery_id uuid references public.invoice_email_deliveries(id) on delete cascade,
  doc_type text not null,
  document_number text not null,
  recipient_email text not null,
  file_name text not null,
  mime_type text not null default 'application/xml',
  size_bytes integer not null,
  sha256 text not null,
  storage_provider text not null,
  storage_key text,
  data_base64 text,
  -- Leeg zolang de mail nog niet weg is; mislukt het versturen, dan blijft het leeg.
  sent_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint sent_e_invoices_doc_type_check check (doc_type in ('invoice', 'credit_note')),
  constraint sent_e_invoices_credit_note_check check ((doc_type = 'credit_note') = (credit_note_id is not null)),
  constraint sent_e_invoices_storage_check check (
    (storage_provider = 'r2' and storage_key is not null and data_base64 is null)
    or (storage_provider = 'database' and data_base64 is not null and storage_key is null))
);

create index if not exists idx_sent_e_invoices_invoice on public.sent_e_invoices (organization_id, invoice_id, created_at desc);
create index if not exists idx_sent_e_invoices_credit_note on public.sent_e_invoices (credit_note_id) where credit_note_id is not null;

comment on table public.sent_e_invoices is
  'Elke e-factuur en e-creditnota (UBL) die ResoFly verstuurde, met het bestand zoals het de deur uitging. Onveranderlijk (bewaarplicht); alleen invoice-workflow schrijft hier (20261122132000).';

-- Wat verstuurd is, ligt vast. Ook voor de service-role: de edge function mag
-- een rij klaarzetten en er één keer het verzendmoment bij zetten, meer niet.
create or replace function public.sent_e_invoices_immutable()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    -- Wordt de hele organisatie verwijderd, dan gaat dit mee (cascade).
    if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
      return old;
    end if;
    raise exception 'Een verstuurde e-factuur valt onder de bewaarplicht en kan niet worden verwijderd.' using errcode = '23514';
  end if;
  if (to_jsonb(new) - 'sent_at' - 'created_by') is distinct from (to_jsonb(old) - 'sent_at' - 'created_by')
     or (old.sent_at is not null and new.sent_at is distinct from old.sent_at)
     or (new.created_by is not null and new.created_by is distinct from old.created_by) then
    raise exception 'Een verstuurde e-factuur ligt vast en kan niet worden gewijzigd.' using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function public.sent_e_invoices_immutable() from public, anon, authenticated;

drop trigger if exists sent_e_invoices_immutable on public.sent_e_invoices;
create trigger sent_e_invoices_immutable
  before update or delete on public.sent_e_invoices
  for each row execute function public.sent_e_invoices_immutable();

-- Lezen: leden van de organisatie met Financiën (ook de boekhouder). Schrijven:
-- alleen invoice-workflow met de service-role; er is geen policy voor.
alter table public.sent_e_invoices enable row level security;

drop policy if exists "sent_e_invoices read" on public.sent_e_invoices;
create policy "sent_e_invoices read" on public.sent_e_invoices
  for select using (public.can_read_org(organization_id));

-- Expliciet wat wie mag, los van de standaardrechten van het schema: lezen met
-- de eigen sessie (RLS en de modulepoort beslissen wat), schrijven alleen de
-- service-role.
revoke all on public.sent_e_invoices from public, anon, authenticated, service_role;
grant select on public.sent_e_invoices to authenticated;
grant select, insert, update on public.sent_e_invoices to service_role;

select public.apply_module_gate('sent_e_invoices', 'finance');
