-- ============================================================
-- ResoFly — Zoeken op Berichten met een index erachter
-- Date: 2026-09-18
--
-- search_client_emails deed per aanroep een sequentiële scan over álle mail van
-- de organisatie, en bouwde daarbij per rij én per zoekwoord de samengevoegde
-- tekst opnieuw op (inclusief het de-TOASTen van body_text, dat 128 KB per
-- bericht mag zijn). De pagina vuurt die aanroep af 300 ms nadat je stopt met
-- typen, dus bij een administratie met tienduizenden berichten betekende elke
-- typ-pauze een volledige scan.
--
-- WAT HIER GEBEURT
-- Een GIN-trigram-index op precies dezelfde samengevoegde expressie, plus een
-- voorfilter in de functie dat op die index kan landen. De volledige controle
-- ("alle woorden moeten voorkomen") blijft er ONVERANDERD achter staan, dus de
-- uitkomst is per definitie dezelfde — de index snoeit alleen de kandidaten.
--
-- TWEE DINGEN OM TE WETEN
-- 1. Trigrammen werken vanaf drie tekens. Is het langste zoekwoord korter, dan
--    slaat het voorfilter zichzelf over en gedraagt de functie zich precies
--    zoals voorheen. Woorden van één teken telden al niet mee.
-- 2. De index staat op de héle tekst, niet op een prefix. Een prefix zou
--    kleiner zijn, maar dan zou een treffer verderop in een lange mail buiten
--    het voorfilter vallen en stilletjes verdwijnen uit de resultaten — en een
--    zoekfunctie die soms iets mist is erger dan een zoekfunctie die traag is.
--    De index kost dus ruimte in verhouding tot de hoeveelheid mailtekst.
-- ============================================================

begin;

create extension if not exists pg_trgm;

-- ------------------------------------------------------------
-- De doorzoekbare tekst als één functie
-- ------------------------------------------------------------
-- Waarom een functie en niet de losse expressie: met de kale `||`-expressie
-- bestaat de index wél en is hij bruikbaar (nagemeten: een bitmap index scan
-- vindt de rij), maar KIEST de planner hem niet. Hij schat een sequentiële scan
-- op kosten 1350 en de index op 1787, en dat komt doordat body_text buiten de
-- tabel staat (TOAST): de heap is klein, dus de scan lijkt goedkoop — terwijl
-- het echte werk, 80 MB tekst uitpakken en aan elkaar plakken, nergens in dat
-- model zit.
--
-- Een functie met een expliciete COST zet dat recht: de planner rekent die
-- kosten per rij mee en ziet de scan dan voor wat hij is. 200 × 20.000 rijen ×
-- cpu_operator_cost komt ruim boven de index uit, en blijft tegelijk
-- realistisch — het uitpakken van een mail is echt honderden keren een gewone
-- operatie.
create or replace function public.client_email_haystack(
  p_subject text, p_from_name text, p_from_email text, p_body text
)
returns text
language sql
immutable
parallel safe
cost 200
as $$
  select coalesce(p_subject, '') || E'\n' || coalesce(p_from_name, '') || E'\n'
      || coalesce(p_from_email, '') || E'\n' || coalesce(p_body, '')
$$;

comment on function public.client_email_haystack(text, text, text, text) is
  'De tekst waarin search_client_emails zoekt. Apart en met een COST, zodat de planner de trigram-index verkiest boven een scan die alleen goedkoop lijkt.';

grant execute on function public.client_email_haystack(text, text, text, text) to authenticated, service_role;

-- De index moet LETTERLIJK dezelfde aanroep zijn als in de functie hieronder,
-- anders kijkt de planner er overheen. Partieel op deleted_at, want verwijderde
-- berichten doen sowieso niet mee.
create index if not exists idx_client_emails_search_trgm
  on public.client_emails
  using gin (public.client_email_haystack(subject, from_name, from_email, body_text) gin_trgm_ops)
  where deleted_at is null;

comment on index public.idx_client_emails_search_trgm is
  'Trigram-index voor search_client_emails. De expressie is gelijk aan het voorfilter in die functie; wijzigt de een, wijzig dan de ander.';

-- ------------------------------------------------------------
-- De functie, met het voorfilter erbij
-- ------------------------------------------------------------
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
  -- Het langste woord is het meest onderscheidend, dus dat is het beste
  -- voorfilter. `pattern` komt er nu bij: die gaat naar de index.
  --
  -- Is dat langste woord korter dan drie tekens, dan wordt het patroon '%'.
  -- Dat is met opzet: trigrammen bestaan pas vanaf drie tekens, en een losse
  -- `or length(word) < 3`-ontsnapping in de WHERE zou de hele voorwaarde
  -- onindexeerbaar maken — een OR waarvan één tak de geïndexeerde uitdrukking
  -- niet noemt, kan de planner niet op een index leggen. Met '%' staat er één
  -- voorwaarde die de index gebruikt zodra dat kan, en anders precies doet wat
  -- de functie hiervoor deed.
  first_word as (
    select lower(word) as word,
           case when length(word) >= 3 then pattern else '%' end as pattern
      from words order by length(word) desc, word limit 1
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
     -- Voorfilter op de trigram-index. Snoeit de kandidaten; de volledige
     -- controle hieronder bepaalt nog steeds wat er overblijft, dus dit kan de
     -- uitkomst niet veranderen — alleen het werk.
     and public.client_email_haystack(e.subject, e.from_name, e.from_email, e.body_text) ilike fw.pattern
     and n.total = (
       select count(*)
         from words w
        where public.client_email_haystack(e.subject, e.from_name, e.from_email, e.body_text) ilike w.pattern
     )
   order by e.created_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

commit;
