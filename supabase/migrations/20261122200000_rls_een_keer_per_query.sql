-- ============================================================
-- ResoFly — RLS: de rechten één keer per query opzoeken, niet per rij
-- Date: 2026-11-22
--
-- Waarom: elke leespolicy riep per rij can_read_org(organization_id) aan, en
-- elke module gate daarbovenop can_read_module(organization_id, '<module>').
-- Allebei komen ze uit bij een security definer-functie met een eigen query
-- op organization_members (user_is_org_member, org_module_level). Postgres
-- kan zo'n functie niet inlinen en roept hem voor elke rij opnieuw aan.
-- Gemeten op staging (19 november, bank_transactions): 166 ms voor 1.820
-- rijen, tegen 1,6 ms zonder de controle per rij; zo'n 90 µs per rij. De kern
-- van de werkruimte leest bij elke start en elke ververs alle taken,
-- bijlagen, facturen en notities: bij een paar duizend rijen honderden ms per
-- vraag, en de paginering per 1000 betaalt het per pagina opnieuw.
-- 20261119100000 loste dat voor één telling op met een eigen functie; dit
-- lost het op in de policies zelf.
--
-- Hoe: hetzelfde patroon als het boekhouder-hek (20261011000000):
--
--   organization_id = any ((select public.my_organization_ids())::uuid[])
--
-- Een subquery zonder verwijzing naar de rij wordt een InitPlan: één keer per
-- query uitgerekend. De planner gebruikt hem bovendien als indexvoorwaarde op
-- organization_id. De cast naar uuid[] is nodig: zonder leest Postgres
-- `= any ((select …))` als een subquery en vergelijkt hij uuid met uuid[].
--
-- Zelfde uitkomst, voor elke rol:
--
--   can_read_org(org)        = er is een actief lidmaatschap (org, auth.uid())
--                            = org zit in my_organization_ids()
--   can_read_module(org, m)  = member_module_level(rol, module_access, m) is
--                              read of write, voor het ene actieve lidmaatschap
--                              (organization_id, user_id is uniek, dus de
--                              `limit 1` in org_module_level kiest niets)
--                            = org zit in my_module_organization_ids(m)
--   geen JWT (auth.uid() null): lege lijst, dus niets; net als nu.
--   anon: heeft sinds 20261101000000 geen rechten op de tabellen, en kan de
--         nieuwe functies net als can_read_org niet aanroepen.
--   null:   de functies gaven false, `null = any(…)` geeft null. Een policy
--           laat in beide gevallen de rij niet door; alleen waar de uitkomst
--           wordt omgedraaid of vergeleken (NOT, IS FALSE, CASE) is het anders.
--           Daarom herschrijft deze migratie alleen tabellen waar
--           organization_id NOT NULL is (stap 3 controleert dat): daar is de
--           nieuwe vorm overal precies de oude. De lijsten zelf bevatten geen
--           null: organization_members.organization_id is NOT NULL.
--
-- Geen recursie: de nieuwe functies zijn security definer van postgres (de
-- eigenaar van organization_members, met BYPASSRLS), net als
-- user_is_org_member, die de policy op organization_members zelf al aanriep.
--
-- Wat verandert: alleen leespolicies (for select) in public, en daarin alleen
-- de letterlijke aanroepen can_read_org(organization_id) en
-- can_read_module(organization_id, '<module>') op de kolom van de tabel zelf.
-- Schrijfpolicies, `for all`-policies en de triggers blijven zoals ze zijn:
-- schrijven raakt één rij per keer. Daarnaast de leespoort op attachments,
-- waar de module van de rij afhangt (stap 4), en apply_module_gate, zodat een
-- nieuwe tabel meteen de snelle vorm krijgt (stap 2).
--
-- Bewust blijven staan (per rij, en klein):
--   - organizations "organizations read by members": can_read_org(id). Niet
--     op organization_id; een gebruiker leest er een handvol van.
--   - ai_decisions "ai_decisions read": can_read_module(organization_id,
--     module), met de module uit een kolom. De rest van die policy gaat wel
--     mee.
--   tests/database/rls_een_keer_per_query.sql houdt deze lijst bij: een nieuwe
--   leespolicy met de oude vorm laat die test falen.
--
-- Na te lezen: de herschrijving rekent op de tekst van pg_get_expr en zet daar
-- twee vaste vervangingen op. Welke policies het raakt, staat hieronder
-- letterlijk (stap 3); wijkt de database daarvan af, dan stopt de migratie en
-- verandert er niets. Zo is de uitkomst op staging dezelfde als op een verse
-- database, of de migratie faalt.
--
-- Veilig om opnieuw te draaien: create or replace, en de herschrijving vindt
-- na de eerste keer niets meer om te vervangen.
-- ============================================================

