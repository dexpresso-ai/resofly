// ============================================================
// Sanitisatie van NIET-vertrouwde HTML vóór dangerouslySetInnerHTML.
//
// Bedoeld voor door derden bepaalde HTML — met name de body van INKOMENDE
// e-mail. Die komt via de mail-inbound webhook binnen en is volledig door de
// (onauthenticeerbare) afzender bepaald; zonder sanitisatie is dat een stored
// XSS die op de app-origin draait en de Supabase-sessie uit localStorage kan
// stelen. We gebruiken DOMPurify (de-facto standaard) en verwijderen naast
// scripts/event-handlers ook style/CSS- en formulier-/embed-vectoren die voor
// UI-redressing of phishing binnen de app-origin misbruikt kunnen worden.
// ============================================================

import DOMPurify from 'dompurify';

let hooksRegistered = false;
function ensureHooks(): void {
  if (hooksRegistered) return;
  // Elke overgebleven link opent veilig: nieuw tabblad, geen opener/referrer.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node instanceof Element && node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
  hooksRegistered = true;
}

/**
 * Saneert niet-vertrouwde HTML (bv. de body van een inkomende e-mail) zodat die
 * veilig via dangerouslySetInnerHTML getoond kan worden. Verwijdert alle
 * script-vectoren (<script>, on*-handlers, javascript:-URL's) plus style/CSS-,
 * formulier- en embed-vectoren. Structuur en tekst (alinea's, lijsten, tabellen,
 * links, opmaak, afbeeldingen) blijven behouden.
 */
export function sanitizeEmailHtml(html: string | null | undefined): string {
  if (!html) return '';
  ensureHooks();
  return DOMPurify.sanitize(String(html), {
    FORBID_TAGS: ['style', 'link', 'base', 'meta', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
    // Alleen veilige URL-schema's in href/src; blokkeert o.a. javascript: en data:.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|cid:|#)/i,
  });
}
