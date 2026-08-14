import { Input, Select, Textarea } from './Ui';
import type { ClientFieldDefinition, CustomFieldValue } from '../types';

// ============================================================================
// Invoer en weergave van de vrije klantvelden.
//
// De definities staan in client_field_definitions; de waarden als JSONB op de
// klantrij (clients.custom_fields). Deze module is de enige plek die weet hoe
// een veldtype eruitziet, zodat het klantformulier, de klantenlijst en het
// klantdossier niet elk hun eigen variant krijgen.
//
// LET OP: de databasetrigger validate_client_custom_fields() keurt af wat hier
// doorheen komt. normalizeCustomFieldValues() zet de formulierwaarden (altijd
// strings) om naar het type dat de trigger verwacht — sla nooit ruwe
// invoerwaarden op zonder die stap.
// ============================================================================

/** Alleen de velden die je nu nog mag invullen (gearchiveerde vallen af). */
export function activeFieldDefinitions(definitions: ClientFieldDefinition[]): ClientFieldDefinition[] {
  return definitions
    .filter(d => !d.is_archived)
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label, 'nl'));
}

/**
 * Formulierwaarden → de vorm die de database verwacht. Lege waarden worden
 * weggelaten in plaats van als lege string bewaard: alleen dan grijpt de
 * terugvalwaarde in een mailing in ({{veld.x|onbekend}}).
 */
export function normalizeCustomFieldValues(
  raw: Record<string, unknown> | null | undefined,
  definitions: ClientFieldDefinition[],
): Record<string, CustomFieldValue> {
  const values = raw ?? {};
  const out: Record<string, CustomFieldValue> = {};

  for (const def of definitions) {
    const value = values[def.field_key];
    if (value === null || value === undefined) continue;

    switch (def.field_type) {
      case 'number':
      case 'amount': {
        // Nederlandse invoer met een komma moet ook door: "1250,50".
        const numeric = Number(String(value).replace(',', '.').trim());
        if (String(value).trim() === '' || !Number.isFinite(numeric)) continue;
        out[def.field_key] = numeric;
        break;
      }
      case 'boolean': {
        // Een uitgevinkt hokje is géén waarde: zo blijft "leeg" onderscheiden
        // van een bewust ingevulde "Nee".
        if (value === true) out[def.field_key] = true;
        else if (value === false) continue;
        break;
      }
      case 'multiselect': {
        const list = Array.isArray(value) ? value.map(v => String(v).trim()).filter(Boolean) : [];
        if (list.length === 0) continue;
        out[def.field_key] = list;
        break;
      }
      default: {
        const text = String(value).trim();
        if (text === '') continue;
        out[def.field_key] = text;
      }
    }
  }
  return out;
}

/** Leesbare weergave van één waarde, voor de klantenlijst en het klantdossier. */
export function formatCustomFieldValue(value: CustomFieldValue | undefined, def: ClientFieldDefinition): string {
  if (value === null || value === undefined || value === '') return '';
  switch (def.field_type) {
    case 'boolean':
      return value === true ? 'Ja' : 'Nee';
    case 'amount':
      return typeof value === 'number'
        ? new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(value)
        : '';
    case 'number':
      return typeof value === 'number' ? new Intl.NumberFormat('nl-NL').format(value) : '';
    case 'date': {
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('nl-NL');
    }
    case 'multiselect':
      return Array.isArray(value) ? value.join(', ') : '';
    default:
      return String(value);
  }
}

/** Doorzoekbare tekst van alle vrije velden van één klant. */
export function customFieldsSearchText(
  values: Record<string, CustomFieldValue> | null | undefined,
  definitions: ClientFieldDefinition[],
): string {
  if (!values) return '';
  return definitions
    .map(def => formatCustomFieldValue(values[def.field_key], def))
    .filter(Boolean)
    .join(' ');
}

/** Alle waarden die een keuzeveld in de praktijk heeft — voedt het doelgroepfilter. */
export function distinctFieldValues(
  def: ClientFieldDefinition,
  allValues: Array<Record<string, CustomFieldValue> | null | undefined>,
): string[] {
  if (def.field_type === 'select' || def.field_type === 'multiselect') return def.options;
  if (def.field_type === 'boolean') return ['Ja', 'Nee'];
  const seen = new Set<string>();
  for (const values of allValues) {
    const raw = values?.[def.field_key];
    if (raw === null || raw === undefined || raw === '') continue;
    if (Array.isArray(raw)) raw.forEach(v => seen.add(String(v)));
    else seen.add(String(raw));
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'nl')).slice(0, 100);
}

export function CustomFieldsSection({
  definitions,
  values,
  onChange,
  disabled = false,
}: {
  definitions: ClientFieldDefinition[];
  values: Record<string, unknown>;
  onChange: (fieldKey: string, value: unknown) => void;
  disabled?: boolean;
}) {
  const active = activeFieldDefinitions(definitions);
  if (active.length === 0) return null;

  return (
    <section className="custom-fields-section">
      <h4>Eigen velden</h4>
      {active.map(def => (
        <CustomFieldInput
          key={def.id}
          def={def}
          value={values[def.field_key]}
          onChange={value => onChange(def.field_key, value)}
          disabled={disabled}
        />
      ))}
    </section>
  );
}

function CustomFieldInput({
  def,
  value,
  onChange,
  disabled,
}: {
  def: ClientFieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  const text = value === null || value === undefined ? '' : String(value);

  // Ja/nee en meerkeuze hebben geen enkel invoerveld en krijgen daarom hun
  // eigen opzet in plaats van het label-om-input-patroon.
  if (def.field_type === 'boolean') {
    return (
      <label className="check-row custom-field-check">
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={e => onChange(e.target.checked)} />
        <span>{def.label}{def.help_text && <em> — {def.help_text}</em>}</span>
      </label>
    );
  }

  if (def.field_type === 'multiselect') {
    const selected = Array.isArray(value) ? value.map(String) : [];
    const toggle = (option: string) =>
      onChange(selected.includes(option) ? selected.filter(v => v !== option) : [...selected, option]);
    return (
      <div className="field custom-field-multi">
        <span>{def.label}</span>
        <div className="custom-field-options">
          {def.options.map(option => (
            <label key={option} className={`mk-check${selected.includes(option) ? ' on' : ''}`}>
              <input type="checkbox" checked={selected.includes(option)} disabled={disabled} onChange={() => toggle(option)} />
              {option}
            </label>
          ))}
        </div>
        {def.help_text && <small>{def.help_text}</small>}
      </div>
    );
  }

  return (
    <label className="field">
      <span>{def.label}</span>
      {def.field_type === 'textarea' ? (
        <Textarea value={text} disabled={disabled} onChange={e => onChange(e.target.value)} />
      ) : def.field_type === 'select' ? (
        <Select value={text} disabled={disabled} onChange={e => onChange(e.target.value)}>
          <option value="">Niet ingevuld</option>
          {def.options.map(option => <option key={option} value={option}>{option}</option>)}
        </Select>
      ) : (
        <Input
          type={inputType(def.field_type)}
          step={def.field_type === 'amount' ? '0.01' : undefined}
          value={text}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
        />
      )}
      {def.help_text && <small>{def.help_text}</small>}
    </label>
  );
}

function inputType(fieldType: ClientFieldDefinition['field_type']): string {
  switch (fieldType) {
    case 'number':
    case 'amount':
      return 'number';
    case 'date':
      return 'date';
    case 'email':
      return 'email';
    case 'url':
      return 'url';
    case 'phone':
      return 'tel';
    default:
      return 'text';
  }
}
