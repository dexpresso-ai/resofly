// Een naam kiezen voor het webadres (<naam>.<basisdomein>), met een live
// controle of die naam al bestaat. Bij het inrichten van een organisatie
// (OrganizationSetup) en in Instellingen → Domein.
//
// Tijdens het typen eerst de vorm (src/lib/clientDomains.ts), daarna, na een
// korte pauze, de database (client_subdomain_check). De database beslist bij
// het vastleggen opnieuw: tussen controleren en vastleggen kan een ander de
// naam net nemen.

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import {
  availabilityText, normalizeSubdomainInput, subdomainFormatProblem, SUBDOMAIN_PROBLEM_TEXT, type SubdomainCheck,
} from '../lib/clientDomains';
import { checkClientSubdomain } from '../services/domainService';

export interface AddressPickerState {
  name: string;
  check: SubdomainCheck | null;
  checking: boolean;
}

export function ClientAddressPicker({ id, organizationId, base, value, onChange, disabled = false, autoFocus = false }: {
  id: string;
  organizationId: string;
  /** Het basisdomein: resofly.com. */
  base: string;
  value: string;
  onChange: (state: AddressPickerState) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [check, setCheck] = useState<SubdomainCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const name = value;
    const ticket = ++seq.current;
    setFailed(false);
    const problem = subdomainFormatProblem(name);
    if (!name || problem) {
      const local: SubdomainCheck | null = name ? { name, status: 'invalid', message: SUBDOMAIN_PROBLEM_TEXT[problem!] } : null;
      setCheck(local);
      setChecking(false);
      onChangeRef.current({ name, check: local, checking: false });
      return;
    }
    // Het oordeel over de vorige naam hoort niet bij deze: anders bleef het veld
    // rood staan terwijl de nieuwe naam nog werd gecontroleerd.
    setCheck(null);
    setChecking(true);
    onChangeRef.current({ name, check: null, checking: true });
    // Even wachten tot iemand ophoudt met typen: geen vraag per toets.
    const timer = window.setTimeout(() => {
      checkClientSubdomain(name, organizationId)
        .then(result => {
          if (ticket !== seq.current) return;
          setCheck(result);
          setChecking(false);
          onChangeRef.current({ name, check: result, checking: false });
        })
        .catch(() => {
          if (ticket !== seq.current) return;
          setCheck(null);
          setChecking(false);
          setFailed(true);
          onChangeRef.current({ name, check: null, checking: false });
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [value, organizationId]);

  const host = `${value || 'jouwnaam'}.${base}`;
  const good = check && (check.status === 'available' || check.status === 'own' || check.status === 'own_previous');
  const statusId = `${id}-status`;
  return <div className="client-address">
    <div className={`client-address-field${check && !good ? ' has-error' : ''}`}>
      <input
        id={id}
        className="form-input client-address-input"
        value={value}
        onChange={e => {
          // Een teken dat wegvalt (een uitroepteken): niets veranderd, dus ook
          // geen nieuwe controle. Anders bleef de knop op "bezig" staan.
          const next = normalizeSubdomainInput(e.target.value);
          if (next !== value) onChange({ name: next, check: null, checking: true });
        }}
        placeholder="jouwbedrijf"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        inputMode="url"
        maxLength={40}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-describedby={statusId}
        aria-invalid={check && !good ? true : undefined}
      />
      <span className="client-address-suffix" aria-hidden="true">.{base}</span>
    </div>
    <p id={statusId} className={`client-address-status${good ? ' is-ok' : check ? ' is-bad' : ''}`} role="status" aria-live="polite">
      {checking ? <><Loader2 size={14} className="onb-spin" aria-hidden="true" /> Kijken of {host} nog vrij is…</>
        : failed ? <>Controleren lukte niet. Probeer het zo opnieuw.</>
          : check ? <>{good ? <CheckCircle2 size={14} aria-hidden="true" /> : <XCircle size={14} aria-hidden="true" />} {availabilityText(check, host)}</>
            : <>Kleine letters, cijfers en streepjes. Je klanten zien dit adres in elke mail.</>}
    </p>
  </div>;
}
