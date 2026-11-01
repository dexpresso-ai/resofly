-- ============================================================
-- ResoFly — Teamchat: online-status en "typt" alleen voor het team
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, fix 34).
--
-- Teamchat gebruikt twee Realtime-kanalen zonder databasewijzigingen:
--   chat:presence:<organisatie-id>  wie er online is (presence)
--   chat:typing:<gesprek-id>        wie er typt (broadcast)
-- Die waren publiek. Iedereen met de publieke anon-sleutel kon ze openen,
-- ook zonder in te loggen. Met het id van een organisatie (dat staat
-- bijvoorbeeld in de bestandsadressen van een gedeelde galerij) zag je zo
-- wie er online was, en kon je je als een collega online melden.
--
-- De app opent deze kanalen nu als privé (config.private). Realtime laat dan
-- alleen toe wie onderstaande regels op realtime.messages doorstaat:
--   * online-status: lezen en melden alleen met leesrecht op Teamchat in die
--     organisatie;
--   * typen: alleen deelnemers aan dat gesprek.
-- De kanalen voor databasewijzigingen (postgres_changes) blijven zoals ze
-- zijn; daar geldt de RLS van de tabellen al.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create or replace function public.realtime_chat_topic_allowed(p_topic text)
returns boolean
language plpgsql
stable
set search_path = public
as $$
begin
  if p_topic is null then
    return false;
  end if;
  if p_topic ~ '^chat:presence:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return coalesce(public.can_read_module(substr(p_topic, 15)::uuid, 'chat'), false);
  end if;
  if p_topic ~ '^chat:typing:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return coalesce(public.chat_is_participant(substr(p_topic, 13)::uuid), false);
  end if;
  return false;
end;
$$;

revoke all on function public.realtime_chat_topic_allowed(text) from public, anon;
grant execute on function public.realtime_chat_topic_allowed(text) to authenticated, service_role;

drop policy if exists "teamchat realtime lezen" on realtime.messages;
create policy "teamchat realtime lezen"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension in ('presence', 'broadcast')
    and public.realtime_chat_topic_allowed((select realtime.topic()))
  );

drop policy if exists "teamchat realtime melden" on realtime.messages;
create policy "teamchat realtime melden"
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension in ('presence', 'broadcast')
    and public.realtime_chat_topic_allowed((select realtime.topic()))
  );

commit;
