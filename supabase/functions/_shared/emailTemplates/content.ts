import { escapeHtml } from './layout.ts';

// Per-organisatie aanpasbare e-mailtekst, afkomstig uit de email_templates-tabel.
// Elk veld dat leeg/null is valt terug op de ingebouwde standaardtekst van de
// template. Zo blijft de copy werken zolang een organisatie niets aanpast.
export type EmailTemplateContent = {
  subject?: string | null;
  intro?: string | null;
  closing?: string | null;
  ctaLabel?: string | null;
  enabled?: boolean | null;
};

export type TemplateVars = Record<string, string>;

type EmailTemplateField = 'subject' | 'intro' | 'closing' | 'ctaLabel';

// Vervang {{token}}-plaatshouders. Onbekende tokens worden weggelaten in plaats
// van letterlijk getoond, zodat een typefout nooit "{{foo}}" in een klantmail lekt.
function substitute(template: string, vars: TemplateVars, transform: (value: string) => string): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token: string) => {
    const value = vars[token];
    return value === undefined || value === null ? '' : transform(value);
  });
}

// HTML-veilige weergave van een door de gebruiker geschreven veld: de letterlijke
// tekst wordt ge-escaped, elke plaatshouderwaarde wordt ge-escaped en regeleindes
// worden <br/>. Hierdoor kan een klant-aanpasbaar veld nooit rauwe HTML in de mail
// injecteren — dit is bewust de enige renderroute voor gebruikerstekst.
export function renderContentHtml(template: string, vars: TemplateVars): string {
  const escapedTemplate = escapeHtml(template);
  const withVars = substitute(escapedTemplate, vars, escapeHtml);
  return withVars.replace(/\r?\n/g, '<br/>');
}

// Plain-text weergave: plaatshouders gevuld met rauwe waarden, regeleindes behouden.
export function renderContentText(template: string, vars: TemplateVars): string {
  return substitute(template, vars, (value) => value).replace(/\r\n/g, '\n');
}

// Kies het aangepaste veld wanneer de template is ingeschakeld én het veld gevuld
// is; anders de ingebouwde standaardtekst.
export function fieldOr(content: EmailTemplateContent | null | undefined, field: EmailTemplateField, fallback: string): string {
  if (!content || content.enabled === false) return fallback;
  const value = content[field];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

// Idem, maar geeft null terug als er geen aangepaste én geen standaardtekst is
// (voor optionele velden zoals een afsluiting bij offerte/factuur).
export function optionalFieldOr(content: EmailTemplateContent | null | undefined, field: EmailTemplateField, fallback: string | null): string | null {
  if (!content || content.enabled === false) return fallback;
  const value = content[field];
  return typeof value === 'string' && value.trim() ? value : fallback;
}
