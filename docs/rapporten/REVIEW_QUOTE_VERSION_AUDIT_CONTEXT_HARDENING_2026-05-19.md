# Review: quote versions audit context hardening — 2026-05-19

## Summary
Implemented review improvements 2 through 5 for the quote PDF/versioning flow.

PDF persistence in R2/Supabase Storage was intentionally not implemented yet.

## Changes

### 1. Richer quote snapshots
`create_quote_version_snapshot` now freezes more context in `snapshot_data`:

- `quote`
- `quoteLines`
- `clientSnapshot`
- `projectSnapshot`
- `companySnapshot`
- `deliverySnapshot`
- `sentVersionSnapshot` for accepted quotes
- `acceptedSentVersionId`
- totals, PDF metadata and workflow metadata

This prevents historical evidence from silently changing when live client/project/company settings are edited later.

### 2. Acceptance is explicitly linked to the sent version
Added:

- `quote_versions.accepted_sent_version_id`
- `quotes.accepted_sent_version_id`

`accept_quote_public` now refuses acceptance if the quote does not have a `sent_version_id`.
The accepted snapshot stores and returns the sent version reference.

### 3. Resend provider id is mandatory
`complete_quote_email_send` now refuses to mark a delivery as `sent` without a non-empty Resend provider email id.

The Edge Function also checks the Resend response before calling the completion RPC. If Resend returns 2xx without an email id, the delivery is marked failed instead of creating weak audit data.

### 4. Production test document added
Added:

- `docs/QUOTE_FLOW_ACCEPTANCE_TEST_2026-05-19.md`

This documents the happy path and negative tests for the hardened quote flow.

## Migration
Added:

- `supabase/migrations/20260519_quote_versions_audit_context_hardening.sql`

Also appended to:

- `supabase/schema.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`

## Remaining future improvement
Physical PDF persistence is still outstanding:

- private R2 key
- immutable stored PDF object
- hash validation at upload/download
- signed download URL from app