begin;

-- alter policy neemt per tabel een AccessExclusiveLock, op zo'n 160 tabellen.
-- Wacht hij achter een lange query, dan staan alle lezers van die tabel achter
-- hem in de rij en hangt de app. Liever na tien seconden falen en opnieuw
-- uitrollen.
set local lock_timeout = '10s';

-- ── 1. De lijsten, één keer per query ───────────────────────────────────────

-- Zelfde regel als user_is_org_member (20260427000000).
create or replace function public.my_organization_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(m.organization_id), '{}'::uuid[])
  from public.organization_members m
  where m.user_id = auth.uid()
    and m.status = 'active';
$$;

comment on function public.my_organization_ids() is
  'De organisaties waar de ingelogde gebruiker actief lid van is. Voor RLS als (select …)::uuid[]: een InitPlan, één keer per query. Zelfde regel als can_read_org.';

-- Zelfde regel als can_read_module: member_module_level (20261011000000) op
-- het eigen lidmaatschap. Ook voor een module die module_keys() niet kent,
-- precies zoals can_read_module.
create or replace function public.my_module_organization_ids(p_module text)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(m.organization_id), '{}'::uuid[])
  from public.organization_members m
  where m.user_id = auth.uid()
    and m.status = 'active'
    and public.member_module_level(m.role, m.module_access, p_module) in ('read', 'write');
$$;

comment on function public.my_module_organization_ids(text) is
  'De organisaties waar de ingelogde gebruiker deze module mag lezen (read of write). Voor RLS, als InitPlan. Zelfde regel als can_read_module.';

-- Voor attachments: daar hangt de module van de rij af
-- (attachment_module(entity_type)), dus één lijst per module past niet in één
-- InitPlan. Daarom sleutels "<organisatie>:<module>" voor elke module uit
-- module_keys() die de gebruiker mag lezen. Dat klopt alleen als
-- attachment_module niets buiten module_keys() teruggeeft; stap 4 controleert
-- dat, en tests/database/rls_een_keer_per_query.sql na elke migratie opnieuw.
-- Zou het toch gebeuren, dan valt de bijlage dicht, niet open.
create or replace function public.my_readable_module_keys()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(m.organization_id::text || ':' || k), '{}'::text[])
  from public.organization_members m
  cross join unnest(public.module_keys()) as k
  where m.user_id = auth.uid()
    and m.status = 'active'
    and public.member_module_level(m.role, m.module_access, k) in ('read', 'write');
$$;

comment on function public.my_readable_module_keys() is
  'Sleutels "<organisatie>:<module>" voor elke module die de ingelogde gebruiker mag lezen. Voor de leespoort op attachments, als InitPlan.';

revoke all on function public.my_organization_ids() from public, anon;
revoke all on function public.my_module_organization_ids(text) from public, anon;
revoke all on function public.my_readable_module_keys() from public, anon;
grant execute on function public.my_organization_ids() to authenticated, service_role;
grant execute on function public.my_module_organization_ids(text) to authenticated, service_role;
grant execute on function public.my_readable_module_keys() to authenticated, service_role;

-- ── 2. Nieuwe tabellen krijgen meteen de snelle vorm ────────────────────────
--
-- Overgenomen uit 20260730100000 (later niet meer gewijzigd); alleen de
-- policy voor select is anders. Schrijven blijft per rij: dat raakt één rij
-- per keer.

