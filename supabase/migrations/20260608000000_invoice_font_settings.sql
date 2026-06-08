-- Voeg lettergrootte-instelling toe aan company_settings voor facturen/offertes
alter table public.company_settings
  add column if not exists invoice_font_size integer not null default 10;
