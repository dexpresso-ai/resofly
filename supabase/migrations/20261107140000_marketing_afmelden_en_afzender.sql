-- ============================================================
-- ResoFly — Marketing: een afmelding blijft staan, de afzender is wie het maakte
-- Date: 2026-11-07
--
-- Uit de controle van de marketingfunctie
-- (docs/rapporten/CONTROLE_MARKETING_2026-11-07.md).
--
--   1. AFMELDINGEN. Elk teamlid met schrijfrecht op Marketing kon een adres
--      van de afmeldlijst halen ("Weer toestaan"), ook als de ontvanger zich
--      zelf had afgemeld of de mail als spam had gemeld. Daarna kreeg die
--      persoon gewoon weer campagnes: in strijd met de AVG en de
--      Telecommunicatiewet. Nu haalt het team alleen weg wat het zelf of de
--      techniek erop zette: een handmatige blokkade en een bounce.
--   2. KLACHT NA BLOKKADE. Kwam er een spamklacht binnen op een adres dat al
--      handmatig geblokkeerd of gebounced was, dan bleef de oude reden staan,
--      en daarmee kon het team de blokkade nog opheffen. Nu wordt de reden dan
--      'complained'. De afmeldlink doet hetzelfde (email-unsubscribe).
--   3. AFZENDER. Campagne- en stroommail gaat uit met de persoonlijke afzender
--      van created_by. Die kon elk teamlid via de API op een collega zetten;
--      de mail ging dan uit op naam van die collega, bijvoorbeeld de eigenaar.
--      Nu zet een trigger de maker, zoals bij boekingen (20261101120000). De
--      service-role (geen ingelogde gebruiker) houdt wat hij meegaf.
--   4. ORGANISATIE. De security-definer-triggers op client_emails werkten de
--      campagne- en stroomrijen bij op id of thread, zonder organisatiefilter.
--      Harde regel 1: wie RLS overslaat, filtert zelf. Ze filteren nu op de
--      organisatie van de mail. De werking verandert niet: de rijen die de
--      functie campaigns maakt, horen altijd bij dezelfde organisatie.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Afmeldingen: alleen een eigen blokkade of een bounce is op te heffen ──

drop policy if exists "email suppressions delete" on public.email_suppressions;
create policy "email suppressions delete" on public.email_suppressions
  for delete
  using (public.can_write_org(organization_id) and reason in ('manual', 'bounced'));

-- Er is bewust geen update-policy: zonder zou een teamlid de reden op 'manual'
-- kunnen zetten en het adres daarna alsnog weghalen. Dat blijft zo.

-- ── 2 en 4. Tracking spiegelen: organisatiefilter, en een klacht wint ────────

create or replace function public.mirror_client_email_to_campaign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient_id uuid;
  v_flow_send_id uuid;
