-- ============================================================
-- ResoFly — Ongebruikte AI-clientregistraties opruimen
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt I).
--
-- mcp-oauth /register kan zonder login (dynamische clientregistratie, zo werkt
-- het koppelen van Claude of ChatGPT). Elke registratie werd een rij in
-- mcp_clients, en die werd nooit opgeruimd: een lus over /register vulde de
-- gedeelde database. Sinds deze ronde begrenst mcp-oauth de grootte van een
-- registratie; deze migratie ruimt dagelijks registraties op die na twee dagen
-- nog nergens toe hebben geleid (geen koppeling).
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create or replace function public.mcp_purge_unused_clients()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.mcp_clients c
   where c.created_at < now() - interval '2 days'
     -- Een autorisatiecode hangt aan een koppeling (mcp_auth_codes.grant_id):
     -- zonder koppeling is er ook geen code.
     and not exists (select 1 from public.mcp_grants g where g.client_id = c.client_id);
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.mcp_purge_unused_clients() from public, anon, authenticated;
grant execute on function public.mcp_purge_unused_clients() to service_role;

-- Dagelijks om 03:27 UTC, als pg_cron er is. Opnieuw draaien vervangt de taak.
do $$
begin
  if to_regclass('cron.job') is not null
     and to_regprocedure('cron.schedule(text,text,text)') is not null
     and to_regprocedure('cron.unschedule(bigint)') is not null then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'resofly-mcp-clients-purge';
    perform cron.schedule('resofly-mcp-clients-purge', '27 3 * * *', 'select public.mcp_purge_unused_clients();');
  else
    raise notice 'pg_cron staat niet aan: plan mcp_purge_unused_clients() zelf in.';
  end if;
end;
$$;

commit;
