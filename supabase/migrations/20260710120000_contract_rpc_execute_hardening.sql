begin;

-- ============================================================
-- Beveiligingsfix: ontbrekende REVOKE op contract-workflow-RPC's (+ 2 helpers).
--
-- In PostgreSQL krijgt PUBLIC standaard EXECUTE op een nieuwe functie, en
-- `grant ... to service_role` verwijdert die default NIET. De contract-migraties
-- (20260622000000_contracts_e_signing.sql / 20260622000003_contract_editor_templates.sql)
-- granten onderstaande SECURITY DEFINER-functies alleen aan service_role, maar
-- zónder voorafgaande REVOKE. Daardoor bleven ze aanroepbaar door anon +
-- authenticated via PostgREST (/rest/v1/rpc/...) met de publieke anon-key uit de
-- frontend-bundle. Omdat deze functies het org-lidmaatschap niet verifiëren
-- (alleen `where id = p_contract_id and organization_id = p_organization_id`),
-- kon een aanvaller met een bekend contract_id o.a.:
--   * via begin_contract_signature_send een zelfgekozen public_token_hash zetten
--     en vervolgens sign_contract_public aanroepen -> een ONDERTEKENING VERVALSEN;
--   * via attach_signed_contract_pdf het getekende PDF-bewijs OVERSCHRIJVEN;
--   * timeline-/auditregels vervalsen (insert_contract_event) of verzendstatus
--     manipuleren (complete_/fail_contract_signature_send, snapshot_contract_version).
--
-- Deze migratie spiegelt exact het (correcte) revoke-patroon van de offerte-/
-- factuur-RPC's (zie 20260527000001_finance_core_production_hardening.sql). De
-- frontend roept geen van deze functies direct aan; interne aanroepen lopen via
-- andere SECURITY DEFINER-functies (definer-context) en blijven dus werken.
-- ============================================================

-- H1 — contract-workflow-RPC's: alleen service_role mag ze aanroepen.
revoke execute on function public.begin_contract_signature_send(uuid, uuid, uuid, text, timestamptz, text, text, text) from public, anon, authenticated;
revoke execute on function public.complete_contract_signature_send(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.fail_contract_signature_send(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.attach_signed_contract_pdf(uuid, uuid, text, text, text, text, bigint, text) from public, anon, authenticated;
revoke execute on function public.sign_contract_public(text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.decline_contract_public(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.ask_contract_question_public(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.snapshot_contract_version(uuid, uuid, text, text, text, bigint, text, uuid) from public, anon, authenticated;
revoke execute on function public.insert_contract_event(uuid, uuid, text, text, text, jsonb, uuid) from public, anon, authenticated;

grant execute on function public.begin_contract_signature_send(uuid, uuid, uuid, text, timestamptz, text, text, text) to service_role;
grant execute on function public.complete_contract_signature_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.fail_contract_signature_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.attach_signed_contract_pdf(uuid, uuid, text, text, text, text, bigint, text) to service_role;
grant execute on function public.sign_contract_public(text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.decline_contract_public(text, text, text, text) to service_role;
grant execute on function public.ask_contract_question_public(text, text, text, text) to service_role;
grant execute on function public.snapshot_contract_version(uuid, uuid, text, text, text, bigint, text, uuid) to service_role;
grant execute on function public.insert_contract_event(uuid, uuid, text, text, text, jsonb, uuid) to service_role;

-- L1 — twee hulpfuncties met default-PUBLIC execute + geen tenant-check. Alleen
-- intern gebruikt (binnen SECURITY DEFINER-functies/triggers), nooit direct door
-- de client. Sluit de lichte cross-tenant info-lek (bestaan/UUID van een
-- grootboekrekening resp. billing-exempt-status van een willekeurige organisatie).
revoke execute on function public.bookkeeping_account_id(uuid, text) from public, anon, authenticated;
revoke execute on function public.organization_is_billing_exempt(uuid) from public, anon, authenticated;
grant execute on function public.bookkeeping_account_id(uuid, text) to service_role;
grant execute on function public.organization_is_billing_exempt(uuid) to service_role;

commit;
