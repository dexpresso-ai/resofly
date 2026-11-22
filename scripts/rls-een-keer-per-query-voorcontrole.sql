-- Voorcontrole voor 20261122200000_rls_een_keer_per_query, alleen lezen.
-- Draai op staging VOOR de uitrol (Management API, read_only: true).
-- Verwacht (zo op de verse keten tot en met 20261120100000):
--   kandidaten 287 | lijst_md5 fac23e359f619261dc3511a026d749ac | nullable leeg |
--   poort_attachments_oud true | rest 'ai_decisions.ai_decisions read' |
--   al_aanwezig 0 | versie 17.11
-- Wijkt iets af, dan weigert de migratie op staging (en verandert er niets).
with kandidaat as (
  select c.relname, p.polname, c.oid as relid
  from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and p.polcmd = 'r'
    and pg_get_expr(p.polqual, p.polrelid) ~ '\m(public\.)?(can_read_org\(organization_id\)|can_read_module\(organization_id, ''[a-z_]+''::text\))'
)
select
  (select count(*) from kandidaat) as kandidaten,
  (select md5(string_agg(format('%I.%I', relname, polname), ',' order by relname collate "C", polname collate "C")) from kandidaat) as lijst_md5,
  (select coalesce(string_agg(distinct k.relname, ', '), '') from kandidaat k
     join pg_attribute a on a.attrelid = k.relid and a.attname = 'organization_id' where not a.attnotnull) as nullable,
  (select regexp_replace(pg_get_expr(polqual, polrelid), '\mpublic\.', '', 'g')
          = '((attachment_module(entity_type) IS NULL) OR can_read_module(organization_id, attachment_module(entity_type)))'
     from pg_policy where polrelid = 'public.attachments'::regclass and polname = 'module gate select') as poort_attachments_oud,
  (select coalesce(string_agg(format('%s.%s', c.relname, p.polname), '; ' order by c.relname, p.polname), '')
     from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and p.polcmd = 'r'
      and regexp_replace(regexp_replace(pg_get_expr(p.polqual, p.polrelid),
            '\m(public\.)?can_read_org\(organization_id\)', '', 'g'),
            '\m(public\.)?can_read_module\(organization_id, ''[a-z_]+''::text\)', '', 'g')
          ~ '\m(can_read_org|can_read_module)\(organization_id[,)]'
      and not (c.relname = 'attachments' and p.polname = 'module gate select')) as rest,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
     and proname in ('my_organization_ids', 'my_module_organization_ids', 'my_readable_module_keys')) as al_aanwezig,
  current_setting('server_version') as versie;
