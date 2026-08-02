-- Owners beschermen elkaar.
--
-- Uitgangspunt: wie eenmaal owner is, kan alleen nog door ZICHZELF worden
-- gedegradeerd, uitgeschakeld of verwijderd — nooit door een mede-owner. Zo
-- kan een organisatie met meerdere owners niet stuklopen op een machtsgreep
-- of een vergissing. Admins konden al niets aan teamleden wijzigen (de
-- update-policy stond altijd al alleen owners toe); het gat zat tussen
-- owners onderling: alleen de láátste owner was beschermd
-- (prevent_last_owner_change), elke andere owner was vogelvrij.
--
-- Twee lagen:
-- 1. RLS: de update-policy toont de rij van een actieve mede-owner niet meer
--    voor update, dus een client-call kan hem simpelweg niet raken.
-- 2. Trigger (diepe verdediging): vangt ook security-definer-RPC's en
--    toekomstige schrijfpaden af, met een duidelijke foutmelding. De guard
--    geldt alleen voor ingelogde eindgebruikers (auth.uid() is not null):
--    servicecontext — support via SQL-editor, service-role, migraties en
--    cascades wanneer een organisatie of auth-gebruiker wordt verwijderd —
--    blijft erbuiten, zodat beheer altijd kan ingrijpen.
--
-- Samen met de bestaande last-owner-guard geldt nu: een owner verdwijnt
-- alleen door eigen toedoen, en nooit als laatste.

create or replace function public.prevent_owner_peer_removal()
returns trigger
language plpgsql
as $$
declare
  v_actor uuid := auth.uid();
begin
  -- Servicecontext (geen ingelogde gebruiker): niets afdwingen.
  if v_actor is null then
    return coalesce(new, old);
  end if;

  if TG_OP = 'DELETE' then
    if old.role = 'owner' and old.status = 'active' and v_actor <> old.user_id then
      raise exception 'Owners zijn tegen elkaar beschermd: je kunt een andere owner niet verwijderen.'
        using errcode = '42501';
    end if;
    return old;
  end if;

  -- UPDATE: een actieve owner verliest zijn owner-rol of actieve status.
  if old.role = 'owner' and old.status = 'active'
     and (new.role <> 'owner' or new.status <> 'active')
     and v_actor <> old.user_id then
    raise exception 'Owners zijn tegen elkaar beschermd: je kunt een andere owner niet uitschakelen of degraderen.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_members_owner_peer_guard on public.organization_members;
create trigger organization_members_owner_peer_guard
  before update of role, status or delete on public.organization_members
  for each row execute function public.prevent_owner_peer_removal();

-- RLS: een owner mag alle leden bijwerken, behalve de rij van een ándere
-- actieve owner. De eigen rij blijft bereikbaar (zelf terugtrekken mag; de
-- last-owner-trigger bewaakt dat de organisatie nooit zonder owner valt) en
-- een uitgeschakelde owner-rij ook (heractiveren is geen "uitzetten").
drop policy if exists "members update by owners" on public.organization_members;
create policy "members update by owners" on public.organization_members
  for update
  using (
    public.can_owner_org(organization_id)
    and (role <> 'owner' or status <> 'active' or user_id = (select auth.uid()))
  )
  with check (public.can_owner_org(organization_id));

comment on function public.prevent_owner_peer_removal() is
  'Verhindert dat een ingelogde gebruiker een actieve owner van iemand anders degradeert, uitschakelt of verwijdert. Servicecontext (auth.uid() is null) valt buiten de guard zodat support en cascades blijven werken.';
