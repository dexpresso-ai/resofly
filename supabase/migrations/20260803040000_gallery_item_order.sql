-- ============================================================
-- ResoFly — Galerij: volgorde van items in één keer zetten
-- Date: 2026-08-03
--
-- Aanleiding:
-- - De volgorde van foto's is het verhaal van de oplevering. Tot nu toe was
--   `sort_order` alleen de uploadvolgorde; er was geen manier om te sorteren
--   of te herschikken.
-- - Een galerij kan honderden foto's bevatten. Losse UPDATE's per foto zouden
--   honderden round-trips zijn (en half toegepaste volgordes opleveren als er
--   eentje faalt). Deze RPC zet de hele volgorde in één statement.
--
-- Beveiliging:
-- - SECURITY INVOKER (standaard): RLS én de module-gate-trigger op
--   gallery_items gelden onverkort, dus alleen wie in deze organisatie mag
--   schrijven kan de volgorde wijzigen.
-- - De WHERE-clausule bindt elke id aan de opgegeven galerij: id's van een
--   andere galerij raken simpelweg geen rij.
-- ============================================================

begin;

create or replace function public.gallery_set_item_order(
  p_gallery_id uuid,
  p_item_ids uuid[]
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_gallery_id is null or p_item_ids is null or array_length(p_item_ids, 1) is null then
    return 0;
  end if;

  update public.gallery_items gi
  set sort_order = ord.rn - 1,
      updated_at = now()
  from unnest(p_item_ids) with ordinality as ord(item_id, rn)
  where gi.id = ord.item_id
    and gi.gallery_id = p_gallery_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.gallery_set_item_order(uuid, uuid[]) from public, anon;
grant execute on function public.gallery_set_item_order(uuid, uuid[]) to authenticated;

commit;
