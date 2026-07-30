import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { getModuleLevel } from '../_shared/edgeAuth.ts';

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type MailHttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';

// Regio waarin nieuwe verzenddomeinen bij Resend worden aangemaakt. eu-west-1
// (Ierland) is de standaard voor een Nederlandse SaaS i.v.m. dataresidentie.
const RESEND_DEFAULT_REGION = Deno.env.get('RESEND_DEFAULT_REGION') || 'eu-west-1';

// Domein waarop antwoorden binnenkomen (fase C). Zolang dit leeg is, krijgen
// klant-mails een gewone Reply-To (afzenderadres / RESEND_REPLY_TO). Zodra het
// inbound-domein via Cloudflare Email Routing live staat, zetten we hier
// bijv. "inbound.resofly.nl" zodat replies als reply+<id>@inbound... terugkomen.
const MAIL_INBOUND_DOMAIN = (Deno.env.get('MAIL_INBOUND_DOMAIN') || '').trim().toLowerCase();

// Basis-URL van de frontend voor de portaallink in de welkomstmail. Valt terug op
// de (al via assertAllowedOrigin gevalideerde) request-origin als er geen env staat.
const CLIENT_PORTAL_BASE_URL = (
  Deno.env.get('CLIENT_PORTAL_BASE_URL') ||
  Deno.env.get('APP_PUBLIC_URL') ||
  Deno.env.get('QUOTE_PUBLIC_BASE_URL') ||
  Deno.env.get('INVOICE_PUBLIC_BASE_URL') ||
  ''
).replace(/\/$/, '');

// Basis-URL van de app (login/werkruimte) voor de teamuitnodigingsmail. Zelfde
// bronnen als de portaal-URL maar zonder /portal-suffix: de uitgenodigde logt
// hier in met zijn e-mailadres en accepteert daarna de uitnodiging in de app.
const APP_BASE_URL = (
  Deno.env.get('APP_PUBLIC_URL') ||
  Deno.env.get('CLIENT_PORTAL_BASE_URL') ||
  Deno.env.get('QUOTE_PUBLIC_BASE_URL') ||
  Deno.env.get('INVOICE_PUBLIC_BASE_URL') ||
  ''
).replace(/\/$/, '');

