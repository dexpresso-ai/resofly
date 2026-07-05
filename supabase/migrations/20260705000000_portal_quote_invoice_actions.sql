-- ============================================================
-- ResoFly — Klantportaal: offerte goedkeuren/weigeren (native)
-- Date: 2026-07-05
--
-- Scope:
-- - RPC `decide_quote_portal`: laat de INGELOGDE portaalklant een offerte
--   accepteren of weigeren vanuit het portaal zelf (/portal), zonder publieke
--   tokenlink. Spiegelt exact de HUIDIGE accept_quote_public / reject_quote_public:
--   dezelfde status-guards, dezelfde velden, dezelfde events/audit, én — bij
--   accepteren — dezelfde 'client_accepted' versie-snapshot + accepted_sent_version_id,
--   zodat een portaal-acceptatie audit-technisch identiek is aan een acceptatie via
--   de tokenlink. Autoriseert op (quote_id + organization_id) i.p.v. op
--   public_token_hash.
--
-- Beveiliging:
-- - service_role only (net als de publieke varianten). De client-portal edge
--   function draait met de service-role key en heeft de eigendom van de offerte
--   al geverifieerd via het geverifieerde e-mailadres (portal_clients_for_email
--   + assertEntityBelongsToClients) vóór hij deze functie aanroept.
-- - Gebruikt dezelfde event-types ('client_accepted'/'client_rejected') en
--   audit-acties ('quote_client_accepted'/'quote_client_rejected') die al zijn
--   toegestaan door de bestaande check-constraints — geen nieuwe vocabulaire.
--
-- Facturen betalen vanuit het portaal vereist GEEN nieuwe migratie: de
-- client-portal function hergebruikt de bestaande betaal-RPC's
-- (begin_/complete_/fail_invoice_payment_checkout), die al `service_role`
-- toestaan en de klant-actor (auth.users) via created_by/actor_user_id
-- accepteren.
-- ============================================================

begin;

create or replace function public.decide_quote_portal(
  p_quote_id uuid,
  p_organization_id uuid,
  p_kind text,
  p_name text,
  p_email text,
  p_note text default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_version public.quote_versions;
  v_sent_version_id uuid;
  v_kind text := lower(btrim(coalesce(p_kind, '')));
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de klantportaal-service mag portaalbeslissingen verwerken' using errcode = '42501';
  end if;
  if v_kind not in ('accept', 'reject') then
    raise exception 'Ongeldige beslissing: %', p_kind using errcode = '22023';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Offerte niet gevonden' using errcode = '02000';
  end if;

  -- Alleen naar de klant verstuurde, nog niet besliste offertes zijn beslisbaar
  -- (zelfde guard als de publieke accept/reject-RPC's).
  if v_quote.status <> 'sent' then
    raise exception 'Deze offerte kan niet meer worden %',
      case when v_kind = 'accept' then 'geaccepteerd' else 'geweigerd' end
      using errcode = '23514';
  end if;

  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Naam is verplicht om de offerte te beslissen' using errcode = '23514';
  end if;
  if nullif(lower(trim(coalesce(p_email, ''))), '') is null
     or lower(trim(coalesce(p_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht om de offerte te beslissen' using errcode = '23514';
  end if;

  if v_kind = 'accept' then
    -- Spiegelt de HUIDIGE accept_quote_public: vereist een verzonden versie, legt de
    -- acceptatie vast als 'client_accepted' version-snapshot (zet accepted_version_id)
    -- en koppelt accepted_sent_version_id — zodat portaal- en tokenlink-acceptatie
    -- identieke provenance opleveren.
    if v_quote.sent_version_id is null then
      raise exception 'Deze offerte mist een verzonden versie en kan niet worden geaccepteerd' using errcode = '23514';
    end if;
    if v_quote.valid_until is not null and v_quote.valid_until < current_date then
      raise exception 'Deze offerte is verlopen en kan niet meer worden geaccepteerd' using errcode = '23514';
    end if;

    v_sent_version_id := v_quote.sent_version_id;

    update public.quotes
    set status = 'accepted',
        accepted_at = now(),
        client_decision_at = now(),
        client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
        client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
        client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
        accepted_sent_version_id = v_sent_version_id,
        updated_at = now()
    where id = v_quote.id
    returning * into v_quote;

    v_version := public.create_quote_version_snapshot(
      v_quote.id,
      v_quote.organization_id,
      'client_accepted',
      null,
      null,
      v_quote.last_pdf_file_name,
      v_quote.last_pdf_mime_type,
      v_quote.last_pdf_size_bytes,
      v_quote.last_pdf_sha256,
      null,
      jsonb_build_object('clientDecisionName', p_name, 'clientDecisionEmail', p_email, 'acceptedSentVersionId', v_sent_version_id, 'source', 'client_portal')
    );

    perform public.insert_quote_workflow_event(
      v_quote.organization_id, v_quote.id, 'client_accepted',
      'Klant heeft de offerte geaccepteerd', nullif(trim(coalesce(p_note, '')), ''),
      jsonb_build_object('name', p_name, 'email', p_email, 'acceptedVersionId', v_version.id, 'acceptedSentVersionId', v_sent_version_id, 'source', 'client_portal'), null);
    perform public.insert_quote_audit_event(
      v_quote.organization_id, v_quote.id, 'quote_client_accepted', v_quote.number,
      jsonb_build_object('name', p_name, 'email', p_email, 'acceptedVersionId', v_version.id, 'acceptedSentVersionId', v_sent_version_id, 'source', 'client_portal'), null);
  else
    update public.quotes
    set status = 'rejected',
        client_decision_at = now(),
        client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
        client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
        client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
        updated_at = now()
    where id = v_quote.id
    returning * into v_quote;

    perform public.insert_quote_workflow_event(
      v_quote.organization_id, v_quote.id, 'client_rejected',
      'Klant heeft de offerte geweigerd', nullif(trim(coalesce(p_note, '')), ''),
      jsonb_build_object('name', p_name, 'email', p_email, 'source', 'client_portal'), null);
    perform public.insert_quote_audit_event(
      v_quote.organization_id, v_quote.id, 'quote_client_rejected', v_quote.number,
      jsonb_build_object('name', p_name, 'email', p_email, 'source', 'client_portal'), null);
  end if;

  -- Verse rij teruggeven: create_quote_version_snapshot heeft o.a. accepted_version_id
  -- op de offerte gezet ná de eerste UPDATE ... returning.
  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id;

  return v_quote;
end;
$$;

revoke execute on function public.decide_quote_portal(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.decide_quote_portal(uuid, uuid, text, text, text, text) to service_role;

commit;
