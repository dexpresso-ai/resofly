import { renderContractSentEmail } from './contractSent.ts';
import { renderContractSignedClientEmail } from './contractSignedClient.ts';
import { renderContractSignedInternalEmail } from './contractSignedInternal.ts';
import { renderCreditNoteSentEmail } from './creditNoteSent.ts';
import { renderInvoiceReminderEmail } from './invoiceReminder.ts';
import { renderInvoiceSentEmail } from './invoiceSent.ts';
import { renderQuoteSentEmail } from './quoteSent.ts';
import { renderResendTestEmail } from './testResend.ts';
import type { EmailTemplateInputMap, EmailTemplateKey, RenderedEmailTemplate } from './types.ts';

export type { EmailTemplateContent, EmailTemplateContentKey, EmailTemplateInputMap, EmailTemplateKey, RenderedEmailTemplate } from './types.ts';

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
    case 'contract.sent':
      return renderContractSentEmail(data as EmailTemplateInputMap['contract.sent']);
    case 'contract.signed.client':
      return renderContractSignedClientEmail(data as EmailTemplateInputMap['contract.signed.client']);
    case 'contract.signed.internal':
      return renderContractSignedInternalEmail(data as EmailTemplateInputMap['contract.signed.internal']);
    default: {
      const exhaustiveCheck: never = templateKey;
      throw new Error(`Unknown email template: ${exhaustiveCheck}`);
    }
  }
}
