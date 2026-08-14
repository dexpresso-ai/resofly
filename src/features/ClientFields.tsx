import { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { Modal } from '../components/Modal';
import { insertRow, updateRow, deleteRow } from '../lib/repository';
import { CUSTOM_FIELD_TYPE_LABELS } from '../types';
import type { AppData, ClientFieldDefinition, CustomFieldType, UUID } from '../types';

// ============================================================================
// Beheer van de vrije klantvelden (Instellingen → Eigen klantvelden).
//
// Elk veld dat je hier aanmaakt verschijnt op het klantformulier én wordt
// meteen bruikbaar als variabele in campagnes en follow-up-stromen, via
// {{veld.<sleutel>}}. De sleutel is daarom onderdeel van de gebruikersinterface
// en niet iets wat we verstoppen.
// ============================================================================

const FIELD_TYPES = Object.keys(CUSTOM_FIELD_TYPE_LABELS) as CustomFieldType[];

/** Label → sleutel. Moet aan client_field_definitions_key_format voldoen: ^[a-z][a-z0-9_]{0,38}$ */
export function slugifyFieldKey(label: string): string {
  const base = label
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // accenten weg: "Café" → "cafe"
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 39);
  // De sleutel moet met een letter beginnen; "3e_contact" wordt "veld_3e_contact".
  return /^[a-z]/.test(base) ? base : `veld_${base}`.slice(0, 39).replace(/_+$/, '');
}

type DraftField = {
  id: UUID | null;
  field_key: string;
  label: string;
  field_type: CustomFieldType;
  optionsText: string;
  help_text: string;
  default_fallback: string;
  show_in_list: boolean;
  /** Bij een bestaand veld: is de sleutel handmatig aangepast? Zo niet, volgt hij het label. */
  keyTouched: boolean;
};

function emptyDraft(): DraftField {
  return {
    id: null, field_key: '', label: '', field_type: 'text',
    optionsText: '', help_text: '', default_fallback: '', show_in_list: false, keyTouched: false,
  };
}

function toDraft(def: ClientFieldDefinition): DraftField {
  return {
    id: def.id,
    field_key: def.field_key,
    label: def.label,
    field_type: def.field_type,
    optionsText: def.options.join('\n'),
    help_text: def.help_text ?? '',
    default_fallback: def.default_fallback ?? '',
    show_in_list: def.show_in_list,
    keyTouched: true,
  };
}