create or replace function public.apply_module_gate(
  p_table text,
  p_module text,
  p_write_level text default 'write'
)
returns void
language plpgsql
as $$
declare
  -- Voor de meeste tabellen mag alleen 'write' schrijven. Persoonlijke
  -- bijhoud-tabellen (gelezen-markeringen) mogen ook door lezers geschreven
  -- worden — anders krijgt een lees-only teamlid een foutmelding zodra hij
  -- een ticket of chatbericht opent.
  v_write_fn text := case when p_write_level = 'read' then 'can_read_module' else 'can_write_module' end;
begin
  if p_write_level not in ('read', 'write') then
    raise exception 'Ongeldig schrijfniveau: %', p_write_level;
  end if;

  execute format('drop policy if exists %I on public.%I', 'module gate select', p_table);
  execute format('drop policy if exists %I on public.%I', 'module gate insert', p_table);
  execute format('drop policy if exists %I on public.%I', 'module gate update', p_table);
  execute format('drop policy if exists %I on public.%I', 'module gate delete', p_table);

  -- Eén keer per query (20261122200000). Tot dan can_read_module per rij.
  execute format(
    'create policy %I on public.%I as restrictive for select to authenticated using (organization_id = any ((select public.my_module_organization_ids(%L))::uuid[]))',
    'module gate select', p_table, p_module);
  execute format(
    'create policy %I on public.%I as restrictive for insert to authenticated with check (public.%I(organization_id, %L))',
    'module gate insert', p_table, v_write_fn, p_module);
  execute format(
    'create policy %I on public.%I as restrictive for update to authenticated using (public.%I(organization_id, %L)) with check (public.%I(organization_id, %L))',
    'module gate update', p_table, v_write_fn, p_module, v_write_fn, p_module);
  execute format(
    'create policy %I on public.%I as restrictive for delete to authenticated using (public.%I(organization_id, %L))',
    'module gate delete', p_table, v_write_fn, p_module);

  -- Naam met zzz_ zodat de gate ná eventuele andere BEFORE-triggers draait en
  -- organization_id dus zeker gevuld is.
  execute format('drop trigger if exists zzz_module_write_gate on public.%I', p_table);
  execute format(
    'create trigger zzz_module_write_gate before insert or update or delete on public.%I for each row execute function public.enforce_module_write_access(%L, %L)',
    p_table, p_module, p_write_level);
end;
$$;

revoke all on function public.apply_module_gate(text, text, text) from public, anon, authenticated;

-- ── 3. De bestaande leespolicies herschrijven ───────────────────────────────
--
-- Met een lege search_path schrijft pg_get_expr elke naam buiten pg_catalog
-- voluit (public.…, auth.uid()), zoals pg_dump dat doet. alter policy leest
-- diezelfde tekst dan precies zo terug, wie de migratie ook draait.
--
-- Per policy:
--   a. vervang de twee letterlijke aanroepen (meer niet);
--   b. alter policy; leest Postgres de nieuwe tekst niet, dan stopt alles;
--   c. lees de policy terug, zet de oude aanroepen terug en vergelijk met de
--      oude tekst: die moet letterlijk gelijk zijn. Zo is bewezen dat er
--      verder niets is veranderd.
-- Vooraf: precies deze lijst (gemaakt op een verse database met de keten tot
-- en met 20261122110000; fiscal_year_partner_shares kwam erbij met
-- 20261122100000_vof_verdeling_per_boekjaar), en op elke tabel
-- organization_id NOT NULL. Bij een
-- tweede keer draaien is er niets meer te vervangen en doet de stap niets.

do $$
declare
  c_oud      constant text := '\mpublic\.(can_read_org\(organization_id\)|can_read_module\(organization_id, ''[a-z_]+''::text\))';
  v_pad      text := current_setting('search_path');
  v_verwacht text[];
  v_gevonden text[];
  v_teveel   text[];
  v_tekort   text[];
  v_nullable text[];
  r          record;
  v_oud      text;
  v_nieuw    text;
  v_terug    text;
  v_aantal   int := 0;
