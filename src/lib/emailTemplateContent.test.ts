import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { EMAIL_TEMPLATES } from './emailTemplateContent.ts';
import {
  PORTAL_TICKET_DEFAULTS,
  PORTAL_TICKET_PLACEHOLDERS,
  PORTAL_TICKET_TEMPLATE_KEYS,
} from '../../supabase/functions/_shared/emailTemplates/portalTicketUpdate.ts';

/**
 * De e-mailteksten-editor (Instellingen → E-mail) toont per mail de
 * standaardtekst en de plaatshouders; de Edge Function gebruikt bij het
 * versturen haar eigen kopie. Lopen die uiteen, dan ziet een beheerder in de
 * editor een andere tekst dan de klant krijgt. Deze test legt ze naast elkaar —
 * en daarnaast de lijst die Gerrie kent en de toegestane sleutels in de database.
 */

const tokensIn = (text: string) => [...text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);

test('ticketmeldingen: editor en mailtemplate hebben dezelfde standaardtekst en plaatshouders', () => {
  for (const key of PORTAL_TICKET_TEMPLATE_KEYS) {
    const meta = EMAIL_TEMPLATES.find((t) => t.key === key);
    assert.ok(meta, `${key} staat niet in de editor`);
    const edge = PORTAL_TICKET_DEFAULTS[key];
    assert.deepEqual(
      meta.defaults,
      { subject: edge.subject, intro: edge.intro, closing: edge.closing, cta_label: edge.ctaLabel },
      `${key}: standaardtekst`,
    );
    assert.deepEqual(meta.placeholders.map((p) => p.token), PORTAL_TICKET_PLACEHOLDERS[key], `${key}: plaatshouders`);
    for (const field of Object.values(meta.defaults)) {
      for (const token of tokensIn(field)) {
        assert.ok(PORTAL_TICKET_PLACEHOLDERS[key].includes(token), `${key}: {{${token}}} staat niet in de lijst`);
      }
    }
    for (const placeholder of meta.placeholders) {
      assert.ok(placeholder.label && placeholder.example, `${key}: {{${placeholder.token}}} heeft een label en voorbeeld`);
    }
  }
});

test('elke mail in de editor kent Gerrie ook, met dezelfde velden', () => {
  const admin = readFileSync(new URL('../../supabase/functions/_shared/actions/admin.ts', import.meta.url), 'utf8');
  const block = admin.slice(admin.indexOf('const EMAIL_TEMPLATES'), admin.indexOf('const EMAIL_TEMPLATE_KEYS'));
  const gerrie = [...block.matchAll(/\{ key: '([^']+)', label: '[^']*', fields: \[([^\]]*)\] \}/g)]
    .map((m) => ({ key: m[1], fields: [...m[2].matchAll(/'([^']+)'/g)].map((f) => f[1]) }));
  assert.deepEqual(
    gerrie,
    EMAIL_TEMPLATES.map((t) => ({ key: t.key, fields: t.fields })),
  );
});

test('elke mail in de editor mag in de database (template_key-CHECK van de laatste migratie)', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const latest = readdirSync(dir)
    .filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort().reverse()
    .map((name) => readFileSync(new URL(name, dir), 'utf8'))
    .find((sql) => sql.includes('add constraint email_templates_template_key_check'));
  assert.ok(latest, 'geen migratie met de template_key-CHECK gevonden');
  const check = latest.slice(latest.indexOf('add constraint email_templates_template_key_check'));
  const allowed = [...check.slice(0, check.indexOf(');')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const template of EMAIL_TEMPLATES) {
    assert.ok(allowed.includes(template.key), `${template.key} ontbreekt in de template_key-CHECK`);
  }
});
