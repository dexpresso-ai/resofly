-- ============================================================
-- ResoFly — Het logboek is alleen voor owners en admins
-- Date: 2026-11-11
--
-- Vraag: "Het logboek waar alle acties zichtbaar zijn mag alleen maar voor de
-- eigenaar en de beheerder beschikbaar zijn, niet voor de teamleden."
--
-- Tot nu toe las elk lid van de organisatie de regels over de modules die hij
-- mocht openen (20261003060000), en de boekhouder die over Financiën. Zo zag
-- een teamlid met alle modules vrijwel het hele logboek: wie wanneer wat deed,
-- met het e-mailadres van elke collega en per veld van oud naar nieuw — ook
-- wie de rechten van wie aanpaste. Dat is overzicht voor wie de organisatie
-- beheert, niet voor elk teamlid.
--
-- Nu leest alleen een owner of admin van díe organisatie het logboek. Voor
-- teamleden, kijkers en de boekhouder geeft de database niets terug: niet in
-- de app (Instellingen → Logboek, het blok op het dashboard), niet via
-- PostgREST, en Gerrie, de agents, MCP en de API weigeren audit.list voor hen
-- (adminOnly in _shared/actions/admin.ts; die lezen met de service-role).
--
-- Wat blijft:
--   - het schrijven: de triggers loggen alles zoals voorheen, ook wat een
--     teamlid doet; alleen wie het mag lezen verandert;
--   - audit_entity_module(): de app gebruikt die indeling nog voor de soorten
--     in het filter, en audit.list voor een owner of admin met een sleutel die
--     tot een paar modules beperkt is;
--   - het hek van de boekhouder (restrictive, alleen Financiën): overbodig nu
--     de boekhouder niets meer leest, maar het kan geen kwaad en houdt hem
--     dicht als iemand de leesregel ooit weer verruimt.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

drop policy if exists "audit logs read by org members" on public.audit_logs;
drop policy if exists "audit logs read by owners and admins" on public.audit_logs;
create policy "audit logs read by owners and admins" on public.audit_logs for select using (
  public.can_admin_org(organization_id)
);

comment on table public.audit_logs is
  'Het logboek: wie wat wanneer en waar heeft aangepast. Gevuld door triggers; alleen owners en admins van de organisatie lezen het (20261111090000). Niemand wijzigt of wist een regel.';

commit;
