-- ============================================================
-- ResoFly — Invoice workflow runtime hardening
-- Date: 2026-05-26
--
-- Fixes:
-- - Always rotate/save the public invoice token for newly generated payment links.
-- - Backfill invoice public token hash from existing mock/public checkout URLs.
-- - Make payment checkout completion create a payment snapshot.
-- - Make Mollie/payment webhooks idempotent: no duplicate paid snapshots/audit events.
-- ============================================================

create extension if not exists pgcrypto;

begin;

create or replace function public.begin_invoice_payment_checkout(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_amount_cents integer,
  p_public_token_hash text default null,
  p_public_token_expires_at timestamptz default null,
  p_currency text default 'EUR',
  p_idempotency_key text default null,
  p_checkout_expires_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_existing public.invoice_payment_records;
  v_payment public.invoice_payment_records;
  v_public_token_hash text := nullif(btrim(coalesce(p_public_token_hash, '')), '');
  v_existing_token text;
begin
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Factuur niet gevonden.' using errcode = '02000';
  end if;

  if v_invoice.status = 'paid' then
    raise exception 'Deze factuur is al betaald.' using errcode = '23514';
  end if;

  if p_amount_cents <= 0 then
    raise exception 'Factuurbedrag moet groter zijn dan 0.' using errcode = '23514';
  end if;

  -- A payment checkout must always have a recoverable public token. Because the
  -- raw token cannot be reconstructed from public_token_hash, every newly
  -- created checkout may intentionally rotate the public token hash.
  if v_public_token_hash is not null then
    update public.invoices
       set public_token_hash = v_public_token_hash,
           public_token_created_at = now(),
           public_token_expires_at = coalesce(p_public_token_expires_at, now() + interval '60 days'),
           updated_at = now()
     where id = v_invoice.id
       and organization_id = p_organization_id
       and (
         public_token_hash is null
         or public_token_hash <> v_public_token_hash
         or coalesce(public_token_expires_at, now() - interval '1 second') < now()
       )
     returning * into v_invoice;

    if found then
      perform public.insert_invoice_workflow_event(
        p_organization_id,
        p_invoice_id,
        'public_token_created',
        'Publieke factuurlink aangemaakt',
        'Veilige factuurlink klaargezet voor de betaallink.',
        jsonb_build_object('expires_at', coalesce(p_public_token_expires_at, now() + interval '60 days')),
        p_actor_user_id
      );
    end if;
  end if;

  -- Reuse only usable checkout records. Old staging records sometimes had only
  -- the app base URL as checkout URL; those are intentionally ignored here.
  select * into v_existing
  from public.invoice_payment_records p
  where p.organization_id = p_organization_id
    and p.invoice_id = p_invoice_id
    and p.status in ('open','pending','authorized')
    and p.provider_checkout_url is not null
    and (p.checkout_expires_at is null or p.checkout_expires_at > now())
    and (
      (
        coalesce(p.provider_payment_id, '') like 'mock_invoice_payment_%'
        and p.provider_checkout_url ~ '/invoice/([^?/#]+)'
        and public.invoice_token_hash(substring(p.provider_checkout_url from '/invoice/([^?/#]+)')) = v_invoice.public_token_hash
      )
      or (
        coalesce(p.provider_payment_id, '') <> ''
        and coalesce(p.provider_payment_id, '') not like 'mock_invoice_payment_%'
        and p.provider_checkout_url !~ '/invoice/([^?/#]+)'
      )
    )
  order by p.created_at desc
  limit 1;

  if found then
    return v_existing;
  end if;

  begin
    insert into public.invoice_payment_records(
      organization_id,
      invoice_id,
      created_by,
      amount_cents,
      currency,
      status,
      idempotency_key,
      checkout_expires_at,
      metadata
    ) values (
      p_organization_id,
      p_invoice_id,
      p_actor_user_id,
      p_amount_cents,
      upper(coalesce(nullif(btrim(p_currency), ''), 'EUR')),
      'open',
      nullif(btrim(coalesce(p_idempotency_key, '')), ''),
      p_checkout_expires_at,
      coalesce(p_metadata, '{}'::jsonb)
    ) returning * into v_payment;
  exception when unique_violation then
    select * into v_payment
    from public.invoice_payment_records
    where organization_id = p_organization_id
      and invoice_id = p_invoice_id
      and idempotency_key = nullif(btrim(coalesce(p_idempotency_key, '')), '')
    order by created_at desc
    limit 1
    for update;

    if not found then
      raise;
    end if;
  end;

  return v_payment;
end;
$$;

create or replace function public.complete_invoice_payment_checkout(
  p_payment_record_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_provider_payment_id text,
  p_provider_checkout_url text,
  p_status text default 'open',
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.invoice_payment_records;
  v_invoice public.invoices;
  v_public_token text;
  v_version public.invoice_versions;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  update public.invoice_payment_records
     set provider_payment_id = nullif(btrim(p_provider_payment_id), ''),
         provider_checkout_url = nullif(btrim(p_provider_checkout_url), ''),
         status = coalesce(nullif(btrim(p_status), ''), 'open'),
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         updated_at = now()
   where id = p_payment_record_id
     and organization_id = p_organization_id
   returning * into v_payment;

  if not found then
    raise exception 'Payment record niet gevonden.' using errcode = '02000';
  end if;

  select * into v_invoice
  from public.invoices
  where id = v_payment.invoice_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Factuur niet gevonden bij payment record.' using errcode = '02000';
  end if;

  v_public_token := substring(coalesce(p_provider_checkout_url, '') from '/invoice/([^?/#]+)');

  if v_public_token is not null and btrim(v_public_token) <> '' then
    update public.invoices
       set public_token_hash = public.invoice_token_hash(v_public_token),
           public_token_created_at = coalesce(public_token_created_at, now()),
           public_token_expires_at = coalesce(public_token_expires_at, now() + interval '60 days'),
           updated_at = now()
     where id = v_payment.invoice_id
       and organization_id = p_organization_id
       and (
         public_token_hash is null
         or public_token_hash <> public.invoice_token_hash(v_public_token)
       )
     returning * into v_invoice;
  end if;

  v_version := public.create_invoice_version_snapshot(
    v_payment.invoice_id,
    p_organization_id,
    'payment_created',
    p_actor_user_id,
    null,
    v_payment.id,
    null,
    null,
    null,
    null,
    null,
    jsonb_build_object('provider_payment_id', v_payment.provider_payment_id, 'checkout_url_created', v_payment.provider_checkout_url is not null)
  );

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_payment.invoice_id,
    'payment_link_created',
    'Mollie-betaallink aangemaakt',
    'Betaallink klaar voor factuurbetaling.',
    jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', v_payment.provider_payment_id, 'version_id', v_version.id),
    p_actor_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id,
    p_actor_user_id,
    'invoice_payment_link_created',
    'invoice',
    v_invoice.id,
    v_invoice.number,
    jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', v_payment.provider_payment_id, 'version_id', v_version.id)
  );

  return v_payment;
end;
$$;

create or replace function public.update_invoice_payment_status(
  p_provider_payment_id text,
  p_status text,
  p_paid_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.invoice_payment_records;
  v_previous_status text;
  v_invoice public.invoices;
  v_event_type text;
  v_title text;
  v_status_changed boolean;
begin
  select * into v_payment
  from public.invoice_payment_records
  where provider = 'mollie'
    and provider_payment_id = p_provider_payment_id
  for update;

  if not found then
    raise exception 'Payment record niet gevonden voor provider-payment-id.' using errcode = '02000';
  end if;

  v_previous_status := v_payment.status;
  v_status_changed := v_previous_status is distinct from p_status;

  update public.invoice_payment_records
     set status = p_status,
         paid_at = case when p_status = 'paid' then coalesce(v_payment.paid_at, p_paid_at, now()) else paid_at end,
         last_webhook_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         updated_at = now()
   where id = v_payment.id
   returning * into v_payment;

  select * into v_invoice
  from public.invoices
  where id = v_payment.invoice_id and organization_id = v_payment.organization_id
  for update;

  if not found then
    raise exception 'Factuur niet gevonden bij payment record.' using errcode = '02000';
  end if;

  if p_status = 'paid' then
    update public.invoices
       set status = 'paid',
           paid_at = coalesce(v_invoice.paid_at, v_payment.paid_at, now()),
           updated_at = now()
     where id = v_invoice.id
     returning * into v_invoice;

    if v_previous_status is distinct from 'paid' then
      perform public.create_invoice_version_snapshot(
        v_invoice.id,
        v_invoice.organization_id,
        'paid',
        null,
        null,
        v_payment.id,
        v_invoice.last_pdf_file_name,
        v_invoice.last_pdf_mime_type,
        v_invoice.last_pdf_size_bytes,
        v_invoice.last_pdf_sha256,
        null,
        jsonb_build_object('provider_payment_id', p_provider_payment_id)
      );
    end if;
  end if;

  v_event_type := case
    when p_status = 'paid' then 'payment_paid'
    when p_status = 'expired' then 'payment_expired'
    when p_status in ('failed','canceled') then 'payment_failed'
    else 'payment_open'
  end;
  v_title := case
    when p_status = 'paid' then 'Factuur betaald'
    when p_status = 'expired' then 'Betaallink verlopen'
    when p_status in ('failed','canceled') then 'Betaling mislukt'
    else 'Betaalstatus bijgewerkt'
  end;

  if v_status_changed or p_status = 'paid' then
    perform public.insert_invoice_workflow_event(
      v_invoice.organization_id,
      v_invoice.id,
      v_event_type,
      v_title,
      'Mollie status: ' || p_status,
      jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id, 'previous_status', v_previous_status, 'status', p_status),
      null
    );
  end if;

  if p_status = 'paid' and v_previous_status is distinct from 'paid' then
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (v_invoice.organization_id, null, 'invoice_paid', 'invoice', v_invoice.id, v_invoice.number, jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id));
  end if;

  return v_payment;
end;
$$;

-- Repair existing staging/public mock URLs by extracting /invoice/<token> and storing the matching hash.
with extracted_tokens as (
  select
    i.id as invoice_id,
    i.organization_id,
    substring(p.provider_checkout_url from '/invoice/([^?/#]+)') as public_token
  from public.invoice_payment_records p
  join public.invoices i
    on i.id = p.invoice_id
   and i.organization_id = p.organization_id
  where p.provider_checkout_url is not null
    and p.provider_checkout_url like '%/invoice/%'
)
update public.invoices i
   set public_token_hash = public.invoice_token_hash(e.public_token),
       public_token_created_at = coalesce(i.public_token_created_at, now()),
       public_token_expires_at = coalesce(i.public_token_expires_at, now() + interval '60 days'),
       updated_at = now()
from extracted_tokens e
where e.invoice_id = i.id
  and e.organization_id = i.organization_id
  and e.public_token is not null
  and btrim(e.public_token) <> ''
  and (
    i.public_token_hash is null
    or i.public_token_hash <> public.invoice_token_hash(e.public_token)
  );

commit;
