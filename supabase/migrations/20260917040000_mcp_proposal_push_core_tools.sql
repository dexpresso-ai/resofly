-- ============================================================
-- De pushmelding van een MCP-voorstel zegt weer WAT er klaarstaat
--
-- `push_on_mcp_proposal` leest de tekst voor de melding uit `params->>'title'`.
-- Dat werkte zolang een koppeling alleen handelingen uit de registry kon
-- klaarzetten: die hebben de vorm {type:'action', title, sub, payload}.
--
-- Sinds de connector ook Gerrie's kerntools aanbiedt, komen er voorstellen
-- binnen in Gerrie's eigen vorm — {type:'ticket_note', ticket_title, body, …},
-- {type:'send_client_email', items, total, …}. Daar zit geen `title` in, want
-- de goedkeurwachtrij maakt de kaart zelf uit de velden die er wél zijn
-- (`proposalLabel` in src/lib/gerrie-proposals.ts).
--
-- Gevolg: precies bij de voorstellen die het meest naar buiten gericht zijn —
-- een mail aan een klant, een reactie in het klantportaal — viel de melding
-- terug op "Een voorstel wacht op je akkoord". Je zag dus niet meer waarvoor je
-- je telefoon uit je zak haalde.
--
-- De edge function schrijft die ene regel nu mee in `result->>'title'`. Bewust
-- daar en niet in `params`: `params` IS het voorstel, en dat wordt straks door
-- `executeProposal` in de browser uitgevoerd. Een extra sleutel erin zou een
-- veld zijn dat nergens bij hoort. `result` gaat juist over de RIJ — daar staan
-- de naam van de koppeling en de client-id ook al in.
--
-- De trigger vuurt `after insert`, dus de waarde die de function meegeeft is de
-- waarde die hier gelezen wordt; latere bevestigingen raken dit niet.
-- ============================================================

create or replace function public.push_on_mcp_proposal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_label   text;
  v_title   text;
begin
  -- Alleen een VOORSTEL van een KOPPELING. Opvragingen (executed/failed) en
  -- voorstellen van Gerrie zelf (geen mcp_grant_id) horen hier niet.
  if new.mcp_grant_id is null or new.status is distinct from 'proposed' then
    return null;
  end if;

  begin
    select g.user_id, g.label into v_user_id, v_label
      from public.mcp_grants g
     where g.id = new.mcp_grant_id;
    if v_user_id is null then return null; end if;

    -- Eerst de registry-vorm, dan de regel die de edge function meeschrijft voor
    -- een kerntool-voorstel, en pas dan de algemene tekst.
    v_title := coalesce(
      nullif(btrim(new.params->>'title'), ''),
      nullif(btrim(new.result->>'title'), ''),
      'Een voorstel wacht op je akkoord');

    perform public.push_enqueue(
      new.organization_id, 'mcp_proposal',
      array[v_user_id],
      jsonb_build_object(
        'title', coalesce(nullif(btrim(v_label), ''), 'Je AI') || ' heeft iets klaargezet',
        'body',  v_title,
        'url',   '/',
        -- Eén tag per koppeling: drie voorstellen achter elkaar worden één
        -- melding die zichzelf bijwerkt, geen drie losse pings.
        'tag',   'mcp:' || new.mcp_grant_id::text));
  exception when others then
    -- Een melding die niet wegkomt mag het voorstel zelf nooit tegenhouden.
    raise warning 'push_on_mcp_proposal: %', sqlerrm;
  end;
  return null;
end;
$$;
