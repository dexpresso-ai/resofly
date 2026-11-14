// Het webadres van een organisatie (migratie 20261108230000): de naam bij
// ResoFly via de RPC's, een eigen domein via de edge function client-domains.

import { useEffect, useState } from 'react';
import { throwFunctionError } from '../lib/functionErrors';
import { supabase } from '../lib/supabase';
import { clientAddressFrom, type ClientAddress, type ClientAddressPart } from '../lib/clientAddress';
import type { SubdomainAvailability, SubdomainCheck } from '../lib/clientDomains';
import type { UUID } from '../types';

export type { ClientAddress, ClientAddressPart };

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
  /** Staat het klantportaal ook op dit domein (migratie 20261109020000)? */
  portalEnabled: boolean;
}

export interface ClientDomainsOverview {
  config: {
    /** De namen staan onder dit domein: <naam>.<base>. */
    base: string;
    /** Gaan alle links al naar de klantadressen? */
    live: boolean;
    /** Wat al vóór de rest naar het klantadres gaat (CLIENT_DOMAINS_LIVE=albums); ontbreekt bij een oudere functie. */
    liveKinds?: string[];
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
  /** Waar het portaal woont: het eigen domein als het daar aan staat, anders de naam bij ResoFly. */
  portalUrl: string;
  /** Is portalUrl het klantadres (en niet het adres van de app)? */
  portalOnClientHost: boolean;
  /**
   * Waar de deellink van een album heen gaat: als clientUrl, of met
   * CLIENT_DOMAINS_LIVE=albums al op het klantadres. Ontbreekt bij een oudere
   * functie; dan geldt clientUrl.
   */
  albumUrl?: string;
  /** Is albumUrl het klantadres (en niet het adres van de app)? */
  albumOnClientHost?: boolean;
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

/** Het klantportaal ook op het eigen domein, of niet (alleen owner of admin; de server controleert het). */
export async function setClientDomainPortal(organizationId: UUID, domainId: string, enabled: boolean): Promise<ClientDomain> {
  overviews.delete(organizationId);
  return (await invoke<{ domain: ClientDomain }>('setPortal', organizationId, { domainId, enabled }, 'Het klantportaal kon niet worden omgezet.')).domain;
}

function appOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/**
 * Het adres voor links naar klantpagina's die de app zelf toont of kopieert
 * (de link naar een album, het portaal): dezelfde als in de mail aan de klant.
 * De server weet het (het overzicht van client-domains); tot het binnen is, en
 * als het niet lukt, het adres van de app. `ready` zegt of het antwoord er is:
 * dan staat er geen link die een tel later een ander adres krijgt.
 */
export function useClientAddress(organizationId: UUID | null | undefined): ClientAddress & { ready: boolean } {
  const fallback = appOrigin();
  const cached = organizationId ? overviews.get(organizationId) : undefined;
  const [state, setState] = useState<{ org: string | null; address: ClientAddress; ready: boolean }>(() => ({
    org: organizationId ?? null,
    address: clientAddressFrom(cached, fallback),
    ready: !organizationId || cached !== undefined,
  }));
  useEffect(() => {
    if (!organizationId) { setState({ org: null, address: clientAddressFrom(undefined, fallback), ready: true }); return; }
    const hit = overviews.get(organizationId);
    if (hit) { setState({ org: organizationId, address: clientAddressFrom(hit, fallback), ready: true }); return; }
    let alive = true;
    setState({ org: organizationId, address: clientAddressFrom(undefined, fallback), ready: false });
    cachedOverview(organizationId)
      .then(result => { if (alive) setState({ org: organizationId, address: clientAddressFrom(result, fallback), ready: true }); })
      .catch(() => { if (alive) setState({ org: organizationId, address: clientAddressFrom(undefined, fallback), ready: true }); });
    return () => { alive = false; };
  }, [organizationId, fallback]);
  // Net van organisatie gewisseld: niet heel even het adres van de vorige tonen.
  if (state.org !== (organizationId ?? null)) {
    return { ...clientAddressFrom(cached, fallback), ready: !organizationId || cached !== undefined };
  }
  return { ...state.address, ready: state.ready };
}

/** Waar de deellink van een album heen gaat (Galerij → Delen), met `ready`. */
export function useAlbumAddress(organizationId: UUID | null | undefined): ClientAddressPart & { ready: boolean } {
  const address = useClientAddress(organizationId);
  return { ...address.albums, ready: address.ready };
}

/** Hetzelfde buiten een component (de handeling van Gerrie die een deellink maakt). Gooit nooit. */
export async function albumBaseUrlFor(organizationId: UUID | null | undefined): Promise<string> {
  const fallback = appOrigin();
  if (!organizationId) return clientAddressFrom(undefined, fallback).albums.baseUrl;
  try {
    return clientAddressFrom(await cachedOverview(organizationId), fallback).albums.baseUrl;
  } catch {
    return clientAddressFrom(undefined, fallback).albums.baseUrl;
  }
}
