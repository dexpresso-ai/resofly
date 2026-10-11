// ============================================================
// Rollen en modulerechten — één regel voor alle edge functions.
//
// Exacte spiegel van `public.member_module_level` in de database (migratie
// 20261011000000) en van resolveModuleLevel in src/lib/permissions.ts. Wijken
// ze af, dan volgt de database: dat is de waarheid.
//
// Puur, net als publicApi.ts: geen Deno-imports, zodat `npm test` er
// rechtstreeks overheen draait (roles.test.ts). edgeAuth, gerrieCore, de
// MCP-functie en de openbare API lezen het niveau allemaal hier — vroeger had
// elk zijn eigen kopie, en die gaven een rol die ze niet kenden stilletjes
// volledige toegang.
// ============================================================

export const ORGANIZATION_ROLES = ['owner', 'admin', 'member', 'viewer', 'accountant'] as const;
export type OrganizationRole = typeof ORGANIZATION_ROLES[number];

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
  accountant: 'Boekhouder',
};

/** Rollen die mogen wijzigen — als de module het ook toestaat. Een allowlist:
 *  een rol die hier niet staat, wijzigt niets. */
export const WRITER_ROLES: readonly OrganizationRole[] = ['owner', 'admin', 'member'];

export const MODULE_KEYS = [
  'clients', 'projects', 'time', 'calendar', 'tickets', 'content', 'stats', 'marketing', 'finance', 'chat', 'gerrie',
] as const;

export type ModuleKey = typeof MODULE_KEYS[number];
export type ModuleLevel = 'none' | 'read' | 'write';

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === 'string' && (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

export function isWriterRole(role: unknown): boolean {
  return typeof role === 'string' && (WRITER_ROLES as readonly string[]).includes(role);
}

/**
 * Wat het TEAMLID mag in deze module.
 *
 * - owner/admin: altijd volledig — zij stellen de rechten juist in;
 * - boekhouder (gast): Financiën alleen lezen, de rest dicht. Vast; wat er in
 *   module_access staat, telt dan niet;
 * - viewer: nooit meer dan lezen;
 * - member: wat er is ingesteld, en een ontbrekende sleutel = volledig;
 * - een rol die deze regel niet kent: niets.
 */
export function memberModuleLevel(
  role: string, moduleAccess: Record<string, unknown> | null | undefined, module: string,
): ModuleLevel {
  if (role === 'owner' || role === 'admin') return 'write';
  if (role === 'accountant') return module === 'finance' ? 'read' : 'none';
  const raw = moduleAccess?.[module];
  const stored: ModuleLevel = raw === 'none' || raw === 'read' || raw === 'write' ? raw : 'write';
  if (role === 'viewer') return stored === 'none' ? 'none' : 'read';
  if (role === 'member') return stored;
  return 'none';
}
