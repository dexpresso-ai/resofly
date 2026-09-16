-- ============================================================
-- ResoFly — Owners en admins zien álle AI-koppelingen in hun organisatie (MCP)
-- Date: 2026-09-17
--
-- Aanleiding:
-- Een koppeling is persoonlijk: een teamlid koppelt zíjn AI, met zíjn rechten.
-- Dat is goed voor de rechten, maar het maakt het voor de eigenaar van de
-- organisatie onzichtbaar. Een medewerker die ChatGPT aan de bedrijfsadmin-
-- istratie hangt, is iets wat een owner hoort te weten — en hoort te kunnen
-- stoppen zonder eerst die medewerker te hoeven vinden. Zeker als die
-- medewerker net uit dienst is.
--
-- Dus: owners en admins mogen alle koppelingen in hun organisatie zien en
-- intrekken. Niet aanmaken — dat blijft de autorisatieserver, na een klik van
-- de gebruiker zelf — en niet wijzigen wat er mag; alleen zien en stoppen.
--
-- Dit zijn PERMISSIVE policies naast de bestaande "eigen rijen"-policies. Het
-- een of het ander is genoeg. De RESTRICTIVE modulepoort (module Gerrie) blijft
-- er bovenop staan: een admin die Gerrie dichtgezet heeft voor zichzelf, ziet
-- ook dit niet. Intrekken trekt via de bestaande triggers de tokens mee in en
-- annuleert wat er nog klaarstond — dat gold al en geldt nu ook voor een admin.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

drop policy if exists "mcp_grants read as admin" on public.mcp_grants;
create policy "mcp_grants read as admin" on public.mcp_grants for select using (
  exists (
    select 1 from public.organization_members m
     where m.organization_id = mcp_grants.organization_id
       and m.user_id = auth.uid()
       and m.status = 'active'
       and m.role in ('owner', 'admin')
  )
);

drop policy if exists "mcp_grants revoke as admin" on public.mcp_grants;
create policy "mcp_grants revoke as admin" on public.mcp_grants for update using (
  exists (
    select 1 from public.organization_members m
     where m.organization_id = mcp_grants.organization_id
       and m.user_id = auth.uid()
       and m.status = 'active'
       and m.role in ('owner', 'admin')
  )
) with check (
  exists (
    select 1 from public.organization_members m
     where m.organization_id = mcp_grants.organization_id
       and m.user_id = auth.uid()
       and m.status = 'active'
       and m.role in ('owner', 'admin')
  )
);

-- Een update-policy laat élke kolom toe. Het scherm zet alleen revoked_at, maar
-- een scherm is geen slot: deze trigger houdt de rest dicht, ook voor een admin.
-- De service-role (de autorisatieserver, die scope en label bijwerkt) blijft
-- erlangs kunnen — die heeft geen auth.uid().
create or replace function public.mcp_grants_guard_client_update()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then return new; end if;
  if new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id
     or new.client_id is distinct from old.client_id
     or new.scope is distinct from old.scope
     or new.created_at is distinct from old.created_at then
    raise exception 'Vanuit de app is aan een AI-koppeling alleen intrekken en hernoemen toegestaan.' using errcode = '42501';
  end if;
  -- Intrekken is definitief; een ingetrokken koppeling komt niet terug.
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'Een ingetrokken koppeling kan niet opnieuw worden geactiveerd. Koppel opnieuw vanuit de AI-app.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists mcp_grants_guard_client_update on public.mcp_grants;
create trigger mcp_grants_guard_client_update
  before update on public.mcp_grants
  for each row execute function public.mcp_grants_guard_client_update();

commit;
