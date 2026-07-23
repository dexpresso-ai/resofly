-- ============================================================
-- ResoFly — Contract e-signing: onveranderlijkheid + resterende hardening
-- Date: 2026-07-23
--
-- Volgt op de review van 2026-07-22 (contract-feature-roadmap). Dicht vier gaten
-- die de tamper-evidence van de digitale ondertekening ondermijnden. Alles
-- spiegelt het bestaande service-role-patroon (auth.role() = 'service_role') uit
-- de offerte-flow (20260515000002_quote_approval_resend_flow_hardening).
--
--  1. HOOG — een getekend contract was op rij-niveau NIET bevroren. De
--     `contracts update`-RLS-policy laat elke org-writer élke kolom muteren in
--     élke status, en de statusguard bewaakt alléén `status`. Daardoor waren na
--     ondertekening zowel de inhoud (body/bedrag/…) als de bewijskolommen
--     (signed_document_sha256/signed_storage_key/signed_pdf_*) vrij overschrijf-
--     of wisbaar via een directe PostgREST-PATCH. Een e-sign-bewijs hoort
--     onveranderlijk te zijn.
--  2. MIDDEL — de status 'signed'/'declined' was intern te forceren: de guard
--     staat sent→signed toe, dus een org-writer kon een contract rechtstreeks op
--     'signed' zetten zonder dat de klant ooit de ondertekenpagina bezocht.
--  3. MIDDEL — `contract_signers` had een brede for-all-schrijfpolicy waardoor
--     ondertekenbewijs-rijen (methode/IP/consent) intern te vervalsen waren,
--     terwijl de app die tabel alléén leest.
--  4. MIDDEL — de hardening-ronde (20260710120000) miste
--     `allocate_next_contract_number(uuid)`: nog `grant to authenticated` +
--     SECURITY DEFINER, dus elke ingelogde kon met een vreemde org-UUID de
--     contractteller van een andere organisatie ophogen (cross-tenant write +
--     info-lek).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Onveranderlijkheid + anti-forge op public.contracts (rij-/kolomniveau).
--    Aanvullend op de RLS-policy: de policy bepaalt WELKE rijen een writer mag
--    aanraken, deze trigger bepaalt WELKE kolommen in WELKE status nog mogen
--    wijzigen. Mail-lifecycle-kolommen (last_email_*) blijven vrij, zodat
--    Resend-webhooks een getekend contract nog mogen bijwerken.
-- ------------------------------------------------------------
create or replace function public.enforce_contract_signed_immutability()
returns trigger
language plpgsql
as $$
begin
  if TG_OP <> 'UPDATE' then return new; end if;

  -- (a) Anti-forge: op 'signed'/'declined' zetten mag UITSLUITEND vanuit de
  --     service-role (de publieke sign_/decline_contract_public-RPC's). Een
  --     directe UPDATE door een ingelogde medewerker (auth.role='authenticated')
  --     kan de ondertekening dus niet vervalsen. void/expired blijven toegestaan.
  if new.status is distinct from old.status
     and new.status in ('signed','declined')
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Een contract kan alleen via de publieke ondertekenflow op "%" worden gezet.', new.status
      using errcode = '42501';
  end if;

  -- (b) Ondertekenbewijs is uitsluitend door de service-role te zetten
  --     (attach_signed_contract_pdf). Een org-writer kan de hash/opslagverwijzing
  --     naar het getekende PDF niet overschrijven of wissen. Omdat de kolommen bij
  --     een nog-niet-gekoppeld PDF null zijn, houdt dit een latere (service-role)
  --     hergeneratie mogelijk zonder het bewijs manipuleerbaar te maken.
  if coalesce(auth.role(), '') <> 'service_role' then
    if new.signed_document_sha256 is distinct from old.signed_document_sha256
       or new.signed_storage_provider is distinct from old.signed_storage_provider
       or new.signed_storage_key is distinct from old.signed_storage_key
       or new.signed_pdf_file_name is distinct from old.signed_pdf_file_name
       or new.signed_pdf_size_bytes is distinct from old.signed_pdf_size_bytes
       or new.signed_pdf_data_base64 is distinct from old.signed_pdf_data_base64
       or new.signed_at is distinct from old.signed_at then
      raise exception 'Het ondertekenbewijs van een contract kan niet worden gewijzigd.'
        using errcode = '42501';
    end if;
  end if;

  -- (c) Inhoud is definitief zodra het contract getekend of ingetrokken is — voor
  --     iedereen, óók de service-role: een getekend/ingetrokken exemplaar is
  --     onveranderlijk. (Vóór ondertekening, in draft/sent, blijft corrigeren wél
  --     mogelijk.)
  if old.status in ('signed','voided') then
    if new.title is distinct from old.title
       or new.body is distinct from old.body
       or new.amount_cents is distinct from old.amount_cents
       or new.currency is distinct from old.currency
       or new.date is distinct from old.date
       or new.valid_until is distinct from old.valid_until then
      raise exception 'Een getekend of ingetrokken contract kan inhoudelijk niet meer worden gewijzigd.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists contracts_signed_immutability_guard on public.contracts;
create trigger contracts_signed_immutability_guard
  before update on public.contracts
  for each row execute function public.enforce_contract_signed_immutability();

-- ------------------------------------------------------------
-- 2. contract_signers: schrijven loopt uitsluitend via de security-definer RPC's
--    (begin_/sign_/decline_contract_public, die als service-role de RLS omzeilen).
--    De app leest alleen (Contracts.tsx: .select). De brede for-all-policy liet
--    interne writers ondertekenbewijs-rijen vervalsen — die verwijderen we; de
--    read-policy blijft staan.
-- ------------------------------------------------------------
drop policy if exists "contract signers write" on public.contract_signers;

-- ------------------------------------------------------------
-- 3. allocate_next_contract_number: service-role-only (gemist in 20260710120000).
--    De nummer-trigger contracts_set_number() draait SECURITY DEFINER en roept
--    deze functie in definer-context aan, dus automatische nummering blijft werken;
--    alleen de directe PostgREST-route voor anon/authenticated verdwijnt.
-- ------------------------------------------------------------
revoke execute on function public.allocate_next_contract_number(uuid) from public, anon, authenticated;
grant execute on function public.allocate_next_contract_number(uuid) to service_role;

commit;
