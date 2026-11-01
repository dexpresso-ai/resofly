-- ============================================================
-- ResoFly — Een mailquotum per organisatie
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt A).
--
-- Alle organisaties delen één Resend-account en één platform-afzender. Er was
-- geen grens aan wat een organisatie verstuurde. Eén organisatie die spamt of
-- phisht, raakt zo de reputatie, en in het ergste geval de verzending, van
-- iedereen: ook de facturen en herinneringen van alle andere klanten.
--
-- Nu een teller per organisatie, per uur:
--   - email_quota_take(org, n): telt n mails op als dat binnen de grens past,
--     en zegt anders nee (zonder te tellen). Alleen de service-role roept hem
--     aan, vanuit de edge functions (_shared/emailQuota.ts);
--   - standaard 200 per uur en 1000 per 24 uur. Een organisatie die meer nodig
--     heeft, krijgt een rij in organization_email_limits. Die zet alleen de
--     beheerder van het platform (geen policy: de app kan hem niet lezen of
--     schrijven);
--   - oude tellers ruimt email_quota_take zelf op (ouder dan 2 dagen).
--
-- Eerst op de routes met het meeste misbruik: vrije klantmail (mail) en
-- agenda-uitnodigingen. Campagnes, document-mails en de overige routes volgen.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create table if not exists public.email_send_counters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bucket_start timestamptz not null,
  sent integer not null default 0 check (sent >= 0),
  primary key (organization_id, bucket_start)
);

create table if not exists public.organization_email_limits (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  hourly_limit integer not null check (hourly_limit between 0 and 100000),
  daily_limit integer not null check (daily_limit between 0 and 1000000),
  note text,
  updated_at timestamptz not null default now()
);

-- Alleen de service-role: RLS aan, geen enkele policy, en geen rechten voor de app.
alter table public.email_send_counters enable row level security;
alter table public.organization_email_limits enable row level security;
revoke all on public.email_send_counters from public, anon, authenticated;
revoke all on public.organization_email_limits from public, anon, authenticated;
grant all on public.email_send_counters to service_role;
grant all on public.organization_email_limits to service_role;

-- Het boekhouder-hek (20261011000000): elke organisatietabel heeft een module
-- gate of het hek, zodat een latere policy de boekhouder niet per ongeluk
-- binnenlaat. Deze tabellen hebben geen policy, maar de regel geldt voor allemaal.
select public.apply_accountant_fence('email_send_counters');
select public.apply_accountant_fence('organization_email_limits');

create or replace function public.email_quota_take(p_organization_id uuid, p_count integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket timestamptz := date_trunc('hour', now());
  v_hourly_limit integer := 200;
  v_daily_limit integer := 1000;
  v_hour integer;
  v_day integer;
  v_count integer := greatest(coalesce(p_count, 1), 1);
begin
  if p_organization_id is null then
    return jsonb_build_object('ok', false, 'reason', 'Geen organisatie.');
  end if;

  select l.hourly_limit, l.daily_limit into v_hourly_limit, v_daily_limit
    from public.organization_email_limits l where l.organization_id = p_organization_id;
  v_hourly_limit := coalesce(v_hourly_limit, 200);
  v_daily_limit := coalesce(v_daily_limit, 1000);

  -- Eén organisatie tegelijk: twee verzoeken tellen niet allebei langs de grens.
  perform pg_advisory_xact_lock(hashtext('email_quota:' || p_organization_id::text));

  select coalesce(sum(c.sent) filter (where c.bucket_start = v_bucket), 0),
         coalesce(sum(c.sent), 0)
    into v_hour, v_day
    from public.email_send_counters c
   where c.organization_id = p_organization_id
     and c.bucket_start > v_bucket - interval '24 hours';

  if v_hour + v_count > v_hourly_limit or v_day + v_count > v_daily_limit then
    return jsonb_build_object(
      'ok', false,
      'hour', v_hour, 'day', v_day,
      'hourly_limit', v_hourly_limit, 'daily_limit', v_daily_limit
    );
  end if;

  insert into public.email_send_counters (organization_id, bucket_start, sent)
  values (p_organization_id, v_bucket, v_count)
  on conflict (organization_id, bucket_start) do update set sent = public.email_send_counters.sent + excluded.sent;

  delete from public.email_send_counters
   where organization_id = p_organization_id and bucket_start < v_bucket - interval '48 hours';

  return jsonb_build_object('ok', true, 'hour', v_hour + v_count, 'day', v_day + v_count,
                            'hourly_limit', v_hourly_limit, 'daily_limit', v_daily_limit);
end;
$$;

revoke all on function public.email_quota_take(uuid, integer) from public, anon, authenticated;
grant execute on function public.email_quota_take(uuid, integer) to service_role;

commit;
