// Rendert de drie betalingsherinnering-niveaus naar losse HTML/TXT-bestanden, zodat
// je de toon en opmaak visueel kunt controleren zónder echt te versturen.
//
// Gebruik (Deno, zoals de Edge Functions):
//   deno run --allow-write previewReminderEmails.ts [outputDir]
// Standaard schrijft hij naar ./reminder-previews/ (reminder-level-1.html, …).
//
// buildReminderPreviews() is een pure functie (geen runtime-API's) en kan ook in een
// test/build-harness worden hergebruikt om de gerenderde HTML te asserteren.

import { renderInvoiceReminderEmail } from './invoiceReminder.ts';
import type { InvoiceReminderEmailInput } from './types.ts';

type ReminderPreview = { level: 1 | 2 | 3; subject: string; html: string; text: string };

// Eén representatieve, fictieve factuur waarmee alle drie de niveaus worden gerenderd.
function sampleInput(level: 1 | 2 | 3): InvoiceReminderEmailInput {
  return {
    level,
    invoice: {
      number: '2026-0042',
      due_date: '2026-05-20', // ruim vóór "vandaag" zodat "dagen verstreken" zichtbaar is
      lines: [
        { description: 'Strategie- en conceptsessie', quantity: 1, unit_price: 850, vat: 21 },
        { description: 'Uitwerking merkidentiteit', quantity: 8, unit_price: 95, vat: 21 },
      ],
    },
    client: { name: 'Vandenberg Interieurs B.V.', contact_name: 'Sanne Vandenberg', email: 'sanne@vandenberg.example' },
    project: { name: 'Rebranding 2026', description: null },
    company: { company_name: 'ResoFly Studio', trade_name: 'ResoFly', email: 'hallo@resofly.example', phone: '+31 20 123 4567', website: 'resofly.example', invoice_accent_color: '#FFD966' },
    publicUrl: 'https://app.resofly.example/invoice/voorbeeld-token',
    paymentUrl: 'https://checkout.mollie.example/pay/voorbeeld',
    recipientName: 'Sanne Vandenberg',
    daysOverdue: level === 1 ? 4 : level === 2 ? 12 : 21,
  };
}

export function buildReminderPreviews(): ReminderPreview[] {
  return ([1, 2, 3] as const).map((level) => {
    const rendered = renderInvoiceReminderEmail(sampleInput(level));
    return { level, subject: rendered.subject, html: rendered.html, text: rendered.text };
  });
}

if (import.meta.main) {
  const outputDir = (Deno.args[0] || './reminder-previews').replace(/\/$/, '');
  await Deno.mkdir(outputDir, { recursive: true });
  for (const preview of buildReminderPreviews()) {
    const base = `${outputDir}/reminder-level-${preview.level}`;
    await Deno.writeTextFile(`${base}.html`, preview.html);
    await Deno.writeTextFile(`${base}.txt`, `Onderwerp: ${preview.subject}\n\n${preview.text}\n`);
    console.log(`Niveau ${preview.level} → ${base}.html  ·  onderwerp: "${preview.subject}"`);
  }
  console.log(`\nKlaar. Open de .html-bestanden in ${outputDir}/ in je browser.`);
}
