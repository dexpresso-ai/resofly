// De inlogmail van het klantportaal (portal-login, migratie 20261108230000).
//
// Waarom een eigen mail: eerst verstuurde Supabase hem zelf, met de Engelse
// standaardtekst ("Your Magic Link"), vanaf het platformadres, en met een link
// die alleen op het adres van ResoFly werkte. Nu komt hij van de leverancier
// zelf (zijn verzenddomein), in het Nederlands, en wijst de link naar zijn
// eigen klantadres.
//
// Bewust niet aanpasbaar in Instellingen → E-mail: de zinnen over hoe lang de
// link werkt, in welke browser, en wat je doet als je niet inlogde, horen
// altijd in de mail.
//
// Sinds migratie 20261109020000 staat er ook op welk adres de code hoort. Een
// code kan elke website vragen; wie hem invult op een site die niet van de
// leverancier is, geeft die site toegang. Het adres in de mail is het adres
// waar de klant de inlog aanvroeg (de link gaat daar ook heen).
//
// Puur: geen Deno, geen netwerk (portalLogin.test.ts).
import { escapeHtml, renderEmailLayout } from './layout.ts';

export interface PortalLoginEmailInput {
  /** De naam van de leverancier, of null voor het algemene portaal. */
  supplierName: string | null;
  accentColor?: string | null;
  loginUrl: string;
  /** De code uit dezelfde aanvraag, voor wie de mail op een ander apparaat leest. */
  code: string | null;
  /** Zo lang werkt de link. */
  minutes: number;
}

/** Het adres uit de link: daar hoort de code. */
function loginHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function renderPortalLoginEmail(input: PortalLoginEmailInput): { subject: string; html: string; text: string } {
  const supplier = String(input.supplierName ?? '').trim() || null;
  const portal = supplier ? `het klantportaal van ${supplier}` : 'je klantportaal';
  const code = String(input.code ?? '').replace(/\D/g, '');
  const host = loginHost(input.loginUrl);
  const subject = supplier ? `Inloggen bij ${supplier}` : 'Inloggen op je klantportaal';
  const html = renderEmailLayout({
    brandName: supplier || 'Klantportaal',
    preheader: `Je inloglink voor ${portal}. Hij werkt ${input.minutes} minuten.`,
    title: 'Inloggen',
    introHtml: `<p style="margin:0 0 12px;">Klik op de knop om in te loggen op ${escapeHtml(portal)}. De link werkt ${input.minutes} minuten, en alleen in de browser waarin je hem aanvroeg.</p>`,
    cta: { label: 'Inloggen', url: input.loginUrl },
    bodyHtml: code
      ? `<p style="margin:24px 0 6px;color:#d8d8df;font-size:15px;">Lees je deze mail op een ander apparaat? Vul dan deze code in op het inlogscherm${host ? ` van <strong style="color:#ffffff;">${escapeHtml(host)}</strong>` : ''}:</p>
<p style="margin:0;font-size:28px;letter-spacing:.18em;font-weight:700;color:#ffffff;font-family:Menlo,Consolas,monospace;">${escapeHtml(code)}</p>
${host ? `<p style="margin:12px 0 0;color:#d8d8df;font-size:14px;">Vul de code alleen in op ${escapeHtml(host)}. Vraagt een andere website erom, vul hem dan niet in.</p>` : ''}`
      : '',
    footerHtml: 'Heb je niet geprobeerd in te loggen? Dan kun je deze mail negeren. Zonder de link of de code komt niemand binnen.',
    accentColor: input.accentColor,
  });
  const text = [
    `Inloggen op ${portal}`,
    '',
    `Open deze link om in te loggen (${input.minutes} minuten geldig, alleen in de browser waarin je hem aanvroeg):`,
    input.loginUrl,
    ...(code
      ? [
        '',
        `Op een ander apparaat? Vul deze code in op het inlogscherm${host ? ` van ${host}` : ''}: ${code}`,
        ...(host ? [`Vul de code alleen in op ${host}. Vraagt een andere website erom, vul hem dan niet in.`] : []),
      ]
      : []),
    '',
    'Heb je niet geprobeerd in te loggen? Dan kun je deze mail negeren. Zonder de link of de code komt niemand binnen.',
  ].join('\n');
  return { subject, html, text };
}
