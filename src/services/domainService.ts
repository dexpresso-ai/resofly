// Het webadres van een organisatie (migratie 20261108230000): de naam bij
// ResoFly via de RPC's, een eigen domein via de edge function client-domains.

import { useEffect, useState } from 'react';
import { throwFunctionError } from '../lib/functionErrors';
import { supabase } from '../lib/supabase';
import type { SubdomainAvailability, SubdomainCheck } from '../lib/clientDomains';
import type { UUID } from '../types';

export type ClientDomainStatus = 'pending_dns' | 'pending_certificate' | 'active' | 'failing' | 'moved' | 'removed' | 'blocked';

export interface ClientDomainRecord {
  type: 'CNAME' | 'TXT';
  name: string;
  value: string;
}

export interface ClientDomain {
  id: string;
  hostname: string;
  status: ClientDomainStatus;
  problem: string | null;
  cnameFound: string[] | null;
  records: ClientDomainRecord[];
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface ClientDomainsOverview {
  config: {
    /** De namen staan onder dit domein: <naam>.<base>. */
    base: string;
    /** Gaan links al naar de klantadressen? */
    live: boolean;
    /** Waar een eigen domein met CNAME naar wijst. */
    cnameTarget: string;
    /** Kan deze omgeving eigen domeinen aan (Cloudflare for SaaS ingericht)? */
    customDomainsAvailable: boolean;
  };
  /** Mag deze organisatie een eigen domein koppelen (betaald abonnement of vrijgesteld)? */
  customDomainAllowed: boolean;
  subdomain: { name: string; host: string } | null;
  blocked: boolean;
  previous: Array<{ name: string; host: string; redirectUntil: string }>;
  domain: ClientDomain | null;
  moved: Array<{ id: string; hostname: string; redirectUntil: string }>;
  /** Waar links naar klantpagina's nu heen gaan. */
  clientUrl: string;
  /** Is clientUrl het klantadres (en niet het adres van de app)? */
  onClientHost: boolean;
  /** Waar het portaal woont: de naam bij ResoFly, nooit een eigen domein. */
  portalUrl: string;
  /** Is portalUrl het klantadres (en niet het adres van de app)? */
  portalOnClientHost: boolean;
}

async function invoke<T>(action: string, organizationId: UUID, payload: Record<string, unknown>, failure: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('client-domains', { body: { action, organizationId, ...payload } });
  if (error) await throwFunctionError(error, failure);
  if (!data?.ok) throw new Error(data?.error || failure);
  return data as T;
}

const overviews = new Map<string, ClientDomainsOverview>();
const inflight = new Map<string, Promise<ClientDomainsOverview>>();

export async function loadClientDomainsOverview(organizationId: UUID): Promise<ClientDomainsOverview> {
  const result = await invoke<ClientDomainsOverview>('overview', organizationId, {}, 'Het webadres kon niet worden geladen.');
  overviews.set(organizationId, result);
  return result;
}

/** Eén keer per organisatie: de galerij en de huisstijl vragen het tegelijk. */
function cachedOverview(organizationId: UUID): Promise<ClientDomainsOverview> {
  const hit = overviews.get(organizationId);
  if (hit) return Promise.resolve(hit);
  let pending = inflight.get(organizationId);
  if (!pending) {
    pending = loadClientDomainsOverview(organizationId).finally(() => inflight.delete(organizationId));
    inflight.set(organizationId, pending);
  }
  return pending;
}

/** Bestaat deze naam al? Voor het scherm, tijdens het typen. */
export async function checkClientSubdomain(name: string, organizationId: UUID | null): Promise<SubdomainCheck> {
  const { data, error } = await supabase.rpc('client_subdomain_check', { p_name: name, p_organization_id: organizationId });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as { name?: string; status?: string; message?: string } | null;
  const known: SubdomainAvailability[] = ['available', 'taken', 'reserved', 'invalid', 'own', 'own_previous'];
  const status = known.includes(row?.status as SubdomainAvailability) ? (row!.status as SubdomainAvailability) : 'invalid';
  return { name: String(row?.name ?? name), status, ...(row?.message ? { message: row.message } : {}) };
}

/** De naam vastleggen of wijzigen (alleen owner of admin; de database controleert het). */
export async function claimClientSubdomain(organizationId: UUID, name: string): Promise<{ name: string; previous: string | null; changed: boolean }> {
  const { data, error } = await supabase.rpc('client_subdomain_claim', { p_organization_id: organizationId, p_name: name });
  if (error) throw error;
  overviews.delete(organizationId);
  const row = (Array.isArray(data) ? data[0] : data) as { name: string; previous: string | null; changed: boolean };
  return row;
}

export async function addClientDomain(organizationId: UUID, hostname: string): Promise<ClientDomain> {
  overviews.delete(organizationId);
  return (await invoke<{ domain: ClientDomain }>('addDomain', organizationId, { hostname }, 'Het domein kon niet worden toegevoegd.')).domain;
}

export async function refreshClientDomain(organizationId: UUID, domainId: string): Promise<ClientDomain> {
  overviews.delete(organizationId);
  return (await invoke<{ domain: ClientDomain }>('refreshDomain', organizationId, { domainId }, 'Het domein kon niet worden gecontroleerd.')).domain;
}

export async function removeClientDomain(organizationId: UUID, domainId: string): Promise<{ removed: boolean; redirectUntil?: string }> {
  overviews.delete(organizationId);
  return invoke('removeDomain', organizationId, { domainId }, 'Het domein kon niet worden verwijderd.');
}

export interface ClientAddress {
  /** Voor documenten (album, factuur): zonder schuine streep aan het eind. */
  baseUrl: string;
  /** Het klantadres (jansen.resofly.com, een eigen domein), niet dat van de app. */
  onClientHost: boolean;
  /** Voor het portaal: de naam bij ResoFly, nooit een eigen domein. */
  portal: { baseUrl: string; onClientHost: boolean };
}

function addressFrom(overview: ClientDomainsOverview | undefined, fallback: string): ClientAddress {
  const documents = overview?.clientUrl
    ? { baseUrl: overview.clientUrl.replace(/\/+$/, ''), onClientHost: Boolean(overview.onClientHost) }
    : { baseUrl: fallback, onClientHost: false };
  const portal = overview?.portalUrl
    ? { baseUrl: overview.portalUrl.replace(/\/+$/, ''), onClientHost: Boolean(overview.portalOnClientHost) }
    : { baseUrl: fallback, onClientHost: false };
  return { ...documents, portal };
}

/**
 * Het adres voor links naar klantpagina's die de app zelf toont of kopieert
 * (de link naar een album, het portaal): dezelfde als in de mail aan de klant.
 * De server weet het (clientUrl in het overzicht); tot het binnen is, en als
 * het niet lukt, het adres van de app.
 */
export function useClientAddress(organizationId: UUID | null | undefined): ClientAddress {
  const fallback = typeof window === 'undefined' ? '' : window.location.origin;
  const [address, setAddress] = useState<ClientAddress>(() => addressFrom(organizationId ? overviews.get(organizationId) : undefined, fallback));
  useEffect(() => {
    if (!organizationId) { setAddress(addressFrom(undefined, fallback)); return; }
    let alive = true;
    cachedOverview(organizationId)
      .then(result => { if (alive) setAddress(addressFrom(result, fallback)); })
      .catch(() => { if (alive) setAddress(addressFrom(undefined, fallback)); });
    return () => { alive = false; };
  }, [organizationId, fallback]);
  return address;
}

export function useClientBaseUrl(organizationId: UUID | null | undefined): string {
  return useClientAddress(organizationId).baseUrl;
}

/** Hetzelfde buiten een component (de handelingen van Gerrie). Gooit nooit. */
export async function clientBaseUrlFor(organizationId: UUID | null | undefined): Promise<string> {
  const fallback = typeof window === 'undefined' ? '' : window.location.origin;
  if (!organizationId) return fallback;
  try {
    return addressFrom(await cachedOverview(organizationId), fallback).baseUrl;
  } catch {
    return fallback;
  }
}
