-- ============================================================
-- ResoFly — Bonnen fotograferen en declaraties
-- Date: 2026-11-18
--
-- WAAROM
-- Een bon (kassabon, parkeerbon, tankbon) kwam tot nu toe alleen in de
-- boekhouding via "Factuur scannen": uploaden, uitlezen, voorstel bekijken,
-- overnemen, opslaan. Of je mailde hem naar het factuuradres. Nu fotografeer
-- je hem in de app: Gerrie leest hem uit en hij staat meteen als
-- concept-inkoopfactuur klaar, met de foto als bewijsstuk.
--
-- Teamleden zonder Financiën doen hetzelfde, en dan heet het een declaratie.
-- Zij zien alleen hun eigen declaraties; iemand die Financiën mag bewerken
-- keurt goed (boekt het concept) of wijst af, met een reden.
--
-- ONTWERPKEUZES
-- 1. Geen nieuwe werklijst. Een bon is een item in purchase_invoice_inbox,
--    net als een mail op het factuuradres: dezelfde verwerking (uitlezen,
--    leverancier, dubbelcontrole, concept met bewijsstuk), dezelfde
--    opruimronde en dezelfde realtime. `channel` zegt waar hij vandaan komt.
-- 2. `submitted_by` is wie de foto maakte. De edge function invoice-inbox zet
--    hem uit de geverifieerde sessie, nooit uit de invoer.
-- 3. Een declarant komt niet in de inbox zelf: die blijft achter de module
--    Financiën (RLS en de restrictive gate). Wat hij van zijn eigen
--    declaraties mag zien, geeft list_my_declarations: alleen zijn eigen rijen,
--    en alleen de velden over zijn eigen bon. Geen waarschuwingen (die noemen
--    soms een andere factuur of het IBAN dat bij een leverancier bekend is),
--    geen ids van concepten of leveranciers, niets van een ander teamlid.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Kanaal, indiener en de reden van een afwijzing
-- ------------------------------------------------------------
alter table public.purchase_invoice_inbox
  add column if not exists channel text not null default 'email',
  add column if not exists submitted_by uuid references auth.users(id) on delete set null,
  add column if not exists review_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_invoice_inbox_channel_check') then
    alter table public.purchase_invoice_inbox
      add constraint purchase_invoice_inbox_channel_check check (channel in ('email', 'receipt', 'declaration'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchase_invoice_inbox_review_note_length') then
    alter table public.purchase_invoice_inbox
      add constraint purchase_invoice_inbox_review_note_length check (review_note is null or length(review_note) <= 1000);
  end if;
end $$;

comment on column public.purchase_invoice_inbox.channel is
  'email = binnengekomen op het factuuradres; receipt = een bon die iemand met Financiën in de app fotografeerde; declaration = een bon van een teamlid zonder Financiën (declaratie).';
comment on column public.purchase_invoice_inbox.submitted_by is
  'Wie de bon in de app instuurde (receipt/declaration). Gezet door de edge function uit de sessie; leeg bij mail.';
comment on column public.purchase_invoice_inbox.review_note is
  'Waarom een declaratie is afgewezen. De indiener leest dit via list_my_declarations.';

-- Mijn declaraties, nieuwste eerst; en de limiet op het aantal bonnen per uur.
create index if not exists idx_purchase_invoice_inbox_submitter
  on public.purchase_invoice_inbox (organization_id, submitted_by, received_at desc)
  where submitted_by is not null;

-- ------------------------------------------------------------
-- 2. Een datum uit het voorstel, of niets
--    Het voorstel is jsonb uit een uitlezing. Een cast van "2026-02-30" gooit,
--    en dan zou één rare bon de hele lijst van de indiener breken.
-- ------------------------------------------------------------
create or replace function public.inbox_text_to_date(p_value text)
returns date
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p_value::date;
exception when others then
  return null;
end;
$$;

revoke all on function public.inbox_text_to_date(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Mijn declaraties
--    Alleen de ingelogde gebruiker zelf, in een organisatie waar hij actief
--    lid is. De status is in gewone woorden: wordt uitgelezen, ingediend,
--    goedgekeurd, uitbetaald of afgewezen. Een item dat bij Financiën op een
--    keuze wacht (dubbel, leverancier onbekend, mislukt) is voor de indiener
--    gewoon "ingediend": wat daar speelt, gaat over de administratie.
-- ------------------------------------------------------------
create or replace function public.list_my_declarations(p_organization_id uuid)
returns table (
  id uuid,
  status text,
  submitted_at timestamptz,
  store_name text,
  receipt_date date,
  total_cents bigint,
  currency text,
  file_name text,
  review_note text,
  decided_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id and m.user_id = v_user and m.status = 'active'
  ) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  return query
    select i.id,
           (case
              when i.status in ('received', 'processing') then 'processing'
              when i.status = 'rejected' then 'rejected'
              when pi.status = 'paid' or pi.payment_status = 'paid' then 'paid'
              when i.status = 'booked' or pi.status = 'booked' then 'approved'
              else 'submitted'
            end)::text,
           i.received_at,
           nullif(btrim(coalesce(i.proposal -> 'supplier' ->> 'name', '')), '')::text,
           coalesce(pi.date, public.inbox_text_to_date(i.proposal ->> 'date')),
           coalesce(
             pi.total_cents,
             case when (i.proposal -> 'totals' ->> 'total_cents') ~ '^-?\d{1,15}$'
                  then (i.proposal -> 'totals' ->> 'total_cents')::bigint end),
           upper(coalesce(nullif(btrim(pi.currency), ''), nullif(btrim(i.proposal ->> 'currency'), ''), 'EUR'))::text,
           (i.attachments -> 0 ->> 'name')::text,
           (case when i.status = 'rejected' then i.review_note end)::text,
           case when i.status in ('booked', 'rejected') then i.handled_at end
      from public.purchase_invoice_inbox i
      left join public.purchase_invoices pi
        on pi.id = i.purchase_invoice_id and pi.organization_id = i.organization_id
     where i.organization_id = p_organization_id
       and i.submitted_by = v_user
       and i.channel = 'declaration'
       and i.status <> 'dropped'
     order by i.received_at desc
     limit 200;
end;
$$;

revoke all on function public.list_my_declarations(uuid) from public, anon;
grant execute on function public.list_my_declarations(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. Boeken is goedkeuren: onthoud wie en wanneer
--    Zelfde trigger als in 20260918010000, met één toevoeging: wie het concept
--    boekt, staat als handled_by op het inbox-item, met het moment erbij. Bij
--    een declaratie is dat de goedkeuring die de indiener te zien krijgt.
--    Eerder bleef handled_at leeg als iemand vanuit de lijst op Boeken klikte.
-- ------------------------------------------------------------
create or replace function public.purchase_invoice_inbox_sync_from_invoice()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if TG_OP = 'DELETE' then
      update public.purchase_invoice_inbox
         set status = 'needs_review', reason = 'draft_deleted', purchase_invoice_id = null
       where purchase_invoice_id = old.id and status in ('ready', 'booked');
      return old;
    end if;
    if new.status in ('booked', 'paid') and old.status is distinct from new.status then
      update public.purchase_invoice_inbox
         set status = 'booked',
             handled_by = coalesce(auth.uid(), handled_by),
             handled_at = now()
       where purchase_invoice_id = new.id and status = 'ready';
    elsif new.status = 'cancelled' and old.status is distinct from new.status then
      update public.purchase_invoice_inbox
         set status = 'needs_review', reason = 'draft_cancelled'
       where purchase_invoice_id = new.id and status in ('ready', 'booked');
    end if;
  exception when others then
    raise warning 'purchase_invoice_inbox_sync_from_invoice: %', sqlerrm;
  end;
  return coalesce(new, old);
end; $$;

revoke all on function public.purchase_invoice_inbox_sync_from_invoice() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Meldingen: push-type 'declaration'
--    De volledige lijst uit 20261017000000, plus 'declaration'. Het type moet
--    ook in PushEventType + PUSH_EVENTS (src/lib/push-api.ts) en in
--    NOTIFICATION_EVENTS (actions/admin.ts) staan, anders kan niemand hem
--    uitzetten.
-- ------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select conname, conrelid::regclass as tbl
      from pg_constraint
     where contype = 'c'
       and conrelid in ('public.notification_outbox'::regclass, 'public.notification_preferences'::regclass)
       and pg_get_constraintdef(oid) like '%event_type%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table public.notification_outbox add constraint notification_outbox_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest','mcp_proposal','purchase_invoice_inbox','file_transfer_downloaded','agent_run','declaration'));
alter table public.notification_preferences add constraint notification_preferences_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest','mcp_proposal','purchase_invoice_inbox','file_transfer_downloaded','agent_run','declaration'));

-- De melding per inbox-item. Mail werkt precies als in 20260918010000. Nieuw:
--  - een bon die iemand met Financiën zelf fotografeert: geen melding, hij
--    ziet de uitkomst al op zijn scherm;
--  - een declaratie: één melding aan wie Financiën mag BEWERKEN (die keurt
--    goed), niet aan de indiener zelf; en bij goedkeuren of afwijzen één
--    melding aan de indiener, en alleen aan hem. De ontvangers komen uit de
--    rij en uit organization_members, nooit van een aanroeper.
create or replace function public.push_on_purchase_invoice_inbox()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_title text;
  v_body text;
  v_supplier text;
  v_total bigint;
  v_amount text;
  v_reason text;
  v_who text;
  v_tag text;
begin
  begin
    if coalesce(new.channel, 'email') = 'receipt' then return new; end if;

    v_total := case when (new.proposal -> 'totals' ->> 'total_cents') ~ '^-?\d{1,15}$'
                    then (new.proposal -> 'totals' ->> 'total_cents')::bigint end;
    v_amount := case when v_total is not null
      then ' · € ' || regexp_replace((v_total / 100)::text, '(\d)(?=(\d{3})+$)', '\1.', 'g')
           || ',' || lpad((abs(v_total) % 100)::text, 2, '0')
      else '' end;

    if new.channel = 'declaration' then
      v_supplier := coalesce(nullif(btrim(new.proposal -> 'supplier' ->> 'name'), ''), 'Bon');
      v_who := coalesce(nullif(btrim(new.sender_name), ''), nullif(btrim(new.sender_email), ''), 'Een teamlid');
      v_tag := 'declaration:' || new.id::text;

      -- Beslist: alleen de indiener hoort het.
      if TG_OP = 'UPDATE' and new.submitted_by is not null then
        if new.status is distinct from old.status and new.status = 'booked' then
          perform public.push_enqueue(
            new.organization_id, 'declaration', array[new.submitted_by],
            jsonb_build_object('title', 'Declaratie goedgekeurd', 'body', v_supplier || v_amount, 'url', '/', 'tag', v_tag));
        elsif new.status is distinct from old.status and new.status = 'rejected' and new.reason = 'declaration_declined' then
          perform public.push_enqueue(
            new.organization_id, 'declaration', array[new.submitted_by],
            jsonb_build_object('title', 'Declaratie afgewezen',
              'body', v_supplier || v_amount || coalesce(' — ' || nullif(btrim(new.review_note), ''), ''),
              'url', '/', 'tag', v_tag));
        end if;
      end if;

      -- Ingediend: één keer, aan wie Financiën mag bewerken.
      if new.status in ('ready', 'needs_review', 'duplicate', 'failed') and new.notified_at is null then
        new.notified_at := now();
        perform public.push_enqueue(
          new.organization_id, 'declaration',
          array(
            select m.user_id from public.organization_members m
             where m.organization_id = new.organization_id
               and m.status = 'active'
               and m.user_id is distinct from new.submitted_by
               and (m.role in ('owner', 'admin')
                    or (m.role = 'member' and coalesce(nullif(m.module_access ->> 'finance', ''), 'write') = 'write'))),
          jsonb_build_object(
            'title', case when new.status = 'ready' then 'Declaratie ingediend' else 'Declaratie vraagt aandacht' end,
            'body', v_who || ' · ' || v_supplier || v_amount,
            'url', '/', 'tag', v_tag));
      end if;
      return new;
    end if;

    -- Mail op het factuuradres: ongewijzigd.
    if new.status not in ('ready', 'booked', 'needs_review', 'duplicate') then return new; end if;
    if new.notified_at is not null then return new; end if;
    new.notified_at := now();

    v_supplier := coalesce(
      nullif(new.proposal->'supplier'->>'name', ''),
      nullif(new.sender_name, ''), nullif(new.sender_email, ''), 'Onbekende afzender');
    v_reason := case new.reason
      when 'supplier_unknown' then 'leverancier onbekend'
      when 'no_attachment' then 'geen bijlage gevonden'
      when 'nothing_extracted' then 'geen factuur herkend'
      when 'ai_unavailable' then 'AI niet beschikbaar'
      when 'budget_exhausted' then 'AI-tegoed op'
      when 'rate_limited' then 'ongewoon veel post tegelijk'
      when 'extraction_failed' then 'uitlezen mislukt'
      else coalesce(new.reason, '') end;

    v_title := case new.status
      when 'ready' then 'Inkoopfactuur klaargezet'
      when 'booked' then 'Inkoopfactuur geboekt'
      when 'duplicate' then 'Dubbele inkoopfactuur'
      else 'Inkoopfactuur vraagt aandacht' end;
    v_body := v_supplier || v_amount
      || case when new.status = 'needs_review' and v_reason <> '' then ' — ' || v_reason else '' end;

    perform public.push_enqueue(
      new.organization_id, 'purchase_invoice_inbox',
      public.push_module_member_ids(new.organization_id, 'finance'),
      jsonb_build_object('title', v_title, 'body', v_body, 'url', '/',
                         'tag', 'purchase-inbox:' || new.id::text));
  exception when others then
    raise warning 'push_on_purchase_invoice_inbox: %', sqlerrm;
  end;
  return new;
end; $$;

revoke all on function public.push_on_purchase_invoice_inbox() from public, anon, authenticated;

commit;