begin
  perform pg_catalog.set_config('search_path', '', true);

  select pg_catalog.array_agg(pg_catalog.format('%I.%I', t.tabel, p.policy))
    into v_verwacht
  from (values
    ('ai_action_audit', array['module gate select']),
    ('ai_agent_run_events', array['ai_agent_run_events read']),
    ('ai_agent_runs', array['module gate select']),
    ('ai_agents', array['module gate select']),
    ('ai_conversations', array['module gate select']),
    ('ai_decision_mutes', array['ai_decision_mutes read']),
    ('ai_decisions', array['ai_decisions read']),
    ('ai_messages', array['module gate select']),
    ('ai_report_messages', array['ai_report_messages own read', 'module gate select']),
    ('ai_report_versions', array['ai_report_versions own read', 'module gate select']),
    ('ai_reports', array['ai_reports own read', 'module gate select']),
    ('ai_signal_settings', array['ai_signal_settings read']),
    ('ai_usage', array['module gate select']),
    ('annual_account_filings', array['annual_account_filings read', 'module gate select']),
    ('annual_account_signatures', array['annual_account_signatures read', 'module gate select']),
    ('annual_accounts', array['annual_accounts read', 'module gate select']),
    ('asset_depreciations', array['asset_depreciations read', 'module gate select']),
    ('attachments', array['attachments read']),
    ('bank_accounts', array['bank_accounts read', 'module gate select']),
    ('bank_requisitions', array['bank_requisitions read', 'module gate select']),
    ('bank_rules', array['bank_rules read', 'module gate select']),
    ('bank_statements', array['bank_statements read', 'module gate select']),
    ('bank_transaction_allocations', array['bank_transaction_allocations read', 'module gate select']),
    ('bank_transactions', array['bank_transactions read', 'module gate select']),
    ('calendar_app_passwords', array['module gate select']),
    ('calendar_connections', array['calendar connections read own or shared', 'module gate select']),
    ('calendar_event_attendees', array['calendar_event_attendees read', 'module gate select']),
    ('calendar_event_links', array['calendar_event_links read', 'module gate select']),
    ('calendar_events', array['calendar_events read', 'module gate select']),
    ('calendar_feed_links', array['module gate select']),
    ('calendar_sources', array['calendar sources read own or shared', 'module gate select']),
    ('chat_conversation_prefs', array['module gate select']),
    ('chat_conversations', array['module gate select']),
    ('chat_member_status', array['chat status select org', 'module gate select']),
    ('chat_message_reactions', array['module gate select']),
    ('chat_messages', array['module gate select']),
    ('chat_participants', array['module gate select']),
    ('chat_saved_messages', array['module gate select']),
    ('client_calls', array['client_calls read', 'module gate select']),
    ('client_contacts', array['client_contacts read', 'module gate select']),
    ('client_domains', array['client domains read by org members']),
    ('client_email_events', array['client email events read', 'module gate select']),
    ('client_email_folders', array['client email folders read', 'module gate select']),
    ('client_email_reads', array['module gate select']),
    ('client_email_threads', array['client email threads read', 'module gate select']),
    ('client_emails', array['client emails read', 'module gate select']),
    ('client_field_definitions', array['client field definitions read', 'module gate select']),
    ('client_subdomains', array['client subdomains read by org members']),
    ('clients', array['clients read', 'module gate select']),
    ('closed_periods', array['closed_periods read', 'module gate select']),
    ('company_settings', array['company settings read']),
    ('content_folders', array['content_folders read', 'module gate select']),
    ('contract_email_deliveries', array['contract email deliveries read', 'module gate select']),
    ('contract_email_events', array['contract email events read', 'module gate select']),
    ('contract_events', array['contract events read', 'module gate select']),
    ('contract_internal_notes', array['contract notes read', 'module gate select']),
    ('contract_projects', array['contract projects read', 'module gate select']),
    ('contract_signers', array['contract signers read', 'module gate select']),
    ('contract_templates', array['contract templates read', 'module gate select']),
    ('contract_versions', array['contract versions read', 'module gate select']),
    ('contracts', array['contracts read', 'module gate select']),
    ('corporate_tax_corrections', array['corporate_tax_corrections read', 'module gate select']),
    ('corporate_tax_losses', array['corporate_tax_losses read', 'module gate select']),
    ('corporate_tax_returns', array['corporate_tax_returns read', 'module gate select']),
    ('credit_notes', array['credit notes read', 'module gate select']),
    ('dga_interest_postings', array['dga_interest_postings read', 'module gate select']),
    ('dga_interest_rates', array['dga_interest_rates read', 'module gate select']),
    ('dividend_distribution_lines', array['dividend_distribution_lines read', 'module gate select']),
    ('dividend_distributions', array['dividend_distributions read', 'module gate select']),
    ('documents', array['documents read', 'module gate select']),
    ('drive_shares', array['drive_shares read', 'module gate select']),
    ('email_campaign_recipients', array['email campaign recipients read', 'module gate select']),
    ('email_campaigns', array['email campaigns read', 'module gate select']),
    ('email_flow_enrollments', array['email flow enrollments read', 'module gate select']),
    ('email_flow_sends', array['email flow sends read', 'module gate select']),
    ('email_flow_steps', array['email flow steps read', 'module gate select']),
    ('email_flows', array['email flows read', 'module gate select']),
    ('email_suppressions', array['email suppressions read', 'module gate select']),
    ('email_templates', array['email templates read']),
    ('file_transfer_events', array['file_transfer_events read', 'module gate select']),
    ('file_transfer_items', array['file_transfer_items read', 'module gate select']),
    ('file_transfer_recipients', array['file_transfer_recipients read', 'module gate select']),
    ('file_transfers', array['file_transfers client gate', 'file_transfers read', 'module gate select']),
    ('finance_provider_jobs', array['module gate select']),
    ('fiscal_year_partner_shares', array['fiscal year partner shares read', 'module gate select']),
    ('fiscal_year_size_inputs', array['fiscal_year_size_inputs read', 'module gate select']),
    ('fiscal_years', array['fiscal_years read', 'module gate select']),
    ('fixed_assets', array['fixed_assets read', 'module gate select']),
    ('forecast_versions', array['forecast versions read', 'module gate select']),
    ('forecasts', array['forecasts read', 'module gate select']),
    ('galleries', array['galleries read', 'module gate select']),
    ('gallery_categories', array['gallery_categories read', 'module gate select']),
    ('gallery_category_presets', array['gallery_category_presets read', 'module gate select']),
    ('gallery_favorites', array['gallery_favorites read', 'module gate select']),
    ('gallery_items', array['gallery_items read', 'module gate select']),
    ('inbound_messages', array['inbound messages read', 'module gate select']),
    ('income_tax_corrections', array['income tax corrections read', 'module gate select']),
    ('income_tax_kia_exclusions', array['income tax kia exclusions read', 'module gate select']),
    ('income_tax_profiles', array['income tax profiles read', 'module gate select']),
    ('invoice_chargebacks', array['invoice chargebacks read', 'module gate select']),
    ('invoice_dunning_notices', array['invoice dunning notices read', 'module gate select']),
    ('invoice_email_deliveries', array['invoice email deliveries read', 'module gate select']),
    ('invoice_email_events', array['invoice email events read', 'module gate select']),
    ('invoice_payment_records', array['invoice payment records read', 'module gate select']),
    ('invoice_public_links', array['invoice public links read by org', 'module gate select']),
    ('invoice_refunds', array['invoice refunds read', 'module gate select']),
    ('invoice_reminder_settings', array['invoice reminder settings read', 'module gate select']),
    ('invoice_version_items', array['invoice version items read', 'module gate select']),
    ('invoice_versions', array['invoice versions read', 'module gate select']),
    ('invoice_workflow_events', array['invoice workflow events read', 'module gate select']),
    ('invoices', array['invoices read', 'module gate select']),
    ('journal_entries', array['journal_entries read', 'module gate select']),
    ('journal_lines', array['journal_lines read', 'module gate select']),
    ('ledger_accounts', array['ledger_accounts read', 'module gate select']),
    ('mcp_grants', array['mcp_grants read own', 'module gate select']),
    ('meeting_booking_links', array['meeting_booking_links read', 'module gate select']),
    ('meeting_booking_slots', array['meeting_booking_slots read', 'module gate select']),
    ('meeting_bookings', array['meeting_bookings read', 'module gate select']),
    ('meeting_recordings', array['meeting_recordings read', 'module gate select']),
    ('note_calendar_links', array['module gate select', 'note calendar links read']),
    ('note_handwriting', array['module gate select', 'note handwriting read']),
    ('notes', array['module gate select', 'notes read']),
    ('organization_email_domains', array['organization email domains read']),
    ('organization_inbound_aliases', array['module gate select', 'org inbound alias read']),
    ('organization_members', array['members read by org members']),
    ('organization_portal_settings', array['organization portal settings read']),
    ('partnership_partners', array['module gate select', 'partnership partners read']),
    ('planner_day_capacity', array['planner_day_capacity read own']),
    ('planner_notes', array['planner_notes read own']),
    ('prepaid_expense_releases', array['module gate select', 'prepaid_expense_releases read']),
    ('prepaid_expenses', array['module gate select', 'prepaid_expenses read']),
    ('project_members', array['module gate select', 'project_members read']),
    ('project_template_tasks', array['module gate select', 'project_template_tasks read']),
    ('project_templates', array['module gate select', 'project_templates read']),
    ('projects', array['module gate select', 'projects read']),
    ('purchase_invoice_inbox', array['module gate select', 'purchase invoice inbox read']),
    ('purchase_invoice_inbox_settings', array['module gate select', 'purchase invoice inbox settings read']),
    ('purchase_invoices', array['module gate select', 'purchase_invoices read']),
    ('quote_approval_events', array['module gate select', 'quote approval events read']),
    ('quote_email_deliveries', array['module gate select', 'quote email deliveries read']),
    ('quote_email_events', array['module gate select', 'quote email events read']),
    ('quote_version_items', array['module gate select', 'quote version items read']),
    ('quote_versions', array['module gate select', 'quote versions read']),
    ('quotes', array['module gate select', 'quotes read']),
    ('result_appropriations', array['module gate select', 'result_appropriations read']),
    ('saved_reports', array['module gate select', 'saved_reports read']),
    ('share_encumbrances', array['module gate select', 'share_encumbrances read']),
    ('share_transactions', array['module gate select', 'share_transactions read']),
    ('shareholders', array['module gate select', 'shareholders read']),
    ('suppliers', array['module gate select', 'suppliers read']),
    ('task_assignees', array['module gate select', 'task_assignees read']),
    ('tasks', array['module gate select', 'tasks read']),
    ('ticket_notes', array['module gate select', 'ticket_notes read']),
    ('ticket_reads', array['module gate select']),
    ('tickets', array['module gate select', 'tickets read']),
    ('time_entries', array['module gate select', 'time_entries read']),
    ('user_sender_identities', array['user sender identities read']),
    ('vat_codes', array['module gate select', 'vat_codes read']),
    ('vat_returns', array['module gate select', 'vat_returns read']),
    ('vat_supplement_entries', array['module gate select', 'vat_supplement_entries read'])
  ) as t(tabel, policies)
  cross join lateral pg_catalog.unnest(t.policies) as p(policy);

  select coalesce(pg_catalog.array_agg(pg_catalog.format('%I.%I', c.relname, p.polname)), '{}')
    into v_gevonden
  from pg_catalog.pg_policy p
  join pg_catalog.pg_class c on c.oid = p.polrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and p.polcmd = 'r'
    and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ c_oud;

  if pg_catalog.cardinality(v_gevonden) = 0 then
    raise notice 'RLS per query: niets meer te herschrijven (al gedraaid)';
    perform pg_catalog.set_config('search_path', v_pad, true);
    return;
  end if;

  v_teveel := array(select pg_catalog.unnest(v_gevonden) except select pg_catalog.unnest(v_verwacht) order by 1);
  v_tekort := array(select pg_catalog.unnest(v_verwacht) except select pg_catalog.unnest(v_gevonden) order by 1);
  if pg_catalog.cardinality(v_teveel) > 0 or pg_catalog.cardinality(v_tekort) > 0 then
    raise exception 'RLS per query: de leespolicies wijken af van de lijst in deze migratie. Niet in de lijst: %. Niet (meer) in de oude vorm: %. Er is niets veranderd.',
      coalesce(nullif(pg_catalog.array_to_string(v_teveel, ', '), ''), '-'),
      coalesce(nullif(pg_catalog.array_to_string(v_tekort, ', '), ''), '-');
  end if;

  select pg_catalog.array_agg(distinct c.relname::text order by c.relname::text)
    into v_nullable
  from pg_catalog.pg_policy p
  join pg_catalog.pg_class c on c.oid = p.polrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id'
  where n.nspname = 'public'
    and p.polcmd = 'r'
    and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ c_oud
    and not a.attnotnull;
  if v_nullable is not null then
    raise exception 'RLS per query: organization_id mag null zijn op %; daar is `= any` niet gelijk aan de oude aanroep. Er is niets veranderd.',
      pg_catalog.array_to_string(v_nullable, ', ');
  end if;

  for r in
    select p.oid, c.relname, p.polname, pg_catalog.pg_get_expr(p.polqual, p.polrelid) as qual
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and p.polcmd = 'r'
      and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ c_oud
    order by c.relname, p.polname
  loop
    v_oud := r.qual;

    -- a. De haakjes eromheen houden de voorrang gelijk, waar de aanroep ook staat.
    v_nieuw := pg_catalog.regexp_replace(v_oud,
      '\mpublic\.can_read_org\(organization_id\)',
      '(organization_id = any ((select public.my_organization_ids())::uuid[]))', 'g');
    v_nieuw := pg_catalog.regexp_replace(v_nieuw,
      '\mpublic\.can_read_module\(organization_id, ''([a-z_]+)''::text\)',
      '(organization_id = any ((select public.my_module_organization_ids(''\1''::text))::uuid[]))', 'g');

    -- b.
    begin
      execute pg_catalog.format('alter policy %I on public.%I using (%s)', r.polname, r.relname, v_nieuw);
    exception when others then
      raise exception 'RLS per query: % op public.% laat zich niet herschrijven: % (%). Nieuwe tekst: %',
        r.polname, r.relname, sqlerrm, sqlstate, v_nieuw;
    end;

    -- c.
    select pg_catalog.pg_get_expr(p.polqual, p.polrelid) into v_terug
    from pg_catalog.pg_policy p where p.oid = r.oid;
    v_terug := pg_catalog.regexp_replace(v_terug,
      '\(organization_id = ANY \(\(\s*SELECT public\.my_organization_ids\(\) AS my_organization_ids\)::uuid\[\]\)\)',
      'public.can_read_org(organization_id)', 'g');
    v_terug := pg_catalog.regexp_replace(v_terug,
      '\(organization_id = ANY \(\(\s*SELECT public\.my_module_organization_ids\(''([a-z_]+)''::text\) AS my_module_organization_ids\)::uuid\[\]\)\)',
      'public.can_read_module(organization_id, ''\1''::text)', 'g');
    if v_terug is distinct from v_oud then
      raise exception 'RLS per query: % op public.% is na herschrijven meer veranderd dan de aanroep. Was: %. Terug: %',
        r.polname, r.relname, v_oud, v_terug;
    end if;

    v_aantal := v_aantal + 1;
  end loop;

  raise notice 'RLS per query: % leespolicies herschreven op % tabellen', v_aantal,
    (select pg_catalog.count(distinct pg_catalog.split_part(x, '.', 1)) from pg_catalog.unnest(v_verwacht) x);
  perform pg_catalog.set_config('search_path', v_pad, true);
