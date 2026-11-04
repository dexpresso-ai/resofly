-- =============================================================================
-- Vingerafdruk van het app-schema: één regel per object, gesorteerd.
--
-- Gebruikt door scripts/schema-vergelijken.sh om een database die vanaf nul uit
-- de migraties is opgebouwd naast staging te leggen. Alleen lezen.
--
-- Telt mee: tabellen (met RLS-stand), kolommen, constraints, indexen,
-- triggers, functies (inhoud zonder witruimte, eigenaar, search_path),
-- rechten op tabellen, kolommen en functies, policies (ook op storage en
-- realtime), views, types, extensies, event-triggers, de realtime-publicatie en
-- de storage-buckets.
--
-- Witruimte in functies telt niet mee: staging heeft veel functies uit de
-- SQL-editor, met Windows-regeleinden.
-- =============================================================================
with
  app_schemas as (select oid, nspname from pg_namespace where nspname in ('public')),
  rels as (
    select c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl
    from pg_class c join app_schemas n on n.oid = c.relnamespace
    where c.relkind in ('r','p','v','m','S','f')
  ),
  fp as (
    select 'table' as kind, nspname || '.' || relname as key,
           'kind=' || relkind::text || ' rls=' || relrowsecurity::text || ' force=' || relforcerowsecurity::text as detail
    from rels
    union all
    select 'column', r.nspname || '.' || r.relname || '.' || a.attname,
           format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull::text
             || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
             || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text
    from rels r
    join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where r.relkind in ('r','p','v','m','f')
    union all
    select 'constraint', r.nspname || '.' || r.relname || '.' || co.conname, pg_get_constraintdef(co.oid)
    from rels r join pg_constraint co on co.conrelid = r.oid
    union all
    select 'index', r.nspname || '.' || ic.relname, pg_get_indexdef(i.indexrelid)
    from rels r join pg_index i on i.indrelid = r.oid join pg_class ic on ic.oid = i.indexrelid
    union all
    select 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname,
           pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_proc tp on tp.oid = t.tgfoid join pg_namespace tpn on tpn.oid = tp.pronamespace
    where not t.tgisinternal and (n.nspname = 'public' or tpn.nspname = 'public')
    union all
    select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           'returns=' || pg_get_function_result(p.oid) || ' lang=' || l.lanname || ' secdef=' || p.prosecdef::text
             || ' vol=' || p.provolatile::text || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-')
             || ' src=' || md5(btrim(regexp_replace(coalesce(p.prosrc, ''), '\s+', ' ', 'g')))
             || ' owner=' || pg_get_userbyid(p.proowner)
    from pg_proc p join app_schemas n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')
    union all
    select 'function_acl', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           coalesce((select string_agg(x, ',' order by x) from unnest(p.proacl::text[]) x), 'default')
    from pg_proc p join app_schemas n on n.oid = p.pronamespace
    where not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')
    union all
    select 'table_acl', r.nspname || '.' || r.relname,
           coalesce((select string_agg(x, ',' order by x) from unnest(r.relacl::text[]) x), 'default')
    from rels r
    union all
    select 'column_acl', r.nspname || '.' || r.relname || '.' || a.attname,
           (select string_agg(x, ',' order by x) from unnest(a.attacl::text[]) x)
    from rels r join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    where a.attacl is not null
    union all
    select 'policy', pol.schemaname || '.' || pol.tablename || '.' || pol.policyname,
           pol.permissive || ' ' || pol.cmd || ' roles=' || array_to_string(pol.roles, ',')
             || ' using=' || md5(coalesce(pol.qual, '')) || ' check=' || md5(coalesce(pol.with_check, ''))
    from pg_policies pol
    where pol.schemaname not in ('pg_catalog','information_schema')
      and not (pol.schemaname in ('auth','vault','cron','net','supabase_functions','_realtime'))
    union all
    select 'view', r.nspname || '.' || r.relname, md5(pg_get_viewdef(r.oid))
    from rels r where r.relkind in ('v','m')
    union all
    select 'type', n.nspname || '.' || t.typname,
           case t.typtype when 'e' then 'enum:' || (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)
                          when 'd' then 'domain:' || format_type(t.typbasetype, t.typtypmod)
                          else 'type:' || t.typtype::text end
    from pg_type t join app_schemas n on n.oid = t.typnamespace
    where t.typtype in ('e','d') or (t.typtype = 'c' and exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c'))
    union all
    select 'extension', e.extname, '-' from pg_extension e
    union all
    select 'event_trigger', e.evtname, e.evtevent || ' ' || pn.nspname || '.' || pp.proname || ' tags=' || coalesce(array_to_string(e.evttags, ','), '-') || ' enabled=' || e.evtenabled::text
    from pg_event_trigger e join pg_proc pp on pp.oid = e.evtfoid join pg_namespace pn on pn.oid = pp.pronamespace
    where pn.nspname <> 'extensions'
    union all
    select 'publication_table', pubname || ':' || schemaname || '.' || tablename, '-'
    from pg_publication_tables where schemaname = 'public'
    union all
    select 'bucket', b.id, 'public=' || b.public::text || ' limit=' || coalesce(b.file_size_limit::text, '-')
             || ' mime=' || coalesce(array_to_string(b.allowed_mime_types, ','), '-')
    from storage.buckets b
  )
select kind || ' | ' || key || ' | ' || coalesce(detail, '-') as line
from fp
order by kind, key, detail;