export function ClientFieldsManager({ data, organizationId, canWrite, onChanged }: {
  data: AppData;
  organizationId: UUID;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<DraftField | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(
    () => [...data.clientFieldDefinitions].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label, 'nl')),
    [data.clientFieldDefinitions],
  );
  const active = fields.filter(f => !f.is_archived);
  const archived = fields.filter(f => f.is_archived);

  async function save(next: DraftField) {
    const label = next.label.trim();
    const fieldKey = (next.field_key || slugifyFieldKey(label)).trim();
    if (!label) { setError('Geef het veld een naam.'); return; }
    if (!/^[a-z][a-z0-9_]{0,38}$/.test(fieldKey)) {
      setError('De sleutel mag alleen kleine letters, cijfers en liggende streepjes bevatten, en moet met een letter beginnen.');
      return;
    }
    const options = next.optionsText.split('\n').map(v => v.trim()).filter(Boolean);
    if ((next.field_type === 'select' || next.field_type === 'multiselect') && options.length === 0) {
      setError('Een keuzelijst heeft minstens één keuze nodig.');
      return;
    }
    if (!next.id && fields.some(f => f.field_key === fieldKey)) {
      setError(`Er bestaat al een veld met de sleutel "${fieldKey}".`);
      return;
    }

    const values = {
      field_key: fieldKey,
      label,
      field_type: next.field_type,
      options,
      help_text: next.help_text.trim() || null,
      default_fallback: next.default_fallback.trim() || null,
      show_in_list: next.show_in_list,
      // Nieuwe velden onderaan; bestaande houden hun plek.
      ...(next.id ? {} : { position: fields.length }),
    };

    setBusy(true);
    setError(null);
    try {
      if (next.id) await updateRow('client_field_definitions', next.id, values, organizationId);
      else await insertRow('client_field_definitions', organizationId, values);
      setDraft(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function setArchived(def: ClientFieldDefinition, isArchived: boolean) {
    setBusy(true);
    setError(null);
    try {
      await updateRow('client_field_definitions', def.id, { is_archived: isArchived }, organizationId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bijwerken mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(def: ClientFieldDefinition) {
    const filled = data.clients.filter(c => (c.custom_fields ?? {})[def.field_key] !== undefined).length;
    const warning = filled > 0
      ? `\n\nLet op: ${filled} ${filled === 1 ? 'klant heeft' : 'klanten hebben'} dit veld ingevuld. Die waarden gaan definitief verloren.`
      : '';
    if (!window.confirm(`Het veld "${def.label}" verwijderen?${warning}\n\nWil je de waarden bewaren, archiveer het veld dan in plaats van verwijderen.`)) return;

    setBusy(true);
    setError(null);
    try {
      await deleteRow('client_field_definitions', def.id, organizationId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card cf-manager">
      <div className="settings-save-bar">
        <p className="settings-help">
          Verzin je eigen velden bij een klant — een pakket, een contractdatum, een voorkeur. Je vult ze in op de klantkaart
          en gebruikt ze daarna als variabele in je campagnes, bijvoorbeeld <code>{'{{veld.pakket}}'}</code>.
        </p>
        {canWrite && <Button variant="primary" onClick={() => { setError(null); setDraft(emptyDraft()); }} disabled={busy}><Plus size={15} /> Veld toevoegen</Button>}
      </div>

      {error && <div className="error">{error}</div>}

      {active.length === 0 && archived.length === 0 && (
        <p className="settings-help">Nog geen eigen velden. Voeg er een toe om te beginnen.</p>
      )}

      {active.length > 0 && (
        <div className="cf-list">
          {active.map(def => (
            <FieldRow
              key={def.id}
              def={def}
              canWrite={canWrite}
              busy={busy}
              onEdit={() => { setError(null); setDraft(toDraft(def)); }}
              onArchive={() => setArchived(def, true)}
              onDelete={() => remove(def)}
            />
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <>
          <h4 className="cf-archived-title">Gearchiveerd</h4>
          <p className="settings-help">
            Gearchiveerde velden verdwijnen uit het klantformulier en uit de variabelenlijst, maar bestaande waarden blijven bewaard.
          </p>
          <div className="cf-list cf-list-archived">
            {archived.map(def => (
              <FieldRow
                key={def.id}
                def={def}
                canWrite={canWrite}
                busy={busy}
                onEdit={() => { setError(null); setDraft(toDraft(def)); }}
                onArchive={() => setArchived(def, false)}
                onDelete={() => remove(def)}
              />
            ))}
          </div>
        </>
      )}

      {draft && (
        <FieldEditor
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onCancel={() => { setDraft(null); setError(null); }}
          onSave={() => save(draft)}
        />
      )}
    </section>
  );
}

function FieldRow({ def, canWrite, busy, onEdit, onArchive, onDelete }: {
  def: ClientFieldDefinition;
  canWrite: boolean;
  busy: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="cf-row">
      <div className="cf-row-main">
        <strong>{def.label}</strong>
        <code className="cf-token">{`{{veld.${def.field_key}}}`}</code>
      </div>
      <div className="cf-row-meta">
        <span>{CUSTOM_FIELD_TYPE_LABELS[def.field_type]}</span>
        {def.options.length > 0 && <span>{def.options.length} keuzes</span>}
        {def.default_fallback && <span>terugval: “{def.default_fallback}”</span>}
        {def.show_in_list && <span>kolom in lijst</span>}
      </div>
      {canWrite && (
        <div className="cf-row-actions">
          <button type="button" className="mk-icon" title="Bewerken" onClick={onEdit} disabled={busy}><Pencil size={15} /></button>
          <button
            type="button"
            className="mk-icon"
            title={def.is_archived ? 'Terugzetten' : 'Archiveren'}
            onClick={onArchive}
            disabled={busy}
          >
            {def.is_archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          </button>
          <button type="button" className="mk-icon danger" title="Verwijderen" onClick={onDelete} disabled={busy}><Trash2 size={15} /></button>
        </div>
      )}
    </div>
  );
}

function FieldEditor({ draft, busy, onChange, onCancel, onSave }: {
  draft: DraftField;
  busy: boolean;
  onChange: (next: DraftField) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof DraftField>(key: K, value: DraftField[K]) => onChange({ ...draft, [key]: value });
  const needsOptions = draft.field_type === 'select' || draft.field_type === 'multiselect';
  const previewKey = draft.field_key || slugifyFieldKey(draft.label) || 'sleutel';

  return (
    <Modal
      title={draft.id ? 'Veld bewerken' : 'Nieuw klantveld'}
      onClose={onCancel}
      footer={<>
        <Button variant="ghost" onClick={onCancel}>Annuleren</Button>
        <Button variant="primary" onClick={onSave} disabled={busy}>{busy ? 'Opslaan…' : 'Opslaan'}</Button>
      </>}
    >
      <div className="cf-editor">
        <label className="field">
          <span>Naam van het veld</span>
          <Input
            value={draft.label}
            placeholder="Bijv. Pakket"
            onChange={e => {
              const label = e.target.value;
              // De sleutel volgt het label totdat je hem zelf aanpast — daarna
              // laten we hem met rust, want hij zit in verstuurde mailings.
              onChange({ ...draft, label, field_key: draft.keyTouched ? draft.field_key : slugifyFieldKey(label) });
            }}
          />
        </label>

        <label className="field">
          <span>Sleutel <em>(de naam van de variabele)</em></span>
          <Input
            value={draft.field_key}
            placeholder="pakket"
            onChange={e => onChange({ ...draft, field_key: e.target.value, keyTouched: true })}
          />
          <small>
            In een mailing schrijf je <code>{`{{veld.${previewKey}}}`}</code>.
            {draft.id && ' Hernoem je de sleutel, dan verhuizen bestaande waarden mee, maar mailingteksten met de oude naam blijven leeg.'}
          </small>
        </label>

        <label className="field">
          <span>Type</span>
          <Select value={draft.field_type} onChange={e => set('field_type', e.target.value as CustomFieldType)}>
            {FIELD_TYPES.map(type => <option key={type} value={type}>{CUSTOM_FIELD_TYPE_LABELS[type]}</option>)}
          </Select>
        </label>

        {needsOptions && (
          <label className="field">
            <span>Keuzes <em>(één per regel)</em></span>
            <Textarea
              value={draft.optionsText}
              rows={5}
              placeholder={'Basis\nPlus\nPremium'}
              onChange={e => set('optionsText', e.target.value)}
            />
          </label>
        )}

        <label className="field">
          <span>Terugvalwaarde in mailings</span>
          <Input
            value={draft.default_fallback}
            placeholder="Bijv. onbekend"
            onChange={e => set('default_fallback', e.target.value)}
          />
          <small>
            Wat er in de mail komt als deze klant het veld leeg heeft. Laat je dit leeg, dan valt er een gat in de zin —
            tenzij je in de tekst zelf een terugval meegeeft met <code>{`{{veld.${previewKey}|iets anders}}`}</code>.
          </small>
        </label>

        <label className="field">
          <span>Uitleg bij het veld <em>(optioneel)</em></span>
          <Input
            value={draft.help_text}
            placeholder="Korte toelichting op het klantformulier"
            onChange={e => set('help_text', e.target.value)}
          />
        </label>

        <label className="check-row">
          <input type="checkbox" checked={draft.show_in_list} onChange={e => set('show_in_list', e.target.checked)} />
          <span>Als kolom tonen in het klantenoverzicht</span>
        </label>
      </div>
    </Modal>
  );
}
