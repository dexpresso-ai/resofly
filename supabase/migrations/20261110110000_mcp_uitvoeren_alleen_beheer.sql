-- ============================================================
-- AI-koppelingen (MCP): rechtstreeks uitvoeren alleen voor owners en admins.
--
-- Tot nu toe kon elk teamlid met Gerrie bij zijn eigen koppeling "Mag
-- rechtstreeks uitvoeren" en "Ook onomkeerbare handelingen" aanzetten
-- (20260917050000). Dan voert een gekoppelde AI wijzigingen uit zonder dat er
-- een mens op Uitvoeren klikt. Die AI leest ook klantmail, tickets en notulen;
-- tekst die iemand daarin zet, kan hem dus sturen. Dat besluit hoort bij wie de
-- organisatie beheert. Een teamlid houdt meelezen en klaarzetten: wat zijn AI
-- klaarzet, komt in de goedkeurwachtrij.
--
-- Drie sloten:
--   1. De trigger op mcp_grants weigert execute en execute_high als wie de
--      scope wijzigt geen owner of admin is (regel 4 hieronder).
--   2. Bestaande koppelingen van wie nu geen owner of admin is, verliezen die
--      twee rechten. Ze vallen terug op klaarzetten.
--   3. De MCP-functie kijkt bij elke aanroep naar de rol van dat moment
--      (supabase/functions/mcp/index.ts, mayExecute). Wordt een admin teamlid,
--      dan voert zijn AI vanaf de volgende aanroep niets meer rechtstreeks uit.
--
-- Veilig opnieuw te draaien: create or replace, en de update raakt alleen rijen
-- die nog een uitvoerrecht hebben.
-- ============================================================

begin;

create or replace function public.mcp_grants_guard_client_update()
returns trigger
language plpgsql
as $$
declare
  v_scopes   text[];
  v_ceiling  text[];
  v_unknown  text;
begin
  if auth.uid() is null then return new; end if;

  if new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id
     or new.client_id is distinct from old.client_id
     or new.scope_ceiling is distinct from old.scope_ceiling
     or new.created_at is distinct from old.created_at
     -- De boekhouding van de connector hoort niet aan de gebruiker. De
     -- UPDATE-policies zijn per rij en niet per kolom, dus zonder deze regels
     -- slaagde een PATCH met {"calls_in_window": 0} op je eigen koppeling —
     -- en een owner of admin kon dat bij een collega doen. Daarmee was het
     -- plafond van 120 per minuut met één extra verzoek weg te poetsen.
     or new.calls_in_window is distinct from old.calls_in_window
     or new.calls_window_start is distinct from old.calls_window_start
     or new.last_used_at is distinct from old.last_used_at then
    raise exception 'Vanuit de app is aan een AI-koppeling alleen intrekken, hernoemen en het wijzigen van je eigen rechten toegestaan.'
      using errcode = '42501';
  end if;

  if new.scope is distinct from old.scope then
    -- Regel 1: alleen de eigenaar. Een admin die hier komt, komt via de
    -- overzichtspolicy — en die is er om te stoppen, niet om te verruimen.
    if auth.uid() is distinct from old.user_id then
      raise exception 'Alleen de eigenaar van een AI-koppeling kan wijzigen wat die AI mag. Stoppen kan wel.'
        using errcode = '42501';
    end if;
    -- Een ingetrokken koppeling verruimen zou hem stilletjes weer bruikbaar
    -- laten lijken; de tokens zijn weg, maar de lijst zou iets anders zeggen.
    if old.revoked_at is not null then
      raise exception 'Deze AI-koppeling is ingetrokken; wijzigen kan niet meer.' using errcode = '42501';
    end if;

    v_scopes  := string_to_array(btrim(coalesce(new.scope, '')), ' ');
    v_ceiling := string_to_array(btrim(coalesce(old.scope_ceiling, '')), ' ');

    select s into v_unknown from unnest(v_scopes) as s
     where s not in ('read', 'propose', 'execute', 'execute_high') limit 1;
    if v_unknown is not null then
      raise exception 'Onbekend recht "%" voor een AI-koppeling.', v_unknown using errcode = '22023';
    end if;

    -- Regel 2: binnen het plafond van de client.
    select s into v_unknown from unnest(v_scopes) as s
     where not (s = any(v_ceiling)) limit 1;
    if v_unknown is not null then
      raise exception 'Deze AI-client heeft "%" nooit gevraagd; koppel opnieuw vanuit de AI-app als je dit wilt geven.', v_unknown
        using errcode = '42501';
    end if;

    -- Regel 3: geen losse treden.
    if not ('read' = any(v_scopes)) then
      raise exception 'Een AI-koppeling zonder leesrecht heeft geen betekenis; trek hem in als je hem niet meer wilt.'
        using errcode = '22023';
    end if;
    if 'execute_high' = any(v_scopes) and not ('execute' = any(v_scopes)) then
      raise exception 'Onomkeerbare handelingen rechtstreeks uitvoeren kan alleen als rechtstreeks uitvoeren aan staat.'
        using errcode = '22023';
    end if;
    if 'execute' = any(v_scopes) and not ('propose' = any(v_scopes)) then
      raise exception 'Rechtstreeks uitvoeren valt terug op klaarzetten; dat recht hoort er dan bij.'
        using errcode = '22023';
    end if;

    -- Regel 4 (20261110110000): rechtstreeks uitvoeren alleen voor een owner of
    -- admin. Een gekoppelde AI die zelf mag uitvoeren, handelt zonder dat er een
    -- mens tussen zit; ingevoegde tekst in een mail of ticket kan zo tot een
    -- wijziging leiden. Dat besluit hoort bij wie de organisatie beheert.
    if ('execute' = any(v_scopes) or 'execute_high' = any(v_scopes))
       and not public.can_admin_org(old.organization_id) then
      raise exception 'Rechtstreeks uitvoeren door een AI-koppeling kan alleen een owner of admin aanzetten.'
        using errcode = '42501';
    end if;
  end if;

  -- Intrekken is definitief; een ingetrokken koppeling komt niet terug.
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'Een ingetrokken koppeling kan niet opnieuw worden geactiveerd. Koppel opnieuw vanuit de AI-app.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
-- Een triggerfunctie roept niemand rechtstreeks aan; de trigger vuurt toch.
revoke all on function public.mcp_grants_guard_client_update() from public, anon, authenticated;

-- Bestaande koppelingen: wie nu geen actieve owner of admin is, valt terug op
-- klaarzetten. De migratie draait zonder auth.uid(), dus de trigger hierboven
-- laat deze update door.
update public.mcp_grants g
   set scope = array_to_string(array(
         select s from unnest(string_to_array(btrim(g.scope), ' ')) as s
          where s <> '' and s not in ('execute', 'execute_high')
       ), ' ')
 where g.scope ~ '(^|\s)(execute|execute_high)(\s|$)'
   and not exists (
     select 1 from public.organization_members m
      where m.organization_id = g.organization_id
        and m.user_id = g.user_id
        and m.status = 'active'
        and m.role in ('owner', 'admin')
   );

commit;
