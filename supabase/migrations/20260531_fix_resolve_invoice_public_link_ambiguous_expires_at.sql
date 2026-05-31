-- ============================================================
-- Fix: resolve_invoice_public_link — "column reference expires_at is ambiguous"
-- Date: 2026-05-31
--
-- The RETURNS TABLE(... expires_at timestamptz) declares an OUT column that is
-- in scope as a PL/pgSQL variable. In the `select ... into v_link` query the
-- bare `expires_at` could refer to either that OUT variable or the
-- invoice_public_links.expires_at column, so Postgres raised 42702.
--
-- Fix: qualify the column reference with the table name. Function body is
-- otherwise unchanged.
-- ============================================================

begin;

create or replace function public.resolve_invoice_public_link(p_token text, p_touch boolean default true)
returns table(
  link_id uuid,
  organization_id uuid,
  invoice_id uuid,
  purpose text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := public.invoice_token_hash(p_token);
  v_link public.invoice_public_links;
  v_invoice public.invoices;
begin
  if nullif(btrim(coalesce(p_token, '')), '') is null then
    return;
  end if;

  select * into v_link
  from public.invoice_public_links
  where token_hash = v_hash
    and status = 'active'
    and revoked_at is null
    and (invoice_public_links.expires_at is null or invoice_public_links.expires_at > now())
  order by created_at desc
  limit 1;

  if found then
    if p_touch then
      update public.invoice_public_links
         set last_viewed_at = now(), view_count = view_count + 1, updated_at = now()
       where id = v_link.id;
    end if;
    return query select v_link.id, v_link.organization_id, v_link.invoice_id, v_link.purpose, v_link.expires_at;
    return;
  end if;

  -- Legacy fallback only for old links that existed before invoice_public_links.
  select * into v_invoice
  from public.invoices
  where public_token_hash = v_hash
    and (public_token_expires_at is null or public_token_expires_at > now())
  limit 1;

  if found then
    return query select null::uuid, v_invoice.organization_id, v_invoice.id, 'invoice_view'::text, v_invoice.public_token_expires_at;
  end if;
end;
$$;

commit;
