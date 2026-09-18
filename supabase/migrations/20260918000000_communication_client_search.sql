-- ============================================================
-- ResoFly — Berichten: zoeken binnen één klant
-- Date: 2026-09-18
--
-- NIET AUTOMATISCH UITVOEREN NODIG OM DE PAGINA TE LATEN WERKEN.
-- De frontend draait ook zonder deze migratie: kent de database de vierde
-- parameter nog niet, dan zoekt de app één keer opnieuw met de oude,
-- driearmige functie (zie searchClientEmails in src/lib/repository.ts). Er
-- komt geen fout in beeld; het zoeken is dan alleen breder dan bedoeld.
--
-- WAAROM
-- Op Berichten kun je nu op één klant filteren. De lijst splitst dan in twee
-- vensters — links de mailgesprekken van die klant, rechts zijn tickets — en
-- het mailvenster hoort compleet te zijn. Zoeken haalde zijn treffers tot nu
-- toe uit search_client_emails(org, zoektekst, limiet): de nieuwste 200 tot
-- 500 mails van de HELE organisatie waarin de woorden voorkomen. De app
-- filterde daar achteraf de gekozen klant uit.
--
-- Dat gaat stil mis zodra er veel post is. Zoek je op "offerte" terwijl je op
-- één klant staat, dan kunnen die 200 treffers allemaal van andere klanten
-- zijn — en dan vindt het mailvenster van jouw klant niets, terwijl de mail
-- er gewoon is. Achteraf filteren op een afgekapte lijst is geen filteren.
--
-- WAT
-- Dezelfde functie, met een vierde parameter p_client_id (standaard null).
-- Staat er een klant in, dan zoekt de database alleen in de post van die
-- klant en gaat de limiet dus over díé mail. Null = precies het oude gedrag,
-- de hele organisatie.
--
-- BEVEILIGING
-- Onveranderd: security invoker, dus de RLS van client_emails geldt (eigen
-- organisatie, module Klanten, verwijderde berichten onzichtbaar). p_client_id
-- snoeit alleen binnen wat de aanroeper toch al mocht zien; een klant van een
-- andere organisatie meegeven levert nul rijen op, geen lek. Jokertekens in de
-- zoektekst worden nog steeds ontsnapt en woorden korter dan twee tekens
-- tellen niet mee.
--
-- WAAROM DROP EN NIET ALLEEN CREATE OR REPLACE
-- Een parameter erbij maakt een andere functie-signatuur: `create or replace`
-- zou de oude laten staan en er een tweede naast zetten. Een aanroep met drie
-- argumenten past dan op allebei en Postgres weigert hem als dubbelzinnig.
-- Daarom eerst de oude weg. PostgREST zoekt de functie op argumentnaam, dus
-- de bestaande aanroep (zonder p_client_id) blijft gewoon werken.
-- ============================================================

begin;

drop function if exists public.search_client_emails(uuid, text, integer);

create or replace function public.search_client_emails(
  p_organization_id uuid,
  p_query text,
  p_limit integer default 200,
  p_client_id uuid default null
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
     -- Eén klant gekozen op Berichten: dan gaat de limiet over de post van
     -- die klant, niet over die van de hele organisatie.
     and (p_client_id is null or e.client_id = p_client_id)
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

comment on function public.search_client_emails(uuid, text, integer, uuid) is
  'Zoekt door alle klantmail van een organisatie (onderwerp, afzender, tekst): elke mail waarin álle zoekwoorden voorkomen, nieuwste eerst, met een tekstfragment rond de treffer. Met p_client_id blijft de zoektocht binnen één klant, zodat de limiet over díé post gaat. security invoker: de RLS van client_emails geldt.';

revoke all on function public.search_client_emails(uuid, text, integer, uuid) from public;
revoke all on function public.search_client_emails(uuid, text, integer, uuid) from anon;
grant execute on function public.search_client_emails(uuid, text, integer, uuid) to authenticated;

commit;
