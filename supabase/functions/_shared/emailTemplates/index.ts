import { renderCreditNoteSentEmail } from './creditNoteSent.ts';
import { renderInvoiceReminderEmail } from './invoiceReminder.ts';
import { renderInvoiceSentEmail } from './invoiceSent.ts';
import { renderQuoteSentEmail } from './quoteSent.ts';
import { renderResendTestEmail } from './testResend.ts';
import type { EmailTemplateInputMap, EmailTemplateKey, RenderedEmailTemplate } from './types.ts';

export type { EmailTemplateInputMap, EmailTemplateKey, RenderedEmailTemplate } from './types.ts';

export function renderEmailTemplate<K extends EmailTemplateKey>(templateKey: K, data: EmailTemplateInputMap[K]): RenderedEmailTemplate {
  switch (templateKey) {
    case 'test.resend':
      return renderResendTestEmail(data as EmailTemplateInputMap['test.resend']);
    case 'quote.sent':
      return renderQuoteSentEmail(data as EmailTemplateInputMap['quote.sent']);
    case 'invoice.sent':
      return renderInvoiceSentEmail(data as EmailTemplateInputMap['invoice.sent']);
    case 'invoice.reminder':
      return renderInvoiceReminderEmail(data as EmailTemplateInputMap['invoice.reminder']);
    case 'creditNote.sent':
      return renderCreditNoteSentEmail(data as EmailTemplateInputMap['creditNote.sent']);
    default: {
      const exhaustiveCheck: never = templateKey;
      throw new Error(`Unknown email template: ${exhaustiveCheck}`);
    }
  }
}
