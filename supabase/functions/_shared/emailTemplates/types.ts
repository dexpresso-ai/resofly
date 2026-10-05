import type { EmailTemplateContent } from './content.ts';

export type { EmailTemplateContent } from './content.ts';

export type EmailTemplateKey =
  | 'test.resend'
  | 'quote.sent'
  | 'invoice.sent'
  | 'invoice.reminder'
  | 'invoice.dunning.wik14'
  | 'creditNote.sent'
  | 'contract.sent'
  | 'contract.signed.client'
  | 'contract.signed.internal'
  | 'file.shared'
  | 'portal.ticketUpdate';

// De per-organisatie tekstsleutels in de email_templates-tabel. Herinneringen
// hebben een sleutel per niveau; de overige sleutels komen overeen met de
// render-key. Gebruikt door de workflows om de juiste aangepaste copy te laden.
export type EmailTemplateContentKey =
  | 'quote.sent'
  | 'invoice.sent'
  | 'invoice.reminder.1'
  | 'invoice.reminder.2'
  | 'invoice.reminder.3'
  | 'invoice.dunning.wik14'
  | 'creditNote.sent'
  | 'contract.sent'
  | 'contract.signed.client'
  | 'file.shared'
  | PortalTicketTemplateKey;

/**
 * De aanpasbare teksten van de klantmelding over een ticket (portal-notify),
 * één per soort melding — dezelfde soorten die de klant in het portaal aan of
 * uit zet. Eén mail kan meer bevatten (een antwoord én een statuswijziging);
 * de tekst volgt dan de belangrijkste: ontvangen > nieuw ticket > antwoord > status.
 */
export type PortalTicketTemplateKey =
  | 'portal.ticket.received'
  | 'portal.ticket.created'
  | 'portal.ticket.reply'
  | 'portal.ticket.status';

export type RenderedEmailTemplate = {
  templateKey: EmailTemplateKey;
  subject: string;
  html: string;
  text: string;
};

export type TestResendEmailInput = {
  organizationName: string;
  recipientName?: string | null;
};

export type QuoteEmailLine = {
  description?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  vat?: number | null;
};


export type InvoiceEmailLine = QuoteEmailLine;

export type InvoiceSentEmailInput = {
  invoice: {
    number: string;
    due_date?: string | null;
    lines?: InvoiceEmailLine[] | null;
  };
  client: {
    name: string;
    contact_name?: string | null;
    email?: string | null;
  };
  project?: {
    name: string;
    description?: string | null;
  } | null;
  quote?: {
    number: string;
  } | null;
  company?: {
    company_name?: string | null;
    trade_name?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    invoice_accent_color?: string | null;
  } | null;
  publicUrl: string;
  paymentUrl?: string | null;
  recipientName?: string | null;
  expiresAt: string;
  content?: EmailTemplateContent | null;
};

export type InvoiceReminderEmailInput = {
  level: 1 | 2 | 3;
  invoice: {
    number: string;
    due_date?: string | null;
    lines?: InvoiceEmailLine[] | null;
  };
  client: {
    name: string;
    contact_name?: string | null;
    email?: string | null;
  };
  project?: {
    name: string;
    description?: string | null;
  } | null;
  company?: {
    company_name?: string | null;
    trade_name?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    invoice_accent_color?: string | null;
  } | null;
  publicUrl: string;
  paymentUrl?: string | null;
  recipientName?: string | null;
  daysOverdue?: number | null;
  content?: EmailTemplateContent | null;
};

export type InvoiceDunningWik14EmailInput = {
  clientKind: 'business' | 'consumer';
  invoice: {
    number: string;
    due_date?: string | null;
  };
  client: {
    name: string;
    contact_name?: string | null;
    email?: string | null;
  };
  company?: {
    company_name?: string | null;
    trade_name?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    invoice_accent_color?: string | null;
  } | null;
  amounts: {
    principalCents: number;
    interestCents: number;
    interestDays: number;
    collectionCostsCents: number;
    collectionCostsVatCents: number;
    totalClaimCents: number;
  };
  deadlineDate: string;
  publicUrl: string;
  paymentUrl?: string | null;
  recipientName?: string | null;
  content?: EmailTemplateContent | null;
};

export type QuoteSentEmailInput = {
  quote: {
    number: string;
    valid_until?: string | null;
    lines?: QuoteEmailLine[] | null;
  };
  client: {
    name: string;
    contact_name?: string | null;
    email?: string | null;
  };
  project?: {
    name: string;
    description?: string | null;
  } | null;
  company?: {
    company_name?: string | null;
    trade_name?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    invoice_accent_color?: string | null;
  } | null;
  publicUrl: string;
  recipientName?: string | null;
  expiresAt: string;
  content?: EmailTemplateContent | null;
};