begin
  v_recipient_id := nullif(new.metadata ->> 'campaign_recipient_id', '')::uuid;
  v_flow_send_id := nullif(new.metadata ->> 'flow_send_id', '')::uuid;

  if v_recipient_id is not null then
    update public.email_campaign_recipients r
       set status = case
             when r.status in ('unsubscribed','skipped') then r.status
             when public.email_engagement_rank(new.status) >= public.email_engagement_rank(r.status)
               and new.status in ('sent','delivered','opened','clicked','bounced','failed','complained')
               then new.status
             else r.status
           end,
           sent_at = coalesce(r.sent_at, new.sent_at),
           delivered_at = coalesce(r.delivered_at, new.delivered_at),
           opened_at = coalesce(r.opened_at, new.opened_at),
           clicked_at = coalesce(r.clicked_at, new.clicked_at),
           bounced_at = coalesce(r.bounced_at, new.bounced_at),
           failed_at = coalesce(r.failed_at, new.failed_at),
           error_message = coalesce(new.error_message, r.error_message),
           updated_at = now()
     where r.id = v_recipient_id
       and r.organization_id = new.organization_id;
  end if;

  if v_flow_send_id is not null then
    update public.email_flow_sends s
       set status = case
             when s.status in ('unsubscribed','skipped') then s.status
             when public.email_engagement_rank(new.status) >= public.email_engagement_rank(s.status)
               and new.status in ('sent','delivered','opened','clicked','bounced','failed','complained')
               then new.status
             else s.status
           end,
           sent_at = coalesce(s.sent_at, new.sent_at),
           delivered_at = coalesce(s.delivered_at, new.delivered_at),
           opened_at = coalesce(s.opened_at, new.opened_at),
           clicked_at = coalesce(s.clicked_at, new.clicked_at),
           bounced_at = coalesce(s.bounced_at, new.bounced_at),
           failed_at = coalesce(s.failed_at, new.failed_at),
           error_message = coalesce(new.error_message, s.error_message),
           updated_at = now()
     where s.id = v_flow_send_id
       and s.organization_id = new.organization_id;
  end if;

  -- Bounce/klacht → afmeldlijst (deliverability + AVG); geldt voor campagne- én
  -- stroommail. De insert-trigger op email_suppressions stopt meteen lopende
  -- sends. Stond het adres er al op als handmatige blokkade of bounce, dan
  -- maakt een klacht er 'complained' van: dat kan het team niet opheffen.
  if new.status in ('bounced', 'complained') and new.to_email is not null
     and (v_recipient_id is not null or v_flow_send_id is not null) then
    insert into public.email_suppressions as s (organization_id, email, reason, source)
    values (
      new.organization_id,
      lower(btrim(new.to_email)),
      case when new.status = 'complained' then 'complained' else 'bounced' end,
      'resend-webhook'
    )
    on conflict (organization_id, email) do update
      set reason = excluded.reason,
          source = excluded.source
      where excluded.reason = 'complained'
        and s.reason in ('manual', 'bounced');
  end if;

  return new;
end;
$$;

-- Een antwoord op de thread markeert de ontvanger en de inschrijving, binnen
-- dezelfde organisatie.
create or replace function public.mark_campaign_reply_from_inbound()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.email_campaign_recipients r
     set replied_at = coalesce(r.replied_at, coalesce(new.received_at, now())),
         updated_at = now()
   where r.thread_id = new.thread_id
     and r.organization_id = new.organization_id
     and r.replied_at is null;

  update public.email_flow_enrollments e
     set last_reply_at = coalesce(new.received_at, now()),
         updated_at = now()
   where e.thread_id = new.thread_id
     and e.organization_id = new.organization_id;

  update public.email_flow_sends s
     set replied_at = coalesce(s.replied_at, coalesce(new.received_at, now())),
         updated_at = now()
   where s.thread_id = new.thread_id
     and s.organization_id = new.organization_id
     and s.replied_at is null;

  return new;
end;
$$;

-- Triggerfuncties: niemand roept ze rechtstreeks aan; de trigger vuurt toch
-- (zie migrationGrants.test.ts).
revoke all on function public.mirror_client_email_to_campaign() from public, anon, authenticated;
revoke all on function public.mark_campaign_reply_from_inbound() from public, anon, authenticated;

-- ── 3. De maker van een campagne of stroom ──────────────────────────────────

create or replace function public.stamp_marketing_creator()
returns trigger
language plpgsql
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := v_uid;
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_marketing_creator() from public, anon, authenticated;

drop trigger if exists email_campaigns_stamp_creator on public.email_campaigns;
create trigger email_campaigns_stamp_creator
  before insert or update of created_by on public.email_campaigns
  for each row execute function public.stamp_marketing_creator();

drop trigger if exists email_flows_stamp_creator on public.email_flows;
create trigger email_flows_stamp_creator
  before insert or update of created_by on public.email_flows
  for each row execute function public.stamp_marketing_creator();

commit;
