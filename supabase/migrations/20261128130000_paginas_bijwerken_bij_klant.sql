-- ============================================================
-- Pagina's delen: zien of de klant de pagina van nu ziet, en bijwerken
-- (stap 1C-3, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §7).
--
-- Sinds 20261128120000 ziet een klant van een pagina de versie die gedeeld
-- is. Wijzig je de pagina daarna, dan staat er in de app "De klant ziet een
-- oudere versie", met de knop "Bijwerken bij klant". Daarvoor:
--
--   1. page_share_status(): per lopende deling van een pagina welke versie
--      de klant ziet, en of die nog gelijk is aan de pagina van nu. Met de
--      rechten van wie kijkt (security invoker): wie Inhoud niet mag lezen,
--      krijgt niets.
--   2. release_page_to_shares(): "Bijwerken bij klant". Legt een vrijgave
--      vast en zet die in één keer op elke lopende deling van de pagina.
--      Elke deling komt zo in het logboek, met de oude en de nieuwe versie.
--
-- Alleen document_version_id verandert, niet item_name. De controle op de
-- ontvanger (drive_shares_guard) vuurt dan niet: een contactpersoon die
-- inmiddels geen portaaltoegang meer heeft, zou anders het bijwerken voor
-- iedereen tegenhouden. De naam in het portaal volgt de versie al
-- (drive_share_items, en client-portal bij een losse deling).
--
-- Mag opnieuw draaien.
-- ============================================================

-- ── 1. Wat ziet de klant nu? ────────────────────────────────────────────────

create or replace function public.page_share_status(p_document_id uuid)
returns table (
  share_id uuid,
  document_version_id uuid,
  version integer,
  released_at timestamptz,
  is_current boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  -- jsonb vergelijkt op inhoud, niet op de volgorde van de sleutels: zo telt
  -- alleen een echte wijziging.
  select s.id, s.document_version_id, v.version, v.created_at,
         coalesce(v.body = d.body and v.title = d.title, false)
  from public.drive_shares s
  join public.documents d
    on d.id = s.item_id and d.organization_id = s.organization_id and d.format = 'page'
  left join public.document_versions v
    on v.id = s.document_version_id and v.document_id = d.id
  where s.item_type = 'document'
    and s.item_id = p_document_id
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
  order by s.created_at;
$$;

revoke all on function public.page_share_status(uuid) from public, anon;
grant execute on function public.page_share_status(uuid) to authenticated;

-- ── 2. Bijwerken bij klant ──────────────────────────────────────────────────

create or replace function public.release_page_to_shares(p_document_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
  v_version public.document_versions;
  v_count integer;
begin
  select * into v_doc from public.documents d where d.id = p_document_id;
  if not found
     or not public.can_write_org(v_doc.organization_id)
     or not public.can_write_module(v_doc.organization_id, 'content') then
    raise exception 'Je mag deze pagina niet delen.' using errcode = '42501';
  end if;
  if v_doc.format <> 'page' then
    raise exception 'Alleen een pagina werk je zo bij.' using errcode = '22023';
  end if;
  if v_doc.archived_at is not null then
    raise exception 'Een pagina in de prullenbak kun je niet delen.' using errcode = '22023';
  end if;

  -- Ziet elke ontvanger de pagina van nu al, dan geen nieuwe versie: anders
  -- vult een dubbele klik de geschiedenis met vrijgaven zonder verschil.
  if not exists (
    select 1
    from public.drive_shares s
    left join public.document_versions v on v.id = s.document_version_id
    where s.item_type = 'document' and s.item_id = v_doc.id and s.organization_id = v_doc.organization_id
      and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
      and (v.id is null or v.body is distinct from v_doc.body or v.title is distinct from v_doc.title)
  ) then
    return 0;
  end if;

  -- save_page_version zet de pagina vast (for update) en controleert de
  -- rechten nog eens, met de gebruiker van deze aanroep.
  v_version := public.save_page_version(v_doc.id, 'vrijgave');

  update public.drive_shares s
     set document_version_id = v_version.id
   where s.item_type = 'document' and s.item_id = v_doc.id and s.organization_id = v_doc.organization_id
     and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
     and s.document_version_id is distinct from v_version.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.release_page_to_shares(uuid) from public, anon;
grant execute on function public.release_page_to_shares(uuid) to authenticated;