export type CreditNoteSentEmailInput = {
  creditNote: {
    number: string;
    date?: string | null;
    total_amount?: number | string | null;
    currency?: string | null;
    reason?: string | null;
  };
  invoice: {
    number: string;
  };
  client: {
    name: string;
    contact_name?: string | null;
    email?: string | null;
  };
  company?: {
    company_name?: string | null;
    trade_name?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    invoice_accent_color?: string | null;
  } | null;
  recipientName?: string | null;
  content?: EmailTemplateContent | null;
};

type ContractEmailCompany = {
  company_name?: string | null;
  trade_name?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  invoice_accent_color?: string | null;
} | null;

export type ContractSentEmailInput = {
  contract: {
    number: string;
    title?: string | null;
    valid_until?: string | null;
  };
  client: {
    name: string;
    contact_name?: string | null;
    email?: string | null;
  };
  company?: ContractEmailCompany;
  publicUrl: string;
  recipientName?: string | null;
  personalMessage?: string | null;
  expiresAt: string;
  content?: EmailTemplateContent | null;
};

export type ContractSignedClientEmailInput = {
  contract: {
    number: string;
    title?: string | null;
  };
  client: {
    name: string;
    contact_name?: string | null;
    email?: string | null;
  };
  company?: ContractEmailCompany;
  signedAt: string;
  recipientName?: string | null;
  portalUrl?: string | null;
  content?: EmailTemplateContent | null;
};

export type ContractSignedInternalEmailInput = {
  contract: {
    number: string;
    title?: string | null;
  };
  client: {
    name: string;
  };
  company?: ContractEmailCompany;
  signerName: string;
  signerEmail?: string | null;
  signedAt: string;
  appUrl?: string | null;
};

/** "Iemand deelt een map/bestand/notitie/document met je" — portaal, collega of deellink. */
export type FileSharedEmailInput = {
  /** Naam van het gedeelde item, zoals het in de drive heet. */
  itemName: string;
  /** "Map" / "Bestand" / "Notitie" / "Document" — stuurt de koptekst en de knop. */
  itemKindLabel: string;
  /** Waar de ontvanger het opent: het portaal, de app of de deellink. */
  url: string;
  /** Eén regel die uitlegt hoe de ontvanger binnenkomt (inloggen met e-mail, enz.). */
  accessHint?: string | null;
  recipientName?: string | null;
  senderName?: string | null;
  clientName?: string | null;
  /** Vrij bericht van de afzender. Wordt altijd ge-escaped weergegeven. */
  personalMessage?: string | null;
  expiresAt?: string | null;
  company?: {
    company_name?: string | null;
    trade_name?: string | null;
    invoice_accent_color?: string | null;
  } | null;
  content?: EmailTemplateContent | null;
};

/**
 * Melding aan een klant over een ticket (klantportaal): ontvangen, nieuw
 * ticket, antwoord of status — of een paar daarvan samen. Wat erin zit bepaalt
 * _shared/portalNotify.ts; de tekst is (nog) niet per organisatie aan te passen.
 */
export type PortalTicketUpdateEmailInput = {
  companyName: string;
  accentColor?: string | null;
  /** Afsluittekst uit de huisstijl van de leverancier. */
  footerText?: string | null;
  recipientName?: string | null;
  ticket: { title: string; statusLabel: string };
  /** Diende de ontvanger het ticket zelf in? Dan "je ticket", anders "het ticket". */
  ownTicket: boolean;
  /** Ontvangstbevestiging van een ticket dat de ontvanger net zelf indiende. */
  confirmation: boolean;
  /** Een nieuw ticket dat iemand anders (het team of een collega) aanmaakte. */
  newTicket: boolean;
  /** Naam van de collega die het indiende; leeg als het team het aanmaakte. */
  createdBy?: string | null;
  /** Netto statuswijziging; `sentence` leest als "in behandeling genomen". */
  status?: { fromLabel: string | null; toLabel: string; sentence: string } | null;
  /** Antwoorden van anderen, oudste eerst. Platte tekst. */
  replies: Array<{ authorName: string; fromTeam: boolean; body: string; at: string }>;
  ticketUrl: string;
  settingsUrl: string;
  /** Naam van het klantdossier (plaatshouder {{client_name}}). */
  clientName?: string | null;
  /** Eigen teksten van de organisatie per soort melding (email_templates); ontbreekt = de standaardtekst. */
  content?: Partial<Record<PortalTicketTemplateKey, EmailTemplateContent | null>> | null;
};

export type EmailTemplateInputMap = {
  'test.resend': TestResendEmailInput;
  'quote.sent': QuoteSentEmailInput;
  'invoice.sent': InvoiceSentEmailInput;
  'invoice.reminder': InvoiceReminderEmailInput;
  'invoice.dunning.wik14': InvoiceDunningWik14EmailInput;
  'creditNote.sent': CreditNoteSentEmailInput;
  'contract.sent': ContractSentEmailInput;
  'contract.signed.client': ContractSignedClientEmailInput;
  'contract.signed.internal': ContractSignedInternalEmailInput;
  'file.shared': FileSharedEmailInput;
  'portal.ticketUpdate': PortalTicketUpdateEmailInput;
};
