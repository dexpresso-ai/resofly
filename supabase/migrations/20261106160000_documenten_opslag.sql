-- ============================================================
-- ResoFly — Het opslagquotum klopt, en een verwijderd Word-bestand verdwijnt
-- Date: 2026-11-06
--
-- Gevonden in de review van de documentopslag (6 november 2026):
--
--   1. HET QUOTUM WAS TE OMZEILEN. De app schrijft de grootte van een bestand
--      zelf in de rij (documents.size_bytes, attachments.size_bytes, …), en
--      organization_storage_status telt die op. Er gold geen ondergrens: wie
--      size_bytes op -2147483648 zette, haalde per rij 2 GB van het verbruik
--      af en kon daarna onbeperkt uploaden. En twee rijen van 5·10^18 lieten de
--      som buiten bigint lopen; dan gaf de teller een fout en liet de worker
--      (die bij een kapotte teller doorlaat) alles toe. Nu: niet negatief, en
--      hoogstens 1 TB per rij. Bij bestandsoverdrachten en de galerij stonden
--      zulke grenzen er al.
--   2. EEN VERWIJDERD WORD-BESTAND BLEEF STAAN. Verwijder je een document in
--      Word-modus (of een conceptcontract in Word), dan ging de rij weg, maar
--      het .docx bleef voorgoed in R2: buiten het quotum, en op te halen door
--      wie de sleutel had gezien. Nu komt de sleutel in storage_purge_queue
--      (dezelfde wachtrij als bij bestandsoverdrachten); de opruimtaak
--      file-transfer-purge haalt hem na een dag uit R2. Die dag is een vangnet
--      voor een vergissing. Wijst er nog iets anders naar hetzelfde bestand,
--      dan blijft het staan.
--   3. BESTANDEN IN EEN MAP BLEVEN ACHTER als de klant of het project werd
--      verwijderd (de map ging mee, de bestanden niet). Nu gaan ze mee: rij weg,
--      bestand in dezelfde wachtrij.
--
-- Let op: de opruimtaak file-transfer-purge moet ingepland staan (eenmalig:
-- workflow "Deploy Supabase (staging)" met het vinkje voor de webhooks, zie
-- scripts/supabase-setup-webhooks.sh). Op staging stond hij op 6 november niet.
--
-- Op staging stond geen enkele rij buiten deze grenzen (6 november).
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Grenzen op de groottes waaruit het quotum wordt opgeteld ────────────

do $$
declare
  v_grens constant bigint := 1099511627776; -- 1 TB
  r record;
begin
  for r in
    select * from (values
      ('documents',          'size_bytes',            'documents_size_bytes_bereik'),
      ('attachments',        'size_bytes',            'attachments_size_bytes_bereik'),
      ('meeting_recordings', 'size_bytes',            'meeting_recordings_size_bytes_bereik'),
      ('contracts',          'body_size_bytes',       'contracts_body_size_bytes_bereik'),
      ('contracts',          'signed_pdf_size_bytes', 'contracts_signed_pdf_size_bytes_bereik')
    ) as t(tabel, kolom, naam)
  loop
    if to_regclass('public.' || r.tabel) is null then
      continue;
    end if;
    if not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = r.tabel and c.column_name = r.kolom
    ) then
      continue;
    end if;
    execute format('alter table public.%I drop constraint if exists %I', r.tabel, r.naam);
    execute format('alter table public.%I add constraint %I check (%I is null or (%I >= 0 and %I <= %s))',
      r.tabel, r.naam, r.kolom, r.kolom, r.kolom, v_grens);
  end loop;
end;
$$;

-- ── 2. Een verwijderd Word-bestand gaat ook uit de opslag ──────────────────

-- Generiek: de kolom met de sleutel komt als argument mee (documents.storage_key,
-- contracts.body_storage_key). Bij een update alleen als de sleutel verandert.
create or replace function public.queue_office_file_purge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kolom text := tg_argv[0];
  v_oud   text := to_jsonb(old) ->> v_kolom;
  v_reden text := tg_argv[1];
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) ->> v_kolom) is not distinct from v_oud then
    return new;
  end if;
  if v_oud is null
     or position('..' in v_oud) > 0
     or v_oud not like old.organization_id::text || '/%' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Wijst er nog iets anders naar dit bestand, dan blijft het staan.
  if exists (select 1 from public.documents d
              where d.storage_key = v_oud
                and not (tg_table_name = 'documents' and d.id = old.id))
     or exists (select 1 from public.contracts c
                 where c.body_storage_key = v_oud
                   and not (tg_table_name = 'contracts' and c.id = old.id))
     or exists (select 1 from public.attachments a where a.storage_key = v_oud) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  insert into public.storage_purge_queue (organization_id, storage_key, reason, purge_after)
  values (old.organization_id, v_oud, v_reden, now() + interval '1 day');

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.queue_office_file_purge() from public, anon, authenticated;

drop trigger if exists documents_purge_office_file on public.documents;
create trigger documents_purge_office_file
  after delete or update of storage_key on public.documents
  for each row execute function public.queue_office_file_purge('storage_key', 'document');

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contracts' and column_name = 'body_storage_key'
  ) then
    execute 'drop trigger if exists contracts_purge_office_file on public.contracts';
    execute 'create trigger contracts_purge_office_file
               after delete or update of body_storage_key on public.contracts
               for each row execute function public.queue_office_file_purge(''body_storage_key'', ''contract'')';
  end if;
end;
$$;

-- ── 3. Bestanden in een map gaan mee met de map ────────────────────────────
--
-- Een map verdwijnt ook als zijn klant of project wordt verwijderd (on delete
-- cascade). De app ruimde de geüploade bestanden alleen op bij het verwijderen
-- van de map zelf; bij een verwijderde klant bleven ze staan: onzichtbaar,
-- maar wel meetellend in het quotum, op te halen met de sleutel, en (zonder
-- klant) ineens te delen via een open link. Bij een AVG-verzoek "verwijder
-- alles van deze klant" bleven zo juist zijn bestanden over.

create or replace function public.purge_folder_files()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.storage_purge_queue (organization_id, storage_key, reason, purge_after)
  select a.organization_id, a.storage_key, 'folder', now() + interval '1 day'
    from public.attachments a
   where a.entity_type = 'folder'
     and a.entity_id = old.id
     and a.organization_id = old.organization_id
     and a.storage_key is not null
     and position('..' in a.storage_key) = 0
     and a.storage_key like a.organization_id::text || '/%'
     and not exists (select 1 from public.attachments b where b.storage_key = a.storage_key and b.id <> a.id)
     and not exists (select 1 from public.documents d where d.storage_key = a.storage_key);

  delete from public.attachments a
   where a.entity_type = 'folder'
     and a.entity_id = old.id
     and a.organization_id = old.organization_id;
  return old;
end;
$$;

revoke all on function public.purge_folder_files() from public, anon, authenticated;

drop trigger if exists content_folders_purge_files on public.content_folders;
create trigger content_folders_purge_files
  after delete on public.content_folders
  for each row execute function public.purge_folder_files();

commit;
