import { throwFunctionError } from '../lib/functionErrors';
import { supabase } from '../lib/supabase';
import type { UUID } from '../types';

export interface SendResendTestEmailResult {
  providerEmailId: string;
  recipientEmail: string;
}

export async function sendResendTestEmail(
  organizationId: UUID,
  input: { recipientEmail: string; recipientName?: string },
): Promise<SendResendTestEmailResult> {
  const { data, error } = await supabase.functions.invoke('mail', {
    body: {
      action: 'sendTestEmail',
      organizationId,
      recipientEmail: input.recipientEmail,
      recipientName: input.recipientName,
    },
  });

  if (error) await throwFunctionError(error, 'Testmail verzenden mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Testmail verzenden mislukt.');

  return {
    providerEmailId: String(data.providerEmailId || ''),
    recipientEmail: String(data.recipientEmail || input.recipientEmail),
  };
}
