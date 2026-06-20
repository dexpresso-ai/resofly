import type { EmailTemplateContent } from './content.ts';

export type { EmailTemplateContent } from './content.ts';

export type EmailTemplateKey =
  | 'test.resend'
  | 'quote.sent'
  | 'invoice.sent'
  | 'invoice.reminder'
  | 'creditNote.sent'
  | 'contract.sent'
  | 'contract.signed.client'
  | 'contract.signed.internal';

// De per-organisatie tekstsleutels in de email_templates-tabel. Herinneringen
// hebben een sleutel per niveau; de overige sleutels komen overeen met de
// render-key. Gebruikt door de workflows om de juiste aangepaste copy te laden.
export type EmailTemplateContentKey =
  | 'quote.sent'
  | 'invoice.sent'
  | 'invoice.reminder.1'
  | 'invoice.reminder.2'
  | 'invoice.reminder.3'
  | 'creditNote.sent'
  | 'contract.sent'
  | 'contract.signed.client';

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

export type EmailTemplateInputMap = {
  'test.resend': TestResendEmailInput;
  'quote.sent': QuoteSentEmailInput;
  'invoice.sent': InvoiceSentEmailInput;
  'invoice.reminder': InvoiceReminderEmailInput;
  'creditNote.sent': CreditNoteSentEmailInput;
  'contract.sent': ContractSentEmailInput;
  'contract.signed.client': ContractSignedClientEmailInput;
  'contract.signed.internal': ContractSignedInternalEmailInput;
};
