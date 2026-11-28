-- ============================================================
-- Pagina's in het portaal: afbeeldingen en bestanden (stap 1C-4,
-- docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §7 en §8).
--
-- Een gedeelde pagina toont de afbeeldingen en de namen van de bestanden uit
-- de gedeelde versie. Die versie ligt vast, maar een bijlage kan daarna
-- verhuizen: een bestand naar de map van een andere klant, of de pagina waar
-- een afbeelding aan hangt naar een ander dossier. Dan hoort de klant hem niet
-- meer te zien, ook niet via een oude versie.
--
-- shared_page_attachments() geeft daarom alleen de bijlagen uit de gedeelde
-- versie die nú nog in hetzelfde dossier horen als de pagina. Met dezelfde
-- regel als bij het opslaan (page_attachment_dossier, 20261127150000), zodat
-- schrijven en tonen niet uit elkaar kunnen lopen.
--
-- Alleen voor de service-role: client-portal en file-share-public roepen hem
-- aan nadat ze de lezer en de deling hebben gecontroleerd. Hij kijkt zelf nog
-- eens of de deling loopt.
--
-- Mag opnieuw draaien.
-- ============================================================

create or replace function public.shared_page_attachments(p_share_id uuid)
returns table (attachment_id uuid, kind text, name text, storage_key text, mime_type text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_share public.drive_shares;
  v_doc public.documents;
  v_version public.document_versions;
  v_client uuid;
begin
  select * into v_share from public.drive_shares s where s.id = p_share_id;
  if not found or v_share.item_type <> 'document' or v_share.document_version_id is null
     or v_share.revoked_at is not null
     or (v_share.expires_at is not null and v_share.expires_at <= now()) then
    return;
  end if;
  select * into v_doc from public.documents d
  where d.id = v_share.item_id and d.organization_id = v_share.organization_id
    and d.format = 'page' and d.archived_at is null;
  if not found then
    return;
  end if;
  select * into v_version from public.document_versions v
  where v.id = v_share.document_version_id and v.document_id = v_doc.id and v.organization_id = v_doc.organization_id;
  if not found then
    return;
  end if;

  -- Het dossier van de pagina nu: de klant van haar project, anders haar eigen klant.
  v_client := v_doc.client_id;
  if v_doc.project_id is not null then
    select coalesce(p.client_id, v_client) into v_client
    from public.projects p where p.id = v_doc.project_id and p.organization_id = v_doc.organization_id;
  end if;

  return query
  select a.id, r.kind, a.name, a.storage_key, a.mime_type
  from (
    select distinct b.kind, b.ref_id
    from public.page_body_refs(v_version.body) b
    where b.kind in ('image', 'fileBlock')
      and b.ref_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) r
  join public.attachments a on a.id = r.ref_id::uuid and a.organization_id = v_doc.organization_id
  cross join lateral public.page_attachment_dossier(v_doc.organization_id, a.id) dossier
  where dossier.bruikbaar and dossier.klant is not distinct from v_client;
end;
$$;

revoke all on function public.shared_page_attachments(uuid) from public, anon, authenticated;
grant execute on function public.shared_page_attachments(uuid) to service_role;