const MAIL_ALLOWED_ORIGINS = (
  Deno.env.get('MAIL_ALLOWED_ORIGINS') ||
  Deno.env.get('QUOTE_ALLOWED_ORIGINS') ||
  Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS') ||
  ''
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const MAIL_ALLOW_LOCAL_DEV =
  (Deno.env.get('MAIL_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Nette Nederlandse rolnamen voor in de uitnodigingsmail.
const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: 'Eigenaar',
  admin: 'Beheerder',
  member: 'Teamlid',
  viewer: 'Alleen-lezen',
};

class MailHttpError extends Error {
  status: MailHttpErrorStatus;

  constructor(message: string, status: MailHttpErrorStatus = 400) {
    super(message);
    this.name = 'MailHttpError';
    this.status = status;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return json(req, { ok: true });
  }

  try {
    assertAllowedOrigin(req);

    if (req.method !== 'POST') {
      return json(req, { ok: false, error: 'Method not allowed.' }, 405);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');

    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);

    switch (action) {
      case 'sendTestEmail': {
        if (!['owner', 'admin'].includes(role)) {
          throw new MailHttpError(
            'Alleen owners en admins kunnen Resend-testmails verzenden.',
            403,
          );
        }

        const result = await sendTestEmail(organizationId, body);
        return json(req, { ok: true, ...result });
      }

      case 'sendClientPortalWelcome': {
        if (!['owner', 'admin', 'member'].includes(role)) {
          throw new MailHttpError(
            'Je hebt geen rechten om de welkomstmail te versturen.',
            403,
          );
        }
        // Service-role omzeilt RLS: klantcommunicatie hoort bij de module Klanten.
        await assertClientModuleWrite(user.id, organizationId);

        const result = await sendClientPortalWelcome(req, organizationId, body);
        return json(req, { ok: true, ...result });
      }

      case 'sendTeamInvitation': {
        if (!['owner', 'admin'].includes(role)) {
          throw new MailHttpError(
            'Alleen owners en admins kunnen teamuitnodigingen versturen.',
            403,
          );
        }

        const result = await sendTeamInvitation(req, organizationId, user, body);
        return json(req, { ok: true, ...result });
      }

      case 'sendClientEmail': {
        if (!['owner', 'admin', 'member'].includes(role)) {
          throw new MailHttpError(
            'Je hebt geen rechten om klant-e-mails te versturen.',
            403,
          );
        }
        await assertClientModuleWrite(user.id, organizationId);

        const result = await sendClientEmail(organizationId, user, body);
        return json(req, { ok: true, ...result });
      }

      case 'addSendingDomain': {
        requireDomainAdmin(role);
        const domain = await addSendingDomain(organizationId, body);
        return json(req, { ok: true, domain });
      }

      case 'verifySendingDomain': {
        requireDomainAdmin(role);
        const domain = await verifySendingDomain(organizationId, body);
        return json(req, { ok: true, domain });
      }

      case 'updateSendingDomain': {
        requireDomainAdmin(role);
        const domain = await updateSendingDomain(organizationId, body);
        return json(req, { ok: true, domain });
      }

      case 'removeSendingDomain': {
        requireDomainAdmin(role);
        await removeSendingDomain(organizationId, body);
        return json(req, { ok: true });
      }

      default:
        return json(
          req,
          { ok: false, error: `Onbekende mail action: ${action}` },
          400,
        );
    }
  } catch (error) {
    const status = error instanceof MailHttpError ? error.status : 500;
    const internalMessage =
      error instanceof Error ? error.message : 'Onbekende fout.';

    if (status >= 500) {
      console.error('mail function error', internalMessage);
    }

    const publicMessage =
      error instanceof MailHttpError
        ? error.message
        : 'Mailactie mislukt door een server- of providerfout. Controleer de Edge Function logs.';

    return json(req, { ok: false, error: publicMessage }, status);
  }
});

async function sendTestEmail(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<{ providerEmailId: string; recipientEmail: string }> {
  if (!RESEND_API_KEY) {
    throw new MailHttpError(
      'RESEND_API_KEY ontbreekt in de Edge Function secrets.',
      500,
    );
  }

  if (!RESEND_FROM_EMAIL) {
    throw new MailHttpError(
      'RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.',
      500,
    );
  }

  const recipientEmail = String(body.recipientEmail || '')
    .trim()
    .toLowerCase();

  const recipientName = String(body.recipientName || '').trim();

  if (!isEmail(recipientEmail)) {
    throw new MailHttpError(
      'Vul een geldig e-mailadres in voor de testmail.',
      422,
    );
  }

  const organization = await loadOrganization(organizationId);
  const company = await loadCompanySettings(organizationId);

  const organizationName =
    company?.trade_name ||
    company?.company_name ||
    organization.name ||
    'ResoFly';

  const subject = `Resend testmail vanuit ${organizationName}`;
  const html = buildTestEmailHtml({ organizationName, recipientName });
  const text = buildTestEmailText({ organizationName, recipientName });

  const sender = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);

  const resendPayload = await sendViaResend(
    {
      from: sender.from,
      to: [recipientEmail],
      reply_to: sender.replyTo,
      subject,
      html,
      text,
    },
    `mail-test-${sanitizeIdempotencyPart(organizationId)}-${crypto.randomUUID()}`,
  );

  const providerEmailId = String(
    resendPayload.id || resendPayload.email_id || '',
  ).trim();

  if (!providerEmailId) {
    throw new MailHttpError(
      'Resend heeft de testmail aangenomen, maar gaf geen e-mail-ID terug.',
      502,
    );
  }

  return {
    providerEmailId,
    recipientEmail,
  };
}

async function sendClientPortalWelcome(
  req: Request,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<{ providerEmailId: string; recipientEmail: string }> {
  if (!RESEND_API_KEY) {
    throw new MailHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  }
  if (!RESEND_FROM_EMAIL) {
    throw new MailHttpError('RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.', 500);
  }

  const clientId = String(body.clientId || '').trim();
  if (!isUuid(clientId)) {
    throw new MailHttpError('Ongeldige klant.', 400);
  }

  const client = await loadClient(organizationId, clientId);
  const recipientEmail = String(client.email || '').trim().toLowerCase();
  if (!isEmail(recipientEmail)) {
    throw new MailHttpError(
      'Deze klant heeft geen geldig e-mailadres, dus er kan geen welkomstmail worden verstuurd.',
      422,
    );
  }

  const organization = await loadOrganization(organizationId);
  const company = await loadCompanySettings(organizationId);
  const organizationName =
    company?.trade_name || company?.company_name || organization.name || 'ResoFly';

  const portalUrl = `${resolvePortalBaseUrl(req)}/portal`;
  const recipientName = String(client.contact_name || client.name || '').trim();

  const subject = `Welkom bij ${organizationName} — je klantportaal staat klaar`;
  const html = buildClientWelcomeHtml({ organizationName, recipientName, recipientEmail, portalUrl });
  const text = buildClientWelcomeText({ organizationName, recipientName, recipientEmail, portalUrl });

  const sender = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);

  const resendPayload = await sendViaResend(
    {
      from: sender.from,
      to: [recipientEmail],
      reply_to: sender.replyTo,
      subject,
      html,
      text,
    },
    `client-welcome-${sanitizeIdempotencyPart(organizationId)}-${sanitizeIdempotencyPart(clientId)}`,
  );

  const providerEmailId = String(resendPayload.id || resendPayload.email_id || '').trim();
  if (!providerEmailId) {
    throw new MailHttpError(
      'Resend heeft de welkomstmail aangenomen, maar gaf geen e-mail-ID terug.',
      502,
    );
  }

  return { providerEmailId, recipientEmail };
}

async function loadClient(
  organizationId: string,
  clientId: string,
): Promise<{ id: string; name: string; contact_name: string | null; email: string | null }> {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,contact_name,email')
    .eq('id', clientId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new MailHttpError('Klant niet gevonden.', 404);
  }

  return data as { id: string; name: string; contact_name: string | null; email: string | null };
}

function resolvePortalBaseUrl(req: Request): string {
  if (CLIENT_PORTAL_BASE_URL) return CLIENT_PORTAL_BASE_URL;
  // De origin is hierboven al gevalideerd via assertAllowedOrigin, dus veilig als basis.
  return (req.headers.get('origin') || '').replace(/\/$/, '');
}

function buildClientWelcomeHtml(input: {
  organizationName: string;
  recipientName: string;
  recipientEmail: string;
  portalUrl: string;
}): string {
  const name = escapeHtml(input.recipientName || 'daar');
  const org = escapeHtml(input.organizationName);
  const email = escapeHtml(input.recipientEmail);
  const url = escapeHtml(input.portalUrl);

  return `<!doctype html>
<html>
  <body style="margin:0;background:#111111;font-family:Arial,sans-serif;color:#f5f5f5;">
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <div style="background:#1b1b1f;border:1px solid #303038;border-radius:24px;padding:28px;">
        <p style="margin:0 0 8px;color:#FFD966;font-size:13px;text-transform:uppercase;letter-spacing:.08em;">
          ${org}
        </p>

        <h1 style="margin:0 0 16px;font-size:26px;line-height:1.2;color:#ffffff;">
          Welkom in je klantportaal
        </h1>

        <p style="margin:0 0 16px;color:#d8d8df;font-size:16px;line-height:1.6;">
          Hoi ${name},<br/>
          ${org} werkt met een online klantportaal. Daar vind je op één plek je
          <strong>facturen, offertes, tickets en lopende projecten</strong>.
        </p>

        <p style="margin:0 0 24px;color:#d8d8df;font-size:16px;line-height:1.6;">
          Inloggen kan zonder wachtwoord: ga naar het portaal en vul je e-mailadres
          (<strong>${email}</strong>) in. Je ontvangt dan een veilige inloglink in je mailbox.
        </p>

        <a href="${url}" style="display:inline-block;background:#FFD966;color:#1a1a1a;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:10px;">
          Open het klantportaal
        </a>

        <p style="margin:24px 0 0;color:#9b9ba7;font-size:13px;line-height:1.5;">
          Werkt de knop niet? Kopieer deze link naar je browser:<br/>${url}
        </p>
      </div>
      <p style="margin:16px 4px 0;color:#6f6f78;font-size:12px;line-height:1.5;">
        Je ontvangt deze e-mail omdat ${org} een klantdossier voor je heeft aangemaakt.
      </p>
    </div>
  </body>
</html>`;
}

function buildClientWelcomeText(input: {
  organizationName: string;
  recipientName: string;
  recipientEmail: string;
  portalUrl: string;
}): string {
  return [
    input.organizationName,
    'Welkom in je klantportaal',
    '',
    `Hoi ${input.recipientName || 'daar'},`,
    `${input.organizationName} werkt met een online klantportaal. Daar vind je op één plek je facturen, offertes, tickets en lopende projecten.`,
    '',
    `Inloggen kan zonder wachtwoord: ga naar ${input.portalUrl} en vul je e-mailadres (${input.recipientEmail}) in. Je ontvangt dan een veilige inloglink in je mailbox.`,
    '',
    `Open het klantportaal: ${input.portalUrl}`,
    '',
    `Je ontvangt deze e-mail omdat ${input.organizationName} een klantdossier voor je heeft aangemaakt.`,
  ].join('\n');
}

// ── Teamuitnodiging versturen ───────────────────────────────────────────────

async function sendTeamInvitation(
  req: Request,
  organizationId: string,
  user: { id: string; email?: string },
  body: Record<string, unknown>,
): Promise<{ providerEmailId: string; recipientEmail: string }> {
  if (!RESEND_API_KEY) {
    throw new MailHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  }
  if (!RESEND_FROM_EMAIL) {
    throw new MailHttpError('RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.', 500);
  }

  const invitationId = String(body.invitationId || '').trim();
  if (!isUuid(invitationId)) {
    throw new MailHttpError('Ongeldige uitnodiging.', 400);
  }

  const invitation = await loadInvitation(organizationId, invitationId);
  const recipientEmail = String(invitation.email || '').trim().toLowerCase();
  if (!isEmail(recipientEmail)) {
    throw new MailHttpError('Deze uitnodiging heeft geen geldig e-mailadres.', 422);
  }

  // Zelf-registratie staat op instance-niveau uit ("Signups not allowed"). De
  // uitgenodigde heeft nog geen auth-account, dus een magische inloglink zou
  // anders falen. Maak het account daarom hier server-side alvast aan (service
  // role, idempotent) — net als portal-login voor klanten doet. Dit gebeurt vóór
  // de Resend-verzending, zodat een mislukte mail het account niet in de weg zit:
  // het teamlid kan dan alsnog zelf inloggen en de uitnodiging accepteren.
  await ensureAuthUser(recipientEmail);

  const organization = await loadOrganization(organizationId);
  const company = await loadCompanySettings(organizationId);
  const organizationName =
    company?.trade_name || company?.company_name || organization.name || 'ResoFly';

  const roleLabel = ROLE_LABELS[invitation.role as OrganizationRole] || 'Teamlid';
  const inviterEmail = String(user.email || '').trim();
  const appUrl = resolveAppBaseUrl(req);

  const subject = `Je bent uitgenodigd voor ${organizationName}`;
  const html = buildTeamInvitationHtml({ organizationName, recipientEmail, roleLabel, inviterEmail, appUrl });
  const text = buildTeamInvitationText({ organizationName, recipientEmail, roleLabel, inviterEmail, appUrl });

  const sender = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);

  // Idempotency op invitation-id + updated_at: een nieuwe/herhaalde uitnodiging
  // (RPC zet updated_at = now() bij re-invite) levert een verse verzending op,
  // terwijl een dubbele klik binnen dezelfde staat door Resend wordt ontdubbeld.
  const resendPayload = await sendViaResend(
    {
      from: sender.from,
      to: [recipientEmail],
      reply_to: sender.replyTo,
      subject,
      html,
      text,
    },
    `team-invite-${sanitizeIdempotencyPart(invitationId)}-${sanitizeIdempotencyPart(invitation.updated_at)}`,
  );

  const providerEmailId = String(resendPayload.id || resendPayload.email_id || '').trim();
  if (!providerEmailId) {
    throw new MailHttpError(
      'Resend heeft de uitnodiging aangenomen, maar gaf geen e-mail-ID terug.',
      502,
    );
  }

  return { providerEmailId, recipientEmail };
}

