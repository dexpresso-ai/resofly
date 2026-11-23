-- ════════════════════════════════════════════════════════════════════════════
-- ResoFly — Het bewijsstuk van een geboekt of verstuurd document ligt vast
-- ════════════════════════════════════════════════════════════════════════════
--
-- Controle boekhouder van 22 november 2026, bevinding 3. Het scherm toont geen
-- Verwijderen-knop bij een geboekte inkoopfactuur en Gerrie weigert, maar de
-- database bewaakte bijlagen zelf niet: met de eigen sessie gaf
-- `DELETE /rest/v1/attachments?id=eq.<bon>` 200 en was de bon weg, en een PATCH
-- met een andere storage_key liet het bewijsstuk naar een ander bestand wijzen.
-- Het bestand zelf was via de media-worker te wissen.
--
-- Nu dezelfde regel als het scherm en Gerrie, in de database: een bijlage ligt
-- vast zodra het document waar hij aan hangt geen concept meer is.
--
--   offerte        verstuurd of geen concept meer
--   factuur        verstuurd, geboekt of geen concept meer
--   inkoopfactuur  geen concept meer (geboekt, betaald, geannuleerd)
--   activum        de aanschaf is geboekt of er is afgeschreven
--
-- Wat blijft kunnen: een bijlage toevoegen (ook een tweede bij een geboekte
-- inkoopfactuur) en alles aan een concept. Is het bewijsstuk verkeerd, dan
-- voeg je het goede toe; het oude blijft erbij, zoals een boekstuk blijft staan. De media-worker vraagt met storage_key_lock_reason
-- of een bestand vastligt voordat hij het wist of overschrijft.
--
-- Bestaande gegevens: er verandert geen enkele rij. Bijlagen bij documenten die
-- al geboekt of verstuurd zijn, liggen vanaf nu vast.
--
-- Veilig om opnieuw te draaien.

-- De reden waarom bijlagen van dit document vastliggen, of null als het vrij is.
create or replace function public.attachment_parent_lock_reason(p_organization_id uuid, p_entity_type text, p_entity_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if p_entity_type = 'quote' then
    if exists (select 1 from public.quotes q
               where q.id = p_entity_id and q.organization_id = p_organization_id
                 and (q.status <> 'draft' or q.sent_at is not null)) then
      return 'Dit bestand hoort bij een offerte die geen concept meer is; het ligt vast (bewaarplicht).';
    end if;
  elsif p_entity_type = 'invoice' then
    if exists (select 1 from public.invoices i
               where i.id = p_entity_id and i.organization_id = p_organization_id
                 and (i.status <> 'draft' or i.sent_at is not null or i.journal_entry_id is not null)) then
      return 'Dit bestand hoort bij een factuur die verstuurd of geboekt is; het ligt vast (bewaarplicht).';
    end if;
  elsif p_entity_type = 'purchase_invoice' then
    if exists (select 1 from public.purchase_invoices p
               where p.id = p_entity_id and p.organization_id = p_organization_id and p.status <> 'draft') then
      return 'Dit bestand is het bewijsstuk van een geboekte inkoopfactuur; het ligt vast (bewaarplicht). Hoort er een ander stuk bij, voeg dat dan toe als extra bijlage.';
    end if;
  elsif p_entity_type = 'fixed_asset' then
    if exists (select 1 from public.fixed_assets a
               where a.id = p_entity_id and a.organization_id = p_organization_id
                 and (a.acquisition_journal_entry_id is not null
                      or exists (select 1 from public.asset_depreciations d where d.asset_id = a.id and d.journal_entry_id is not null))) then
      return 'Dit bestand is het bewijsstuk van een activum waarop geboekt is; het ligt vast (bewaarplicht).';
    end if;
  end if;
  return null;
end;
$function$;

revoke all on function public.attachment_parent_lock_reason(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.attachment_parent_lock_reason(uuid, text, uuid) to service_role;

create or replace function public.attachments_evidence_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reason text;
begin
  if tg_op = 'UPDATE'
     and new.storage_key is not distinct from old.storage_key
     and new.entity_type is not distinct from old.entity_type
     and new.entity_id is not distinct from old.entity_id
     and new.name is not distinct from old.name
     and new.mime_type is not distinct from old.mime_type
     and new.size_bytes is not distinct from old.size_bytes
     and new.edit_version is not distinct from old.edit_version then
    -- Alleen bijzaken (wie hem open heeft, de weergave-url): dat mag altijd.
    return new;
  end if;
  -- Wordt de hele organisatie verwijderd, dan gaan de bijlagen mee (cascade).
  if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  v_reason := public.attachment_parent_lock_reason(old.organization_id, old.entity_type, old.entity_id);
  if v_reason is not null then
    raise exception '%', v_reason using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

revoke all on function public.attachments_evidence_guard() from public, anon, authenticated;

drop trigger if exists attachments_evidence_guard on public.attachments;
create trigger attachments_evidence_guard
  before update or delete on public.attachments
  for each row execute function public.attachments_evidence_guard();

-- Voor de media-worker: ligt het bestand achter deze sleutel vast? De worker
-- wist een bestand vóórdat de app de rij wist (anders blijven er weesbestanden
-- achter), dus de trigger hierboven komt voor het bestand te laat. Twee wegen:
-- een bijlage die naar de sleutel wijst (ook een origineel uit de factuur-inbox
-- dat aan een inkoopfactuur hangt), en het document dat in de sleutel zelf staat
-- (<organisatie>/<soort>/<id>/…).
create or replace function public.storage_key_lock_reason(p_organization_id uuid, p_storage_key text)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_reason text;
  v_parts text[];
begin
  select public.attachment_parent_lock_reason(a.organization_id, a.entity_type, a.entity_id) into v_reason
  from public.attachments a
  where a.organization_id = p_organization_id and a.storage_key = p_storage_key
    and public.attachment_parent_lock_reason(a.organization_id, a.entity_type, a.entity_id) is not null
  limit 1;
  if v_reason is not null then return v_reason; end if;

  v_parts := string_to_array(p_storage_key, '/');
  if cardinality(v_parts) >= 4
     and v_parts[1] = p_organization_id::text
     and v_parts[2] in ('quote', 'invoice', 'purchase_invoice', 'fixed_asset')
     and v_parts[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return public.attachment_parent_lock_reason(p_organization_id, v_parts[2], v_parts[3]::uuid);
  end if;
  return null;
end;
$function$;

revoke all on function public.storage_key_lock_reason(uuid, text) from public, anon, authenticated;
grant execute on function public.storage_key_lock_reason(uuid, text) to service_role;
