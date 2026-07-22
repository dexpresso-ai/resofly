-- ============================================================
-- ResoFly — Urencriterium-monitor (1225 u) + projectbudget
-- Date: 2026-07-22
--
-- Scope:
-- - time_entries.entry_type ('direct'|'indirect'): het urencriterium van de
--   Belastingdienst (1225 uur per kalenderjaar voor o.a. zelfstandigen- en
--   startersaftrek) telt ÓÓK indirecte uren mee (administratie, acquisitie,
--   reistijd, scholing). Dit veld staat bewust LOS van `billable`: declarabel
--   volgt het projecttype, het urentype volgt de aard van het werk.
-- - time_entries.indirect_category: soort indirect werk, voor de uitsplitsing
--   op het urendashboard. Alleen gevuld bij entry_type='indirect'.
-- - projects.budgeted_minutes: urenbudget per project voor begroot vs.
--   werkelijk (projectmarge) op het projectdashboard.
--
-- Bestaande rijen worden 'direct' (alle huidige registraties zijn klantwerk).
-- De agenda-synctrigger (sync_time_entry_from_link) blijft ongemoeid: nieuwe
-- afgeleide posten krijgen de kolomdefault 'direct' en de ON CONFLICT-update
-- raakt entry_type/indirect_category niet aan, dus een handmatige wijziging
-- blijft behouden als de afspraak verschuift — zelfde gedrag als `billable`.
-- ============================================================

begin;

-- ── 1. Urentype op time_entries ─────────────────────────────────────────────
alter table public.time_entries
  add column if not exists entry_type text not null default 'direct';
alter table public.time_entries
  add column if not exists indirect_category text;

alter table public.time_entries drop constraint if exists time_entries_entry_type_ck;
alter table public.time_entries add constraint time_entries_entry_type_ck
  check (entry_type in ('direct','indirect'));

-- Categorie hoort alleen bij indirecte uren; bij directe uren blijft die leeg.
alter table public.time_entries drop constraint if exists time_entries_indirect_category_ck;
alter table public.time_entries add constraint time_entries_indirect_category_ck
  check (
    indirect_category is null
    or (entry_type = 'indirect' and indirect_category in ('admin','acquisition','travel','education','other'))
  );

-- ── 2. Urenbudget op projects ───────────────────────────────────────────────
alter table public.projects
  add column if not exists budgeted_minutes integer;

alter table public.projects drop constraint if exists projects_budgeted_minutes_ck;
alter table public.projects add constraint projects_budgeted_minutes_ck
  check (budgeted_minutes is null or budgeted_minutes >= 0);

commit;
