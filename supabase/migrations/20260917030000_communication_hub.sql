-- ============================================================
-- ResoFly — Berichten: alle klantcommunicatie op één pagina
-- Date: 2026-09-17
--
-- WAAROM
-- Klantmail leefde uitsluitend per klant (klantdossier → tabblad Communicatie)
-- en de opvangbak voor niet-gekoppelde post hing als tabblad aan de
-- klantenlijst. Wie wilde weten "is er nieuwe post?" moest dus klant voor
-- klant kijken. De nieuwe pagina Berichten (menu Communicatie) toont álle
-- gesprekken van de organisatie in één lijst, plus de post die nog niet aan
-- een klant gekoppeld is. Het tabblad per klant blijft precies zoals het was.
--
-- WAT
-- 1. View client_email_thread_overview: één regel per gesprek met klantnaam,
--    aantal berichten, het laatste bericht (afzender, korte preview) en de
--    ongelezen-teller van de HUIDIGE gebruiker. security_invoker, zodat de
--    RLS van client_email_threads, client_emails, clients en
--    client_email_reads gewoon geldt: iemand ziet alleen gesprekken van zijn
--    eigen organisatie, en 'gelezen' blijft per persoon.
-- 2. inbound_messages in de realtime-publicatie, zodat de badge op Berichten
--    en de melding "nieuw bericht, nog niet gekoppeld" live binnenkomen.
--    RLS geldt per abonnee (can_read_module 'clients'), net als bij
--    client_emails.
--
-- VALKUILEN DIE HIER BEWUST ZIJN AFGEVANGEN
-- - De preview wordt uit een AFGEKAPT stuk body_text gehaald (800 tekens) en
--   pas daarna witruimte-genormaliseerd: een regexp over 128 KB per gesprek
--   zou de lijst onnodig traag maken.
-- - deleted_at wordt óók in de view gefilterd. De RLS-policy doet dat al voor
--   gewone gebruikers, maar de service-role leest zonder RLS; die mag hier
--   nooit een verwijderd bericht als "laatste bericht" terugkrijgen.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Gespreksoverzicht
-- ------------------------------------------------------------
create or replace view public.client_email_thread_overview
with (security_invoker = on) as
select
  t.id,
  t.organization_id,
  t.created_by,
  t.client_id,
  c.name  as client_name,
  c.email as client_email,
  t.subject,
  t.last_message_at,
  t.last_direction,
  t.created_at,
  t.updated_at,
  coalesce(stats.message_count, 0)::integer          as message_count,
  coalesce(stats.unread_count, 0)::integer           as unread_count,
  coalesce(stats.has_delivery_problem, false)        as has_delivery_problem,
  lm.id         as last_email_id,
  lm.direction  as last_email_direction,
  lm.from_name  as last_from_name,
  lm.from_email as last_from_email,
  lm.status     as last_status,
  lm.created_at as last_email_at,
  left(regexp_replace(left(coalesce(lm.body_text, ''), 800), '\s+', ' ', 'g'), 200) as last_preview
from public.client_email_threads t
join public.clients c on c.id = t.client_id
left join lateral (
  select count(*) as message_count,
         count(*) filter (
           where e.direction = 'inbound'
             and not exists (
               select 1 from public.client_email_reads r
                where r.client_email_id = e.id and r.user_id = auth.uid()
             )
         ) as unread_count,
         bool_or(e.status in ('bounced', 'failed', 'complained')) as has_delivery_problem
    from public.client_emails e
   where e.thread_id = t.id
     and e.deleted_at is null
) stats on true
left join lateral (
  select e.id, e.direction, e.from_name, e.from_email, e.status, e.body_text, e.created_at
    from public.client_emails e
   where e.thread_id = t.id
     and e.deleted_at is null
   order by e.created_at desc
   limit 1
) lm on true;

comment on view public.client_email_thread_overview is
  'Eén regel per klantgesprek voor de pagina Berichten: klantnaam, aantal berichten, laatste bericht en de ongelezen-teller van de huidige gebruiker. security_invoker: de RLS van de onderliggende tabellen geldt.';

revoke all on public.client_email_thread_overview from anon;
grant select on public.client_email_thread_overview to authenticated;

-- ------------------------------------------------------------
-- 2. Live meldingen voor de opvangbak
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'inbound_messages'
    ) then
      alter publication supabase_realtime add table public.inbound_messages;
    end if;
  end if;
end $$;

commit;
