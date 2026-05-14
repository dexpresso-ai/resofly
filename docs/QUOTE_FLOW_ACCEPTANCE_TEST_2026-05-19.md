# Quote flow acceptance test — PDF attachment + version snapshots

## Scope
This test plan verifies the hardened quote flow after the 20260519 migration.

Covered:
- Server-side PDF attachment via Resend
- Immutable quote version snapshots
- Rich snapshot context: quote lines, client, project, company settings, delivery
- Explicit acceptance link to the exact sent quote version
- Required Resend provider email id before a delivery can become `sent`

Out of scope:
- Physical PDF persistence in R2/Supabase Storage. That is planned later.

## Pre-conditions
1. Run all migrations through `20260519_quote_versions_audit_context_hardening.sql`.
2. Configure Supabase Edge Function secrets:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `RESEND_API_KEY`
   - `RESEND_FROM_EMAIL`
   - `QUOTE_PUBLIC_BASE_URL` or `APP_PUBLIC_URL`
   - `QUOTE_ALLOWED_ORIGINS` / `QUOTE_PUBLIC_ALLOWED_ORIGINS`
3. Configure the Resend webhook function separately if delivery/open/click events are tested.

## Happy path

### 1. Create quote
- Create a quote with a client, optional project, at least one line item, and a valid `valid_until`.
- Expected: quote starts in draft/concept state.

### 2. Submit and internally approve
- Submit the quote for internal approval.
- Approve as organization owner/admin.
- Expected database result:
  - `quotes.status = 'internally_approved'`
  - `quotes.internal_approval_status = 'approved'`
  - `quotes.internal_approved_version_id` is filled
  - `quote_versions.snapshot_reason = 'internal_approval'`
  - `quote_versions.snapshot_data` contains:
    - `quote`
    - `quoteLines`
    - `clientSnapshot`
    - `projectSnapshot`
    - `companySnapshot`
    - `totals`
- Expected: no PDF metadata is required or written for this internal approval snapshot.

### 3. Send quote through Resend
- Trigger `quote-workflow` with action `sendQuoteEmail`.
- Expected Edge Function behavior:
  - Loads quote/client/project/company server-side.
  - Generates PDF server-side.
  - Validates filename, MIME type, positive size and SHA-256.
  - Sends email through Resend with attachment.
  - Requires a non-empty Resend provider email id before finalizing.
- Expected database result:
  - `quote_email_deliveries.status = 'sent'`
  - `quote_email_deliveries.provider_email_id` is not empty
  - `quote_email_deliveries.attachment_*` fields are filled
  - `quotes.status = 'sent'`
  - `quotes.sent_version_id` is filled
  - `quote_versions.snapshot_reason = 'sent_to_client'`
  - sent snapshot contains `deliverySnapshot`, `clientSnapshot`, `projectSnapshot`, `companySnapshot` and PDF metadata.

### 4. Accept quote publicly
- Open the public quote link and accept with name + email.
- Expected database result:
  - `quotes.status = 'accepted'`
  - `quotes.accepted_version_id` is filled
  - `quotes.accepted_sent_version_id = quotes.sent_version_id`
  - `quote_versions.snapshot_reason = 'client_accepted'`
  - accepted snapshot has `accepted_sent_version_id` filled
  - accepted snapshot `snapshot_data.acceptedSentVersionId` matches the sent version id
  - accepted snapshot `snapshot_data.sentVersionSnapshot.pdfSha256` matches the sent PDF hash

## Negative tests

### Missing provider email id
Simulate a successful Resend HTTP response without `id` or `email_id`.

Expected:
- Edge Function calls `fail_quote_email_send`.
- Delivery is not finalized as `sent`.
- `complete_quote_email_send` refuses empty provider id.

### Accept quote without sent version
Manually create a malformed quote with status `sent` but no `sent_version_id`.

Expected:
- `accept_quote_public` rejects with: `Deze offerte mist een verzonden versie en kan niet worden geaccepteerd`.

### Changed live client/project/company after send
After sending, change the live client name or company settings.

Expected:
- Existing `quote_versions.snapshot_data.clientSnapshot`, `projectSnapshot` and `companySnapshot` remain unchanged.
- A newly generated live quote view may show current data, but historical snapshot evidence remains frozen.

## SQL inspection helpers

```sql
select
  q.id,
  q.number,
  q.status,
  q.sent_version_id,
  q.accepted_version_id,
  q.accepted_sent_version_id
from public.quotes q
where q.number = '<QUOTE_NUMBER>';
```

```sql
select
  version_number,
  snapshot_reason,
  accepted_sent_version_id,
  pdf_file_name,
  pdf_sha256,
  snapshot_data ? 'clientSnapshot' as has_client_snapshot,
  snapshot_data ? 'projectSnapshot' as has_project_snapshot,
  snapshot_data ? 'companySnapshot' as has_company_snapshot,
  snapshot_data ? 'sentVersionSnapshot' as has_sent_version_snapshot
from public.quote_versions
where quote_id = '<QUOTE_ID>'
order by version_number;
```
