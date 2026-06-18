import type { EmailTemplateKey } from '../types';

// Frontend-catalogus voor de e-mailteksten-editor. Per template-sleutel: het label
// in de UI, welke velden bewerkbaar zijn, de plaatshouders die de gebruiker mag
// gebruiken en de ingebouwde standaardtekst.
//
// BELANGRIJK: de standaardteksten en plaatshouders hieronder spiegelen exact die in
// de Edge Function-templates (supabase/functions/_shared/emailTemplates/*.ts). De
// editor gebruikt deze defaults alleen om mee te starten; bij het versturen bepaalt
// de Edge Function de echte fallback. Houd beide kanten gelijk bij wijzigingen.

export type EmailField = 'subject' | 'intro' | 'closing' | 'cta_label';

export type EmailPlaceholder = { token: string; label: string; example: string };

export type EmailTemplateMeta = {
  key: EmailTemplateKey;
  label: string;
  group: 'offerte' | 'factuur' | 'herinnering' | 'creditfactuur';
  description: string;
  fields: EmailField[];
  defaults: Record<EmailField, string>;
  placeholders: EmailPlaceholder[];
};

// Eén bron voor de plaatshouder-omschrijvingen, zodat labels/voorbeelden consistent
// zijn. Templates verwijzen via token naar deze map.
const PLACEHOLDERS: Record<string, Omit<EmailPlaceholder, 'token'>> = {
  recipient_name: { label: 'Naam ontvanger', example: 'Jan de Vries' },
  company_name: { label: 'Jouw bedrijfsnaam', example: 'ResoFly' },
  project_name: { label: 'Projectnaam', example: 'Website redesign' },
  quote_number: { label: 'Offertenummer', example: '2026-014' },
  invoice_number: { label: 'Factuurnummer', example: '2026-021' },
  credit_note_number: { label: 'Creditfactuurnummer', example: 'C2026-003' },
  total_amount: { label: 'Totaalbedrag', example: '€ 1.210,00' },
  valid_until: { label: 'Geldig tot', example: '30-06-2026' },
  due_date: { label: 'Vervaldatum', example: '30-06-2026' },
  date: { label: 'Datum', example: '17-06-2026' },
  days_overdue: { label: 'Aantal dagen te laat', example: '5' },
  days_sentence: { label: 'Dagen-zinsdeel', example: '5 dagen over de vervaldatum' },
  reason: { label: 'Reden creditfactuur', example: 'Correctie aantal uren' },
};

function placeholders(...tokens: string[]): EmailPlaceholder[] {
  return tokens.map(token => ({ token, ...PLACEHOLDERS[token] }));
}