/** Zorgt dat er een auth-account bestaat voor dit e-mailadres, zodat de magische
 *  inloglink werkt terwijl zelf-registratie op instance-niveau uit staat.
 *  Idempotent: een al bestaand account is het gewenste eindresultaat, geen fout.
 *  email_confirm = true zodat de link direct werkt zonder aparte bevestigingsstap. */
async function ensureAuthUser(email: string): Promise<void> {
  const { error } = await supabaseAdmin.auth.admin.createUser({ email, email_confirm: true });
  if (!error) return;
  const message = (error.message || '').toLowerCase();
  if (message.includes('already') || message.includes('registered') || message.includes('exists')) return;
  throw error;
}

async function loadInvitation(
  organizationId: string,
  invitationId: string,
): Promise<{ id: string; email: string; role: string; status: string; expires_at: string | null; updated_at: string }> {
  const { data, error } = await supabaseAdmin
    .from('organization_invitations')
    .select('id,email,role,status,expires_at,updated_at')
    .eq('id', invitationId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new MailHttpError('Uitnodiging niet gevonden.', 404);
  }
  if (data.status !== 'pending') {
    throw new MailHttpError('Deze uitnodiging staat niet meer open.', 409);
  }
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    throw new MailHttpError('Deze uitnodiging is verlopen.', 409);
  }

  return data as { id: string; email: string; role: string; status: string; expires_at: string | null; updated_at: string };
}

