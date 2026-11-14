-- ============================================================
-- ResoFly — Galerij: geen twee bestanden met dezelfde naam in één album
-- Date: 2026-11-14
--
-- Aanleiding: wie dezelfde map nog eens uploadde, kreeg elk bestand twee keer
-- in het album. Niets hield dat tegen. De klant zag dubbele foto's, de opslag
-- telde ze dubbel, en in de zip heetten ze ineens "IMG_0001_2.jpg".
--
-- De app vraagt nu vóór het uploaden wat er met een dubbel bestand moet
-- gebeuren: overslaan, of uploaden onder een nieuwe naam die ResoFly kiest
-- ("IMG_0001-2.jpg"). Deze migratie zorgt dat de database dezelfde regel
-- bewaakt. Zonder die regel kwamen twee uploads tegelijk (twee collega's, of
-- twee tabbladen) er allebei door: de controle in de app zag de ander nog niet.
--
-- Wat er verandert:
-- 1. Een index op album + naam, zodat de controle niet het hele album leest.
-- 2. Een trigger die een nieuw bestand weigert als het album al een bestand met
--    dezelfde naam heeft. Hoofdletters tellen niet mee ("IMG_0001.JPG" is
--    hetzelfde als "img_0001.jpg"; op een Mac of in Windows botsen die bij het
--    uitpakken). Unicode wordt eerst gelijkgetrokken (NFC): een Mac levert
--    "é" soms als e + accent (NFD), en dan was "Café.jpg" voor de database een
--    ander bestand dan "Café.jpg" uit Windows.
--
-- Waarom een trigger en geen unieke index: er was geen controle, dus een
-- album op staging kan al dubbele namen hebben. Een unieke index faalt dan, of
-- we moeten eerst bestanden van klanten hernoemen zonder dat iemand erom
-- vroeg. Dat doen we niet: bestaande dubbele namen blijven staan, er komen er
-- alleen geen nieuwe bij. Een rij die zijn eigen naam houdt, wordt ook niet
-- gecontroleerd, zodat een update van zo'n oud dubbel bestand gewoon lukt.
--
-- Twee uploads tegelijk: de trigger neemt eerst een advisory lock op het
-- album, tot het einde van de transactie. De tweede wacht tot de eerste klaar
-- is en ziet dan diens rij. Zonder de lock zagen twee gelijktijdige inserts
-- elkaar niet.
--
-- Security invoker, geen definer: de controle ziet alleen de rijen die de
-- aanroeper zelf mag zien. Iemand van buiten die een rij in andermans album
-- probeert te zetten, krijgt dus de gewone weigering, nooit "deze naam bestaat
-- al". Anders kon hij raden welke bestanden er in een album van een ander
-- staan.
--
-- De naam begint met zzzzz_, zodat de trigger ná de rechtenpoorten
-- (zzz_module_write_gate, zzzz_creative_write_gate) draait: wie niet mag
-- schrijven, krijgt eerst die melding en neemt de lock nooit.
--
-- De app herkent deze weigering aan errcode 23505 met de hint
-- 'gallery_items_file_name_taken' (src/lib/galleryDuplicates.ts).
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- ── 1. Index op album + naam ────────────────────────────────────────────────

create index if not exists gallery_items_file_name_key_idx
  on public.gallery_items (gallery_id, (lower(normalize(file_name, NFC))));

-- ── 2. De controle ──────────────────────────────────────────────────────────

create or replace function public.enforce_gallery_items_unique_name()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_key text := lower(normalize(new.file_name, NFC));
begin
  -- Houdt de rij zijn naam (bijvoorbeeld een update die file_name gewoon
  -- meestuurt), dan valt er niets te controleren. Zo blijft een oud dubbel
  -- bestand gewoon bij te werken.
  if tg_op = 'UPDATE'
     and new.gallery_id = old.gallery_id
     and v_key = lower(normalize(old.file_name, NFC)) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('gallery_items.file_name:' || new.gallery_id::text, 0));

  if exists (
    select 1
    from public.gallery_items gi
    where gi.gallery_id = new.gallery_id
      and gi.organization_id = new.organization_id
      and lower(normalize(gi.file_name, NFC)) = v_key
      and gi.id <> new.id
  ) then
    raise exception 'Er staat al een bestand met de naam "%" in dit album.', new.file_name
      using errcode = '23505',
            hint = 'gallery_items_file_name_taken';
  end if;
  return new;
end;
$$;

drop trigger if exists zzzzz_gallery_items_unique_name on public.gallery_items;
create trigger zzzzz_gallery_items_unique_name
  before insert or update of file_name, gallery_id
  on public.gallery_items
  for each row execute function public.enforce_gallery_items_unique_name();

-- Een triggerfunctie hoeft niemand zelf aan te roepen; de trigger vuurt toch.
revoke all on function public.enforce_gallery_items_unique_name() from public, anon, authenticated;

commit;
