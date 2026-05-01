import { supabase } from '../lib/supabase';
import type { OrganizationLicenseUsage, UUID } from '../types';

export async function loadLicenseUsage(organizationId: UUID): Promise<OrganizationLicenseUsage | null> {
  const { data, error } = await supabase.rpc('organization_license_usage', { p_organization_id: organizationId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as OrganizationLicenseUsage | null;
}

export async function recordInvitationBlockedBySeats(organizationId: UUID, email: string): Promise<void> {
  const { error } = await supabase.rpc('record_invitation_blocked_insufficient_seats', {
    p_organization_id: organizationId,
    p_email: email.trim().toLowerCase(),
  });
  if (error) {
    console.warn('Kon geblokkeerde uitnodiging niet in audit-log registreren.', error);
  }
}