end $$;

-- ── 4. attachments: de module hangt van de rij af ───────────────────────────
--
-- Was: attachment_module(entity_type) is null
--      or can_read_module(organization_id, attachment_module(entity_type))
-- Nu:  dezelfde eerste tak, en anders de sleutel "<organisatie>:<module>" in
--      my_readable_module_keys(). attachments.organization_id is NOT NULL
--      (gecontroleerd in stap 3, voor "attachments read"), en in de tweede tak
--      is de module niet null: de vergelijking is dus nooit null.

do $$
declare
  v_def   text := pg_catalog.pg_get_functiondef('public.attachment_module(text)'::pg_catalog.regprocedure);
  v_buiten text;
  v_pad   text := current_setting('search_path');
  v_q     text;
begin
  -- Elke tak van attachment_module geeft een vaste tekst of null, en elke
  -- tekst staat in module_keys(). Anders kent my_readable_module_keys() de
  -- module niet, en zou de bijlage dicht vallen voor wie hem nu wel ziet.
  if v_def !~* '\mthen\s+''' then
    raise exception 'RLS per query: attachment_module heeft een onbekende vorm; pas stap 4 aan.';
  end if;
  -- [\s'] in de lookahead: anders laat \s+ één spatie terug en ziet de
  -- lookahead " null" als iets anders dan null.
  if v_def ~* '\m(then|else)\s+(?![\s'']|null\M)' then
    raise exception 'RLS per query: attachment_module geeft iets anders dan een vaste module of null; pas stap 4 aan.';
  end if;
  select pg_catalog.string_agg(distinct m[2], ', ')
    into v_buiten
  from pg_catalog.regexp_matches(v_def, '\m(then|else)\s+''([^'']*)''', 'gi') as m
  where not (m[2] = any (public.module_keys()));
  if v_buiten is not null then
    raise exception 'RLS per query: attachment_module geeft modules buiten module_keys(): %', v_buiten;
  end if;

  perform pg_catalog.set_config('search_path', '', true);
  select pg_catalog.pg_get_expr(p.polqual, p.polrelid) into v_q
  from pg_catalog.pg_policy p
  where p.polrelid = 'public.attachments'::pg_catalog.regclass and p.polname = 'module gate select';

  if v_q = '((public.attachment_module(entity_type) IS NULL) OR public.can_read_module(organization_id, public.attachment_module(entity_type)))' then
    alter policy "module gate select" on public.attachments using (
      (public.attachment_module(entity_type) is null)
      or (((organization_id)::text || ':' || public.attachment_module(entity_type))
          = any ((select public.my_readable_module_keys())::text[]))
    );
    raise notice 'RLS per query: module gate select op attachments herschreven';
  elsif v_q ~ 'my_readable_module_keys' and v_q !~ 'can_read_module' then
    raise notice 'RLS per query: module gate select op attachments was al herschreven';
  else
    raise exception 'RLS per query: module gate select op attachments heeft een onbekende vorm: %', coalesce(v_q, '(ontbreekt)');
  end if;
  perform pg_catalog.set_config('search_path', v_pad, true);
end $$;

-- ── 5. Na afloop: geen leespolicy rekent nog per rij met de oude vorm ───────

do $$
declare
  v_rest text;
begin
  select pg_catalog.string_agg(pg_catalog.format('%s op %s', p.polname, c.relname), '; ' order by c.relname, p.polname)
    into v_rest
  from pg_catalog.pg_policy p
  join pg_catalog.pg_class c on c.oid = p.polrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and p.polcmd = 'r'
    and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ '\m(can_read_org|can_read_module)\(organization_id[,)]';
  -- Alleen ai_decisions mag hier nog staan: can_read_module(organization_id,
  -- module), met de module uit een kolom.
  if v_rest is distinct from 'ai_decisions read op ai_decisions' then
    raise exception 'RLS per query: deze leespolicies rekenen nog per rij: %', coalesce(v_rest, '(geen; verwacht: ai_decisions read)');
  end if;
end $$;

commit;
