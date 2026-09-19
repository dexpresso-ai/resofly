-- ============================================================
-- ResoFly — Deellink van een galerij blijft zichtbaar
-- Date: 2026-09-19
--
-- WAAROM
-- De deellink was maar één keer te zien: bij het genereren stond hij in beeld
-- en daarna bewaarde de database alleen de SHA-256-hash. Zodra het scherm
-- opnieuw tekende — en dat gebeurt bij élke wijziging aan de galerij, dus ook
-- bij publiceren — was de link weg. Wie hem nog niet had gekopieerd, kon niets
-- anders dan een nieuwe genereren, waarmee de link die hij misschien al had
-- gemaild meteen ongeldig werd.
--
-- Dat is voor deze link ook niet nodig. Hij is geen wachtwoord van een
-- gebruiker maar een capability-URL van de studio zelf: wie hem mag zien, mag
-- sowieso al een nieuwe maken, de galerij publiceren of hem intrekken (RLS:
-- can_read_org / can_write_org). De pincode blijft wél alleen als hash
-- bestaan — die is van de ontvanger, niet van de studio.
--
-- WAT
-- 1. galleries.share_token — het token in leesbare vorm, zodat het scherm de
--    link altijd kan tonen en kopiëren. De publieke pagina blijft zoeken op
--    share_token_hash; aan die kant verandert er niets.
-- 2. Een trigger die het leesbare token wist zodra het delen uit gaat, de hash
--    verdwijnt, of er een nieuwe hash komt zonder nieuw token. Intrekken mag
--    nooit half gebeuren, en een token dat niet meer bij de hash hoort zou een
--    link tonen die nergens meer op uitkomt.
--
-- WAT DIT NIET DOET
-- Publiceren en delen blijven twee aparte knoppen. De deellink blijft staan
-- als de galerij terug naar concept gaat, maar de publieke pagina weigert dan
-- (gallery-public geeft 403 zolang status <> 'published'). "Publicatie
-- ongedaan maken" is dus de manier om de pagina te sluiten zonder de link
-- kwijt te raken; intrekken blijft de manier om de link zelf ongeldig te
-- maken.
--
-- BESTAANDE DEELLINKS
-- Voor galerijen met een hash uit de oude situatie blijft share_token leeg:
-- het token bestaat nergens meer en is uit een SHA-256 niet terug te rekenen.
-- Die links blijven gewoon werken; het scherm vraagt om een nieuwe link te
-- genereren zodra iemand hem wil terugzien.
-- ============================================================

begin;

alter table public.galleries
  add column if not exists share_token text;

comment on column public.galleries.share_token is
  'Het deeltoken in leesbare vorm, alleen leesbaar binnen de organisatie (RLS). Bestaat zodat het scherm de deellink altijd kan tonen; de publieke pagina zoekt op share_token_hash.';

comment on column public.galleries.share_token_hash is
  'SHA-256 van het deeltoken; hierop zoekt gallery-public. Uniek zolang hij gevuld is.';

-- ------------------------------------------------------------
-- Token en hash horen bij elkaar
-- ------------------------------------------------------------
create or replace function public.enforce_gallery_share_token()
returns trigger
language plpgsql
as $$
begin
  -- Geen actieve deellink (of geen hash) ⇒ ook geen leesbaar token bewaren.
  -- Zo wist elk intrekpad het token, ook een pad dat het veld niet kent.
  if new.share_enabled is not true or new.share_token_hash is null then
    new.share_token := null;
    return new;
  end if;

  -- Nieuwe hash zonder nieuw token: dan hoort het bewaarde token niet meer bij
  -- deze link. Dat gebeurt bij een tabblad dat nog de oude app draait (die het
  -- veld niet kent) — zonder deze regel zou het scherm daarna een token tonen
  -- dat op geen enkele galerij meer uitkomt. Liever geen link dan een dode.
  if tg_op = 'UPDATE'
     and new.share_token_hash is distinct from old.share_token_hash
     and new.share_token is not distinct from old.share_token then
    new.share_token := null;
  end if;

  return new;
end;
$$;

drop trigger if exists galleries_share_token_guard on public.galleries;
create trigger galleries_share_token_guard
  before insert or update of share_enabled, share_token_hash, share_token
  on public.galleries
  for each row execute function public.enforce_gallery_share_token();

-- Opruimen van wat er nu al staat: een token zonder actieve link hoort er niet
-- te zijn. (Vandaag onmogelijk — de kolom is net nieuw — maar deze migratie
-- draait ook op databases die later worden bijgewerkt.)
update public.galleries
  set share_token = null
  where share_token is not null
    and (share_enabled is not true or share_token_hash is null);

commit;
