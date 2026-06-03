export type EmailTemplateKey = 'test.resend' | 'quote.sent' | 'invoice.sent' | 'creditNote.sent';

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
};

export type EmailTemplateInputMap = {
  'test.resend': TestResendEmailInput;
  'quote.sent': QuoteSentEmailInput;
  'invoice.sent': InvoiceSentEmailInput;
  'creditNote.sent': CreditNoteSentEmailInput;
};
