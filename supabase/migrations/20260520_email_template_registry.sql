-- Adds explicit template tracking for Resend-driven quote e-mails.
-- The Edge Functions render templates server-side and pass template_key to Resend tags.

alter table public.quote_email_deliveries
  add column if not exists template_key text not null default 'quote.sent';

create index if not exists idx_quote_email_deliveries_template
  on public.quote_email_deliveries(organization_id, template_key, created_at desc);
