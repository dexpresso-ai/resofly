-- ============================================================
-- ResoFly — Gerrie-agents krijgen een gezicht (embleem + kleur)
-- Date: 2026-08-16
--
-- Een aangemaakte agent (ai_agents) werd tot nu toe als tekstregel getoond. Hij
-- krijgt nu een embleem: een icoon met een eigen kleurtint, zodat je in één
-- oogopslag ziet wélke agent er staat te wachten. De app leidt het embleem
-- automatisch af uit de opdracht/tools van de agent; deze twee kolommen leggen
-- alleen de HANDMATIGE keuze van de gebruiker vast (null = automatisch).
--
-- Bewust puur cosmetisch: geen enkele runner-beslissing hangt hieraan. Daarom
-- ook geen NOT NULL en geen default — een bestaande agent houdt zijn afgeleide
-- embleem tot iemand er zelf een kiest.
--
-- Beveiliging: ai_agents heeft al RLS (lezen owner/admin) en er zijn bewust geen
-- client-write-policies; schrijven blijft uitsluitend via de service-role in
-- `gerrie-agent-runner`, die de waarde tegen een allowlist toetst.
-- ============================================================

begin;

alter table public.ai_agents
  add column if not exists icon text
    check (icon is null or char_length(icon) <= 32);

-- Kleurtint op de kleurcirkel (0..359). De app kiest S/L per thema, zodat een
-- gekozen tint zowel op donker als op licht leesbaar blijft.
alter table public.ai_agents
  add column if not exists hue smallint
    check (hue is null or (hue >= 0 and hue <= 359));

comment on column public.ai_agents.icon is
  'Sleutel van het gekozen embleem-icoon (allowlist in de app/runner). Null = automatisch afgeleid uit opdracht + tools.';
comment on column public.ai_agents.hue is
  'Gekozen kleurtint 0..359 voor het embleem. Null = automatisch afgeleid uit het agent-id.';

commit;
