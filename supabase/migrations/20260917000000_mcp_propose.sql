-- ============================================================
-- ResoFly — De gekoppelde AI mag wijzigingen KLAARZETTEN (MCP fase B)
-- Date: 2026-09-17
--
-- Fase A liet de eigen AI van een klant meelezen. Nu mag hij ook iets in gang
-- zetten — maar op precies dezelfde manier als Gerrie dat doet: hij ZET KLAAR,
-- een mens keurt goed, en pas dan gebeurt het.
--
-- WAAROM DIT ZO WEINIG NIEUWE DATABASE NODIG HEEFT
-- De weg bestaat al. Een geplande agent draait 's nachts terwijl niemand kijkt
-- en zet zijn voorstellen in `ai_action_audit` met status 'proposed'; de
-- goedkeurwachtrij op het startscherm toont die en voert ze uit zodra iemand
-- akkoord geeft. Een gekoppelde AI zit in exact dezelfde positie: headless, geen
-- mens in de buurt op het moment van voorstellen. Dus gaat hij door dezelfde
-- deur, en hoeft er maar één ding bij: waar kwam dit voorstel vandaan?
--
-- Vandaar deze ene kolom. De wachtrij herkent voorstellen van een agent aan
-- `agent_run_id`; met `mcp_grant_id` erbij herkent hij die van een AI-koppeling,
-- én is elk voorstel herleidbaar tot precies één koppeling — dus tot één
-- gebruiker, in één organisatie, met één AI-client.
--
-- WAT ER NIET VERANDERT (en dat is het punt)
--  • Uitvoeren gebeurt nog steeds in de BROWSER, onder de sessie van het teamlid
--    dat akkoord geeft. Daar geldt RLS, gelden de modulepoorten en gelden de
--    tenant-triggers. De service-role komt er niet aan te pas.
--  • Het voorstel wordt server-side gebouwd door `plan()` uit de registry, met
--    organization_id uit de KOPPELING. Een id van een andere organisatie loopt
--    stuk op `row()` — "niet gevonden in deze organisatie" — nog voordat er een
--    kaart is.
--  • Er komt geen pad bij waarlangs iets zonder menselijke klik gebeurt.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

alter table public.ai_action_audit
  add column if not exists mcp_grant_id uuid references public.mcp_grants(id) on delete set null;

comment on column public.ai_action_audit.mcp_grant_id is
  'Gezet wanneer dit voorstel van een gekoppelde AI komt (MCP). Wijst naar de koppeling, en daarmee naar de gebruiker, de organisatie en de AI-client die het klaarzette.';

-- De goedkeurwachtrij vraagt: wat staat er in deze organisatie open? Zonder deze
-- index wordt dat een seq scan over het hele auditlog, en dat log groeit hard —
-- sinds de connector komt élke opvraging erin.
create index if not exists idx_ai_action_audit_mcp_pending
  on public.ai_action_audit(organization_id, created_at desc)
  where mcp_grant_id is not null and status = 'proposed';

-- Een ingetrokken koppeling laat geen voorstellen achter die nog uitgevoerd
-- kunnen worden. Zou dat wel zo zijn, dan drukt iemand op "intrekken" omdat er
-- iets mis is en staat er daarna nog een rij klaar die die AI heeft opgesteld.
create or replace function public.mcp_cancel_grant_proposals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update public.ai_action_audit
       set status = 'cancelled',
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object('detail', 'De AI-koppeling is ingetrokken.')
     where mcp_grant_id = new.id and status = 'proposed';
  end if;
  return new;
end;
$$;

drop trigger if exists mcp_grants_cancel_proposals on public.mcp_grants;
create trigger mcp_grants_cancel_proposals
  after update of revoked_at on public.mcp_grants
  for each row execute function public.mcp_cancel_grant_proposals();

commit;
