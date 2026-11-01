-- ============================================================
-- ResoFly — Pincode van een galerij: blokkeren per bezoeker
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt Q).
--
-- Na 8 foute pincodes ging de hele galerij een kwartier op slot, voor
-- iedereen. En omdat de teller niet terugging, was daarna één foute poging
-- genoeg. Wie de link had (een doorgestuurde mail is genoeg), kon zo de echte
-- klant blijvend buitensluiten.
--
-- Nu telt gallery_verify_share_pin per bezoeker (een hash van token en adres,
-- die gallery-public meegeeft): 8 foute pogingen en dan een kwartier op slot,
-- alleen voor die bezoeker. Voor de galerij als geheel blijft een rem: per 100
-- foute pogingen van alle bezoekers samen een uur dicht. Met een pincode van 6
-- tot 8 cijfers blijft raden vanaf veel adressen zo maanden werk.
--
-- Een aanroep zonder bezoeker werkt als voorheen.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create table if not exists public.gallery_pin_attempts (
  gallery_id uuid not null references public.galleries(id) on delete cascade,
  visitor_hash text not null,
  failed_count integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (gallery_id, visitor_hash)
);

alter table public.gallery_pin_attempts enable row level security;
revoke all on public.gallery_pin_attempts from public, anon, authenticated;
grant all on public.gallery_pin_attempts to service_role;

drop function if exists public.gallery_verify_share_pin(uuid, text);

create or replace function public.gallery_verify_share_pin(
  p_gallery_id uuid,
  p_pin_hash text,
  p_visitor_hash text default null
)
returns table(ok boolean, locked boolean, locked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.galleries;
  v_visitor public.gallery_pin_attempts;
  v_failed integer;
  v_locked_until timestamptz;
  v_gallery_locked_until timestamptz;
begin
  -- FOR UPDATE serialiseert gelijktijdige pogingen op dezelfde galerij.
  select * into v_row from public.galleries where id = p_gallery_id for update;
  if not found then
    raise exception 'Galerij niet gevonden.' using errcode = 'P0002';
  end if;

  if v_row.share_pin_locked_until is not null and v_row.share_pin_locked_until > now() then
    return query select false, true, v_row.share_pin_locked_until;
    return;
  end if;

  if p_visitor_hash is not null then
    select * into v_visitor from public.gallery_pin_attempts
     where gallery_id = p_gallery_id and visitor_hash = p_visitor_hash;
    if found and v_visitor.locked_until is not null and v_visitor.locked_until > now() then
      return query select false, true, v_visitor.locked_until;
      return;
    end if;
  end if;

  if v_row.share_pin_hash is not null and p_pin_hash is not null and v_row.share_pin_hash = p_pin_hash then
    update public.galleries
       set share_pin_failed_count = 0,
           share_pin_locked_until = null
     where id = p_gallery_id;
    delete from public.gallery_pin_attempts
     where gallery_id = p_gallery_id
       and (visitor_hash = p_visitor_hash or updated_at < now() - interval '30 days');
    return query select true, false, null::timestamptz;
    return;
  end if;

  if p_visitor_hash is null then
    -- Zoals voorheen: per galerij, 8 pogingen en dan een kwartier.
    update public.galleries
       set share_pin_failed_count = share_pin_failed_count + 1,
           share_pin_locked_until = case
             when share_pin_failed_count + 1 >= 8 then now() + interval '15 minutes'
             else share_pin_locked_until
           end
     where id = p_gallery_id
     returning share_pin_failed_count, share_pin_locked_until into v_failed, v_locked_until;
    return query select false, (v_locked_until is not null and v_locked_until > now()), v_locked_until;
    return;
  end if;

  -- Per bezoeker: 8 foute pogingen, dan een kwartier op slot. De teller gaat
  -- bewust niet terug naar nul: na afloop is één foute poging genoeg.
  insert into public.gallery_pin_attempts as a (gallery_id, visitor_hash, failed_count, updated_at)
  values (p_gallery_id, p_visitor_hash, 1, now())
  on conflict (gallery_id, visitor_hash) do update
     set failed_count = a.failed_count + 1,
         locked_until = case
           when a.failed_count + 1 >= 8 then now() + interval '15 minutes'
           else a.locked_until
         end,
         updated_at = now()
  returning a.locked_until into v_locked_until;

  -- Voor de galerij als geheel: per 100 foute pogingen een uur dicht.
  update public.galleries
     set share_pin_failed_count = share_pin_failed_count + 1,
         share_pin_locked_until = case
           when (share_pin_failed_count + 1) % 100 = 0 then now() + interval '1 hour'
           else share_pin_locked_until
         end
   where id = p_gallery_id
   returning share_pin_locked_until into v_gallery_locked_until;

  if v_gallery_locked_until is not null and v_gallery_locked_until > now()
     and (v_locked_until is null or v_gallery_locked_until > v_locked_until) then
    v_locked_until := v_gallery_locked_until;
  end if;

  return query select false, (v_locked_until is not null and v_locked_until > now()), v_locked_until;
end;
$$;

revoke all on function public.gallery_verify_share_pin(uuid, text, text) from public, anon, authenticated;
grant execute on function public.gallery_verify_share_pin(uuid, text, text) to service_role;

commit;