function resolveAppBaseUrl(req: Request): string {
  if (APP_BASE_URL) return APP_BASE_URL;
  // De origin is via assertAllowedOrigin al gevalideerd, dus veilig als fallback.
  return (req.headers.get('origin') || '').replace(/\/$/, '');
}

function buildTeamInvitationHtml(input: {
  organizationName: string;
  recipientEmail: string;
  roleLabel: string;
  inviterEmail: string;
  appUrl: string;
}): string {
  const org = escapeHtml(input.organizationName);
  const email = escapeHtml(input.recipientEmail);
  const role = escapeHtml(input.roleLabel);
  const url = escapeHtml(input.appUrl);
  const inviter = input.inviterEmail ? escapeHtml(input.inviterEmail) : '';
  const invitedByLine = inviter
    ? `${inviter} heeft je uitgenodigd om samen te werken in ${org}.`
    : `Je bent uitgenodigd om samen te werken in ${org}.`;
  const button = url
    ? `<a href="${url}" style="display:inline-block;background:#FFD966;color:#1a1a1a;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:10px;">
          Open ${org}
        </a>`
    : '';
  const buttonFallback = url
    ? `<p style="margin:24px 0 0;color:#9b9ba7;font-size:13px;line-height:1.5;">
          Werkt de knop niet? Kopieer deze link naar je browser:<br/>${url}
        </p>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;background:#111111;font-family:Arial,sans-serif;color:#f5f5f5;">
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <div style="background:#1b1b1f;border:1px solid #303038;border-radius:24px;padding:28px;">
        <p style="margin:0 0 8px;color:#FFD966;font-size:13px;text-transform:uppercase;letter-spacing:.08em;">
          ${org}
        </p>

        <h1 style="margin:0 0 16px;font-size:26px;line-height:1.2;color:#ffffff;">
          Je bent uitgenodigd als teamlid
        </h1>

        <p style="margin:0 0 16px;color:#d8d8df;font-size:16px;line-height:1.6;">
          ${invitedByLine}<br/>
          Je rol wordt <strong>${role}</strong>.
        </p>

        <p style="margin:0 0 24px;color:#d8d8df;font-size:16px;line-height:1.6;">
          Inloggen kan zonder wachtwoord: ga naar de app en vul je e-mailadres
          (<strong>${email}</strong>) in. Je ontvangt dan een veilige inloglink. Na het
          inloggen zie je de uitnodiging staan en kun je die met één klik accepteren.
        </p>

        ${button}
        ${buttonFallback}
      </div>
      <p style="margin:16px 4px 0;color:#6f6f78;font-size:12px;line-height:1.5;">
        Je ontvangt deze e-mail omdat iemand je heeft uitgenodigd voor ${org}.
        Gebruik je dit e-mailadres niet, dan kun je deze e-mail negeren.
      </p>
    </div>
  </body>
</html>`;
}

