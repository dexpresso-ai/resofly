-- ============================================================
-- ResoFly — Berichten: zoeken door álle klantmail
-- Date: 2026-09-17
--
-- WAAROM
-- De pagina Berichten laadt per gesprek alleen het laatste bericht (view
-- client_email_thread_overview). Zoeken op die lijst vindt dus een woord uit
-- het laatste bericht, maar niet uit een mail van drie weken terug in
-- hetzelfde gesprek. "Gericht door alle berichten zoeken" vraagt om de
-- database: die heeft élke mail. Tickets en hun tijdlijn staan al volledig
-- in de app en worden lokaal doorzocht.
--
-- WAT
-- Functie search_client_emails(org, zoektekst, limiet): elke mail van de
-- organisatie waarin ÁLLE zoekwoorden voorkomen (onderwerp, afzender, tekst),
-- nieuwste eerst, met een stuk tekst rond de eerste treffer. De app zet die
-- treffers om in gesprekken in de lijst en toont "Gevonden: …".
--
-- BEVEILIGING
-- security invoker: de RLS van client_emails geldt (eigen organisatie,
-- module Klanten, verwijderde berichten onzichtbaar). De functie voegt daar
-- niets aan toe en haalt er niets vanaf. Jokertekens in de zoektekst (%, _)
-- worden ontsnapt zodat ze letterlijk gezocht worden.
--
-- VALKUILEN DIE HIER BEWUST ZIJN AFGEVANGEN
-- - Het tekstfragment wordt alleen voor de gevonden rijen berekend (in de
--   select-lijst), niet voor elke mail van de organisatie.
-- - Woorden korter dan twee tekens tellen niet mee; één letter zou elke mail
--   raken en de lijst nutteloos maken.
-- ============================================================

begin;

create or replace function public.search_client_emails(
  p_organization_id uuid,
  p_query text,
  p_limit integer default 200
)
returns table (
  id uuid,
  thread_id uuid,
  client_id uuid,
  subject text,
  from_name text,
  from_email text,
  direction text,
  created_at timestamptz,
  excerpt text
)
language sql
stable
security invoker
set search_path = public
as $$
  with words as (
    select distinct w as word,
           '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
      from regexp_split_to_table(btrim(coalesce(p_query, '')), '\s+') as w
     where length(w) >= 2
  ),
  n as (
    select count(*) as total from words
  ),
  first_word as (
    select lower(word) as word from words order by length(word) desc, word limit 1
  )
  select e.id,
         e.thread_id,
         e.client_id,
         e.subject,
         e.from_name,
         e.from_email,
         e.direction,
         e.created_at,
         -- Een stuk tekst rond de eerste treffer van het langste zoekwoord;
         -- staat het woord alleen in het onderwerp of de afzender, dan het
         -- begin van de tekst.
         regexp_replace(
           case
             when position(fw.word in lower(coalesce(e.body_text, ''))) > 0
               then substr(coalesce(e.body_text, ''), greatest(1, position(fw.word in lower(coalesce(e.body_text, ''))) - 300), 900)
             else left(coalesce(e.body_text, ''), 900)
           end,
           '\s+', ' ', 'g'
         ) as excerpt
    from public.client_emails e
   cross join n
   cross join first_word fw
   where e.organization_id = p_organization_id
     and e.deleted_at is null
     and n.total > 0
     and n.total = (
       select count(*)
         from words w
        where (coalesce(e.subject, '') || E'\n' || coalesce(e.from_name, '') || E'\n' || coalesce(e.from_email, '') || E'\n' || coalesce(e.body_text, ''))
              ilike w.pattern
     )
   order by e.created_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

comment on function public.search_client_emails(uuid, text, integer) is
  'Zoekt door alle klantmail van een organisatie (onderwerp, afzender, tekst): elke mail waarin álle zoekwoorden voorkomen, nieuwste eerst, met een tekstfragment rond de treffer. security invoker: de RLS van client_emails geldt.';

revoke all on function public.search_client_emails(uuid, text, integer) from public;
revoke all on function public.search_client_emails(uuid, text, integer) from anon;
grant execute on function public.search_client_emails(uuid, text, integer) to authenticated;

commit;