export const EMAIL_TEMPLATES: EmailTemplateMeta[] = [
  {
    key: 'quote.sent',
    label: 'Offerte versturen',
    group: 'offerte',
    description: 'De e-mail die de klant ontvangt bij een nieuwe offerte met de digitale goedkeuringslink.',
    fields: ['subject', 'intro', 'closing', 'cta_label'],
    defaults: {
      subject: 'Offerte {{quote_number}} van {{company_name}}',
      intro: 'Beste {{recipient_name}},\nJe offerte staat klaar om te bekijken en digitaal goed te keuren.',
      closing: '',
      cta_label: 'Bekijk en keur offerte goed',
    },
    placeholders: placeholders('recipient_name', 'company_name', 'quote_number', 'total_amount', 'valid_until', 'project_name'),
  },
  {
    key: 'invoice.sent',
    label: 'Factuur versturen',
    group: 'factuur',
    description: 'De e-mail die de klant ontvangt bij een nieuwe factuur. De factuur-PDF gaat als bijlage mee.',
    fields: ['subject', 'intro', 'closing', 'cta_label'],
    defaults: {
      subject: 'Factuur {{invoice_number}} van {{company_name}}',
      intro: 'Beste {{recipient_name}},\nJe factuur staat klaar. In de bijlage vind je de PDF-snapshot.',
      closing: '',
      cta_label: 'Bekijk en betaal factuur',
    },
    placeholders: placeholders('recipient_name', 'company_name', 'invoice_number', 'total_amount', 'due_date', 'project_name', 'quote_number'),
  },
  {
    key: 'invoice.reminder.1',
    label: 'Herinnering · niveau 1 (vriendelijk)',
    group: 'herinnering',
    description: 'Eerste, vriendelijke betalingsherinnering voor een te late factuur.',
    fields: ['subject', 'intro', 'closing', 'cta_label'],
    defaults: {
      subject: 'Herinnering: factuur {{invoice_number}} staat nog open',
      intro: 'Beste {{recipient_name}},\nWaarschijnlijk is het u ontschoten — onderstaande factuur is {{days_sentence}} en staat bij ons nog als onbetaald geregistreerd. Mogelijk heeft u de betaling al gedaan; in dat geval kunt u deze herinnering als niet verzonden beschouwen.',
      closing: 'Wilt u de betaling alsnog in orde maken? Alvast bedankt.',
      cta_label: 'Bekijk en betaal factuur',
    },
    placeholders: placeholders('recipient_name', 'company_name', 'invoice_number', 'total_amount', 'due_date', 'days_overdue', 'days_sentence', 'project_name'),
  },
  {
    key: 'invoice.reminder.2',
    label: 'Herinnering · niveau 2 (steviger)',
    group: 'herinnering',
    description: 'Tweede herinnering wanneer de vervaldatum ruim is verstreken.',
    fields: ['subject', 'intro', 'closing', 'cta_label'],
    defaults: {
      subject: 'Tweede herinnering: factuur {{invoice_number}} nog niet voldaan',
      intro: 'Beste {{recipient_name}},\nOndanks onze eerdere herinnering hebben wij nog geen betaling van onderstaande factuur ontvangen. De vervaldatum is inmiddels {{days_sentence}}. Wij verzoeken u vriendelijk doch dringend het openstaande bedrag alsnog te voldoen.',
      closing: 'Heeft u vragen over deze factuur? Neem dan gerust contact met ons op.',
      cta_label: 'Betaal de factuur nu',
    },
    placeholders: placeholders('recipient_name', 'company_name', 'invoice_number', 'total_amount', 'due_date', 'days_overdue', 'days_sentence', 'project_name'),
  },
  {
    key: 'invoice.reminder.3',
    label: 'Herinnering · niveau 3 (aanmaning)',
    group: 'herinnering',
    description: 'Laatste, formele aanmaning voordat verdere stappen volgen.',
    fields: ['subject', 'intro', 'closing', 'cta_label'],
    defaults: {
      subject: 'Aanmaning: laatste betalingsherinnering factuur {{invoice_number}}',
      intro: 'Beste {{recipient_name}},\nDit is de laatste betalingsherinnering voor onderstaande factuur, die {{days_sentence}}. Wij verzoeken u het volledige openstaande bedrag binnen 7 dagen te voldoen. Blijft betaling uit, dan zijn wij genoodzaakt verdere (incasso)stappen te ondernemen.',
      closing: 'Heeft u inmiddels betaald? Dan zijn onze administraties elkaar gekruist en kunt u deze aanmaning als afgehandeld beschouwen.',
      cta_label: 'Betaal nu direct',
    },
    placeholders: placeholders('recipient_name', 'company_name', 'invoice_number', 'total_amount', 'due_date', 'days_overdue', 'days_sentence', 'project_name'),
  },
  {
    key: 'creditNote.sent',
    label: 'Creditfactuur versturen',
    group: 'creditfactuur',
    description: 'De e-mail bij een creditfactuur na een (gedeeltelijke) terugbetaling. Deze mail heeft geen knop.',
    fields: ['subject', 'intro', 'closing'],
    defaults: {
      subject: 'Creditfactuur {{credit_note_number}} van {{company_name}}',
      intro: 'Beste {{recipient_name}},\nIn de bijlage vind je de creditfactuur die hoort bij een (gedeeltelijke) terugbetaling van factuur {{invoice_number}}.',
      closing: '',
      cta_label: '',
    },
    placeholders: placeholders('recipient_name', 'company_name', 'credit_note_number', 'invoice_number', 'total_amount', 'date', 'reason'),
  },
];

export const EMAIL_FIELD_LABELS: Record<EmailField, string> = {
  subject: 'Onderwerp',
  intro: 'Aanhef & bericht',
  closing: 'Afsluiting',
  cta_label: 'Knoptekst',
};

export const EMAIL_FIELD_HINTS: Record<EmailField, string> = {
  subject: 'De onderwerpregel van de e-mail. Eén regel.',
  intro: 'De aanhef en het hoofdbericht. Nieuwe regels blijven behouden.',
  closing: 'Een afsluitende zin onder de samenvatting. Laat leeg om weg te laten.',
  cta_label: 'De tekst op de knop naar de beveiligde link.',
};

// Voorbeeldwaarden voor de live preview in de editor (lokale, niet-verzendende
// weergave). Gebruikt dezelfde tokens als de Edge-templates.
export const EMAIL_PREVIEW_VALUES: Record<string, string> = Object.fromEntries(
  Object.entries(PLACEHOLDERS).map(([token, meta]) => [token, meta.example]),
);

// Vul {{token}}-plaatshouders met voorbeeldwaarden voor de preview. Onbekende
// tokens worden — net als in de Edge Function — weggelaten.
export function fillPlaceholders(template: string, values: Record<string, string> = EMAIL_PREVIEW_VALUES): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token: string) => values[token] ?? '');
}