function buildTeamInvitationText(input: {
  organizationName: string;
  recipientEmail: string;
  roleLabel: string;
  inviterEmail: string;
  appUrl: string;
}): string {
  const invitedByLine = input.inviterEmail
    ? `${input.inviterEmail} heeft je uitgenodigd om samen te werken in ${input.organizationName}.`
    : `Je bent uitgenodigd om samen te werken in ${input.organizationName}.`;
  return [
    input.organizationName,
    'Je bent uitgenodigd als teamlid',
    '',
    invitedByLine,
    `Je rol wordt ${input.roleLabel}.`,
    '',
    `Inloggen kan zonder wachtwoord: ga naar ${input.appUrl || 'de app'} en vul je e-mailadres (${input.recipientEmail}) in. Je ontvangt dan een veilige inloglink. Na het inloggen zie je de uitnodiging staan en kun je die accepteren.`,
    '',
    input.appUrl ? `Open de app: ${input.appUrl}` : '',
    '',
    `Je ontvangt deze e-mail omdat iemand je heeft uitgenodigd voor ${input.organizationName}.`,
  ].filter(Boolean).join('\n');
}

// ── Vrije klant-mail versturen + loggen ─────────────────────────────────────

async function sendClientEmail(
  organizationId: string,
  user: { id: string; email?: string },
  body: Record<string, unknown>,
): Promise<{ threadId: string; clientEmailId: string; providerEmailId: string; recipientEmail: string }> {
  if (!RESEND_API_KEY) {
    throw new MailHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  }

  const clientId = String(body.clientId || '').trim();
  if (!isUuid(clientId)) {
    throw new MailHttpError('Ongeldige klant.', 400);
  }

  const subject = String(body.subject || '').trim();
  if (!subject) {
    throw new MailHttpError('Vul een onderwerp in.', 422);
  }

  const bodyHtmlInput = String(body.bodyHtml || '').trim();
  const bodyTextInput = String(body.bodyText || '').trim();
  if (!bodyHtmlInput && !bodyTextInput) {
    throw new MailHttpError('De e-mail heeft geen inhoud.', 422);
  }

  const client = await loadClient(organizationId, clientId);
  const recipientEmail = String(client.email || '').trim().toLowerCase();
  if (!isEmail(recipientEmail)) {
    throw new MailHttpError('Deze klant heeft geen geldig e-mailadres.', 422);
  }

  const organization = await loadOrganization(organizationId);
  const company = await loadCompanySettings(organizationId);
  const organizationName =
    company?.trade_name || company?.company_name || organization.name || 'ResoFly';

  // Persoonlijke afzender van het versturende teamlid (indien ingesteld) —
  // naam altijd, adres alleen op een geverifieerd org-domein.
  const sender = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO, user.id);
  if (!sender.from) {
    throw new MailHttpError(
      'Er is nog geen afzenderadres geconfigureerd. Koppel eerst een verzenddomein of stel RESEND_FROM_EMAIL in.',
      422,
    );
  }
  const fromEmailForRow = sender.fromEmail || extractEmailAddress(sender.from);
  const fromNameForRow = extractDisplayName(sender.from);

  // 1. Thread aanmaken.
  const { data: thread, error: threadError } = await supabaseAdmin
    .from('client_email_threads')
    .insert({
      organization_id: organizationId,
      client_id: clientId,
      created_by: user.id,
      subject,
      last_direction: 'outbound',
      last_message_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (threadError) throw threadError;
  const threadId = String(thread.id);

  // 2. Outbound bericht-rij (queued) zodat we een id hebben voor de Reply-To.
  const { data: emailRow, error: emailError } = await supabaseAdmin
    .from('client_emails')
    .insert({
      organization_id: organizationId,
      thread_id: threadId,
      client_id: clientId,
      created_by: user.id,
      direction: 'outbound',
      provider: 'resend',
      from_email: fromEmailForRow,
      from_name: fromNameForRow,
      to_email: recipientEmail,
      subject,
      body_html: bodyHtmlInput || null,
      body_text: bodyTextInput || htmlToText(bodyHtmlInput),
      status: 'queued',
    })
    .select('id')
    .single();
  if (emailError) throw emailError;
  const clientEmailId = String(emailRow.id);

  // 3. Reply-To bepalen — fase C-klaar: als het inbound-domein staat, komen
  // antwoorden terug als reply+<id>@inbound..., anders een gewone Reply-To.
  const replyTo = MAIL_INBOUND_DOMAIN
    ? `reply+${clientEmailId}@${MAIL_INBOUND_DOMAIN}`
    : (sender.replyTo || fromEmailForRow || undefined);

  const html = buildClientEmailHtml({
    organizationName,
    bodyHtml: bodyHtmlInput || escapeHtml(bodyTextInput).replace(/\n/g, '<br/>'),
  });
  const text = bodyTextInput || htmlToText(bodyHtmlInput);

  // 4. Versturen via Resend; bij een providerfout de rij als 'failed' markeren.
  let providerEmailId = '';
  try {
    const resendPayload = await sendViaResend(
      {
        from: sender.from,
        to: [recipientEmail],
        reply_to: replyTo,
        subject,
        html,
        text,
        tags: [
          { name: 'organization_id', value: sanitizeTagValue(organizationId) },
          { name: 'client_id', value: sanitizeTagValue(clientId) },
          { name: 'client_email_id', value: sanitizeTagValue(clientEmailId) },
        ],
      },
      `client-email-${sanitizeIdempotencyPart(clientEmailId)}`,
    );
    providerEmailId = String(resendPayload.id || resendPayload.email_id || '').trim();
  } catch (error) {
    const now = new Date().toISOString();
    await supabaseAdmin
      .from('client_emails')
      .update({
        status: 'failed',
        failed_at: now,
        last_event_at: now,
        error_message: error instanceof Error ? error.message : 'Versturen mislukt.',
      })
      .eq('id', clientEmailId);
    throw error;
  }

  // 5. Rij + thread bijwerken na succesvolle verzending.
  const sentAt = new Date().toISOString();
  await supabaseAdmin
    .from('client_emails')
    .update({ status: 'sent', sent_at: sentAt, last_event_at: sentAt, provider_email_id: providerEmailId || null })
    .eq('id', clientEmailId);
  await supabaseAdmin
    .from('client_email_threads')
    .update({ last_message_at: sentAt, last_direction: 'outbound' })
    .eq('id', threadId);

  return { threadId, clientEmailId, providerEmailId, recipientEmail };
}

function buildClientEmailHtml(input: { organizationName: string; bodyHtml: string }): string {
  const org = escapeHtml(input.organizationName);
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
    <div style="max-width:640px;margin:0 auto;padding:28px 20px;">
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;padding:28px;line-height:1.6;font-size:15px;">
        ${input.bodyHtml}
      </div>
      <p style="margin:14px 4px 0;color:#8a8a92;font-size:12px;line-height:1.5;">${org}</p>
    </div>
  </body>
</html>`;
}

function extractEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

function extractDisplayName(value: string): string | null {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*</);
  const name = match ? match[1].trim() : '';
  return name || null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || 'unknown';
}

// ── Eigen-domein e-mail: verzenddomeinen ────────────────────────────────────

type SendingDomainRow = {
  id: string;
  organization_id: string;
  created_by: string | null;
  domain: string;
  provider: string;
  resend_domain_id: string | null;
  region: string | null;
  from_email: string | null;
  from_name: string | null;
  status: string;
  dns_records: unknown;
  is_default: boolean;
  last_checked_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

const SENDING_DOMAIN_COLUMNS =
  'id,organization_id,created_by,domain,provider,resend_domain_id,region,from_email,from_name,status,dns_records,is_default,last_checked_at,verified_at,created_at,updated_at';

function requireDomainAdmin(role: OrganizationRole): void {
  if (!['owner', 'admin'].includes(role)) {
    throw new MailHttpError('Alleen owners en admins kunnen verzenddomeinen beheren.', 403);
  }
}

/**
 * Klantcommunicatie (portaal-welkomstmail, vrije klantmail) valt onder de module
 * Klanten. Deze functie draait op de service-role en omzeilt RLS, dus de
 * modulerechten van het teamlid controleren we hier expliciet.
 */
async function assertClientModuleWrite(userId: string, organizationId: string): Promise<void> {
  const level = await getModuleLevel(supabaseAdmin, userId, organizationId, 'clients');
  if (level !== 'write') {
    throw new MailHttpError(
      level === 'none'
        ? 'Je hebt geen toegang tot de module Klanten in deze organisatie.'
        : 'Je mag niets wijzigen in de module Klanten van deze organisatie.',
      403,
    );
  }
}

async function addSendingDomain(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<SendingDomainRow> {
  if (!RESEND_API_KEY) {
    throw new MailHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  }

  const domain = normalizeDomain(String(body.domain || ''));
  if (!isDomain(domain)) {
    throw new MailHttpError('Vul een geldig domein in, bijvoorbeeld eigendomeinnaam.nl.', 422);
  }

  const fromName = String(body.fromName || '').trim() || null;
  const fromEmail = normalizeFromEmail(body.fromEmail, domain);

  // Voorkom dubbele Resend-aanmaak als dit domein al gekoppeld is.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('organization_email_domains')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('domain', domain)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    throw new MailHttpError('Dit domein is al gekoppeld aan deze organisatie.', 409);
  }

  const resendDomain = await createResendDomain(domain);
  const status = mapResendDomainStatus(String(resendDomain.status || 'pending'));
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('organization_email_domains')
    .insert({
      organization_id: organizationId,
      domain,
      provider: 'resend',
      resend_domain_id: String(resendDomain.id || '') || null,
      region: String(resendDomain.region || RESEND_DEFAULT_REGION) || null,
      from_email: fromEmail,
      from_name: fromName,
      status,
      dns_records: Array.isArray(resendDomain.records) ? resendDomain.records : [],
      last_checked_at: now,
      verified_at: status === 'verified' ? now : null,
    })
    .select(SENDING_DOMAIN_COLUMNS)
    .single();
  if (error) throw error;
  return data as SendingDomainRow;
}

async function verifySendingDomain(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<SendingDomainRow> {
  if (!RESEND_API_KEY) {
    throw new MailHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  }
  const row = await loadSendingDomainRow(organizationId, String(body.domainId || ''));
  if (!row.resend_domain_id) {
    throw new MailHttpError(
      'Dit domein heeft geen Resend-koppeling meer; verwijder en voeg het opnieuw toe.',
      422,
    );
  }

  // Trigger de controle en lees daarna de bijgewerkte status + records.
  await triggerResendDomainVerification(row.resend_domain_id);
  const resendDomain = await getResendDomain(row.resend_domain_id);
  const status = mapResendDomainStatus(String(resendDomain.status || row.status));
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('organization_email_domains')
    .update({
      status,
      dns_records: Array.isArray(resendDomain.records) ? resendDomain.records : row.dns_records,
      last_checked_at: now,
      verified_at: status === 'verified' ? (row.verified_at || now) : null,
    })
    .eq('id', row.id)
    .eq('organization_id', organizationId)
    .select(SENDING_DOMAIN_COLUMNS)
    .single();
  if (error) throw error;
  return data as SendingDomainRow;
}

async function updateSendingDomain(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<SendingDomainRow> {
  const row = await loadSendingDomainRow(organizationId, String(body.domainId || ''));
  const patch: Record<string, unknown> = {};

  if (body.fromName !== undefined) {
    patch.from_name = String(body.fromName || '').trim() || null;
  }
  if (body.fromEmail !== undefined) {
    patch.from_email = normalizeFromEmail(body.fromEmail, row.domain);
  }

  if (body.isDefault === true) {
    if (row.status !== 'verified') {
      throw new MailHttpError(
        'Alleen een geverifieerd domein kan het standaard verzenddomein worden.',
        422,
      );
    }
    // Eerst andere domeinen op niet-standaard zetten (partial unique index per org).
    const { error: clearError } = await supabaseAdmin
      .from('organization_email_domains')
      .update({ is_default: false })
      .eq('organization_id', organizationId)
      .neq('id', row.id)
      .eq('is_default', true);
    if (clearError) throw clearError;
    patch.is_default = true;
  } else if (body.isDefault === false) {
    patch.is_default = false;
  }

  if (Object.keys(patch).length === 0) return row;

  const { data, error } = await supabaseAdmin
    .from('organization_email_domains')
    .update(patch)
    .eq('id', row.id)
    .eq('organization_id', organizationId)
    .select(SENDING_DOMAIN_COLUMNS)
    .single();
  if (error) throw error;
  return data as SendingDomainRow;
}

async function removeSendingDomain(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const row = await loadSendingDomainRow(organizationId, String(body.domainId || ''));
  if (row.resend_domain_id) {
    await deleteResendDomain(row.resend_domain_id);
  }
  const { error } = await supabaseAdmin
    .from('organization_email_domains')
    .delete()
    .eq('id', row.id)
    .eq('organization_id', organizationId);
  if (error) throw error;
}

async function loadSendingDomainRow(
  organizationId: string,
  domainId: string,
): Promise<SendingDomainRow> {
  if (!isUuid(domainId)) {
    throw new MailHttpError('Ongeldig domein-id.', 400);
  }
  const { data, error } = await supabaseAdmin
    .from('organization_email_domains')
    .select(SENDING_DOMAIN_COLUMNS)
    .eq('id', domainId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new MailHttpError('Verzenddomein niet gevonden.', 404);
  }
  return data as SendingDomainRow;
}

async function createResendDomain(domain: string): Promise<Record<string, unknown>> {
  return await resendDomainsRequest('POST', '', { name: domain, region: RESEND_DEFAULT_REGION });
}

async function getResendDomain(resendDomainId: string): Promise<Record<string, unknown>> {
  return await resendDomainsRequest('GET', `/${resendDomainId}`);
}

async function triggerResendDomainVerification(resendDomainId: string): Promise<void> {
  // De verify-trigger geeft minimale data terug; de status lezen we apart via GET.
  // Een mislukte trigger mag die GET niet blokkeren, dus we loggen en gaan door.
  try {
    await resendDomainsRequest('POST', `/${resendDomainId}/verify`);
  } catch (error) {
    console.warn('Resend domain verify trigger failed', error instanceof Error ? error.message : error);
  }
}

async function deleteResendDomain(resendDomainId: string): Promise<void> {
  // Best-effort: lukt het verwijderen bij Resend niet, dan ruimen we lokaal toch op.
  try {
    await resendDomainsRequest('DELETE', `/${resendDomainId}`);
  } catch (error) {
    console.warn('Resend domain delete failed', error instanceof Error ? error.message : error);
  }
}

async function resendDomainsRequest(
  method: string,
  path: string,
  payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.resend.com/domains${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const responsePayload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    console.error('Resend domains API failed', method, path, responsePayload);
    const providerMessage = String(
      responsePayload.message ||
        responsePayload.error ||
        response.statusText ||
        'Resend domains API failed',
    );
    throw new MailHttpError(`Resend kon de domeinactie niet uitvoeren: ${providerMessage}`, 502);
  }

  return responsePayload;
}

function mapResendDomainStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'verified') return 'verified';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'temporary_failure') return 'temporary_failure';
  // not_started, pending en onbekende statussen tonen we als "pending".
  return 'pending';
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

function isDomain(value: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);
}

function normalizeFromEmail(value: unknown, domain: string): string | null {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return null;
  if (!isEmail(email)) {
    throw new MailHttpError('Het afzenderadres is geen geldig e-mailadres.', 422);
  }
  if (!email.endsWith(`@${domain}`)) {
    throw new MailHttpError(`Het afzenderadres moet op @${domain} eindigen.`, 422);
  }
  return email;
}

async function sendViaResend(
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    console.error('Resend send failed', responsePayload);

    const providerMessage = String(
      responsePayload.message ||
        responsePayload.error ||
        response.statusText ||
        'Resend send failed',
    );

    throw new MailHttpError(
      `Resend kon de e-mail niet versturen: ${providerMessage}`,
      502,
    );
  }

  return responsePayload;
}

async function loadOrganization(
  organizationId: string,
): Promise<{ id: string; name: string }> {
  if (!isUuid(organizationId)) {
    throw new MailHttpError('Ongeldige organisatie.', 400);
  }

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('id,name')
    .eq('id', organizationId)
    .single();

  if (error || !data) {
    throw new MailHttpError('Organisatie niet gevonden.', 404);
  }

  return data as { id: string; name: string };
}

async function loadCompanySettings(
  organizationId: string,
): Promise<{ company_name: string; trade_name: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('company_settings')
    .select('company_name,trade_name')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as {
    company_name: string;
    trade_name: string | null;
  } | null;
}

function buildTestEmailHtml(input: {
  organizationName: string;
  recipientName: string;
}): string {
  const name = escapeHtml(input.recipientName || 'Gerjan');
  const organizationName = escapeHtml(input.organizationName);

  return `<!doctype html>
<html>
  <body style="margin:0;background:#111111;font-family:Arial,sans-serif;color:#f5f5f5;">
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <div style="background:#1b1b1f;border:1px solid #303038;border-radius:24px;padding:28px;">
        <p style="margin:0 0 8px;color:#FFD966;font-size:13px;text-transform:uppercase;letter-spacing:.08em;">
          ${organizationName}
        </p>

        <h1 style="margin:0 0 16px;font-size:28px;line-height:1.15;color:#ffffff;">
          Resend is gekoppeld 🚀
        </h1>

        <p style="margin:0;color:#d8d8df;font-size:16px;line-height:1.6;">
          Hoi ${name},<br/>
          Deze testmail is server-side verzonden vanuit je Supabase Edge Function.
          Je API-key staat dus niet in de browser.
        </p>

        <p style="margin:24px 0 0;color:#9b9ba7;font-size:13px;line-height:1.5;">
          Je kunt deze basis nu gebruiken voor offerte-mails, factuur-mails,
          uitnodigingen en notificaties.
        </p>
      </div>
    </div>
  </body>
</html>`;
}

function buildTestEmailText(input: {
  organizationName: string;
  recipientName: string;
}): string {
  return [
    input.organizationName,
    'Resend is gekoppeld',
    '',
    `Hoi ${input.recipientName || 'Gerjan'},`,
    'Deze testmail is server-side verzonden vanuit je Supabase Edge Function.',
    'Je API-key staat dus niet in de browser.',
    '',
    'Je kunt deze basis nu gebruiken voor offerte-mails, factuur-mails, uitnodigingen en notificaties.',
  ].join('\n');
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';

  const allowOrigin =
    MAIL_ALLOWED_ORIGINS.includes(origin) ||
    (MAIL_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
      ? origin
      : MAIL_ALLOW_LOCAL_DEV && !origin
        ? '*'
        : 'null';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json',
    },
  });
}

function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get('origin') || '';

  if (!origin && MAIL_ALLOW_LOCAL_DEV) {
    return;
  }

  if (MAIL_ALLOWED_ORIGINS.includes(origin)) {
    return;
  }

  if (MAIL_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) {
    return;
  }

  if (MAIL_ALLOWED_ORIGINS.length === 0 && MAIL_ALLOW_LOCAL_DEV) {
    return;
  }

  if (MAIL_ALLOWED_ORIGINS.length === 0) {
    throw new MailHttpError(
      'MAIL_ALLOWED_ORIGINS of QUOTE_ALLOWED_ORIGINS is verplicht in productie.',
      500,
    );
  }

  throw new MailHttpError(
    'Deze frontend-origin is niet toegestaan voor mailacties.',
    403,
  );
}

async function requireUser(
  req: Request,
): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');

  if (!token) {
    throw new MailHttpError(
      'Niet ingelogd: Authorization header ontbreekt.',
      401,
    );
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data.user) {
    throw new MailHttpError(
      'Niet ingelogd of ongeldig sessietoken.',
      401,
    );
  }

  return {
    id: data.user.id,
    email: data.user.email || undefined,
  };
}

async function requireOrganizationAccess(
  userId: string,
  organizationId: string,
): Promise<OrganizationRole> {
  if (!isUuid(organizationId)) {
    throw new MailHttpError('Ongeldige organisatie.', 400);
  }

  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);

  if (error) {
    throw error;
  }

  const role = data?.[0]?.role as OrganizationRole | undefined;

  if (!role) {
    throw new MailHttpError(
      'Geen toegang tot deze organisatie.',
      403,
    );
  }

  return role;
}

function isLocalOrigin(origin: string): boolean {
  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ].includes(origin);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };

    return replacements[char] || char;
  });
}

function sanitizeIdempotencyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'unknown';
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}