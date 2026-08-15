-- ============================================================
-- ResoFly — Bevestigingscode van de doorstuurregel bewaren
-- Date: 2026-08-15
--
-- WAAROM
-- Google (en Microsoft) sturen eerst een bevestigingsmail naar het nieuwe
-- doorstuuradres voordat doorsturen actief wordt. Die mail komt van een
-- no-reply-adres en zou dus in de opvangbak belanden als 'noreply_sender' —
-- precies de mail die de gebruiker nodig heeft om zijn setup af te maken.
--
-- mail-inbound herkent die bevestiging nu en zet de code hier neer, zodat het
-- instellingenscherm hem direct naast het doorstuuradres kan tonen.
--
-- BEWUST ALLEEN DE CODE, NOOIT DE URL
-- De bevestigingsmail bevat ook een klikbare link. Die tonen we niet: een
-- prominente link uit binnengekomen mail, weergegeven in het eigen
-- instellingenscherm, is de best denkbare phishingcontext. De gebruiker plakt
-- de code in het scherm van zijn eigen provider.
-- ============================================================

begin;

alter table public.organization_inbound_aliases
  add column if not exists pending_confirmation_code text,
  add column if not exists pending_confirmation_at timestamptz;

comment on column public.organization_inbound_aliases.pending_confirmation_code is
  'Laatste bevestigingscode uit een doorstuurbevestiging (Google/Microsoft). Alleen de code, nooit de bevestigings-URL.';

commit;
