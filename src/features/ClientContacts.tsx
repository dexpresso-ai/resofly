import { useState } from 'react';
import type { AppData, Client, ClientContact } from '../types';
import { Button, Input } from '../components/Ui';
import { createClientContact, updateClientContact, deleteClientContact } from '../lib/repository';

/**
 * Contactpersonen bij een klant. Naast het bestaande losse "Contactpersoon"-veld
 * op de klantkaart (dat ongewijzigd blijft werken) kan een klant hier meerdere
 * mensen registreren. Per contactpersoon bepaalt "Geeft portaaltoegang" of die
 * persoon met zijn/haar eigen e-mailadres kan inloggen op /portal en daar
 * offertes goedkeurt/weigert, facturen betaalt en tickets indient.
 */
export function ClientContacts({
  data, client, organizationId, canWrite, onChanged,
}: {
  data: AppData;
  client: Client;
  organizationId: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const contacts = data.clientContacts
    .filter(c => c.client_id === client.id)
    .sort((a, b) => a.name.localeCompare(b.name, 'nl'));

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ClientContact | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openNew() { setEditing(null); setShowForm(true); setError(null); }
  function openEdit(contact: ClientContact) { setEditing(contact); setShowForm(true); setError(null); }
  function closeForm() { setShowForm(false); setEditing(null); }

  async function toggleField(contact: ClientContact, field: 'gives_portal_access' | 'is_active') {
    setBusyId(contact.id); setError(null);
    try {
      await updateClientContact(contact.id, { [field]: !contact[field] }, organizationId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bijwerken mislukt');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(contact: ClientContact) {
    if (!window.confirm(`Contactpersoon "${contact.name}" verwijderen?`)) return;
    setBusyId(contact.id); setError(null);
    try {
      await deleteClientContact(contact.id, organizationId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt');
    } finally {
      setBusyId(null);
    }
  }

  return <article className="client-panel">
    <div className="client-panel-head">
      <h3>Contactpersonen</h3>
      <div className="client-panel-head-right">
        <span>{contacts.length}</span>
        {canWrite && !showForm && <button type="button" className="client-overview-more-btn" onClick={openNew}>+ Toevoegen</button>}
      </div>
    </div>

    {error && <p className="error">{error}</p>}
    {contacts.length === 0 && !showForm && <div className="client-empty-line">Nog geen contactpersonen geregistreerd.</div>}

    {contacts.length > 0 && <div className="client-contact-list">
      {contacts.map(contact => <div className="client-contact-row" key={contact.id}>
        <div className="client-contact-main">
          <div className="client-contact-name-line">
            <strong>{contact.name}</strong>
            {contact.role && <span className="client-contact-role">{contact.role}</span>}
          </div>
          <span className="client-contact-meta">{contact.email}{contact.phone ? ` · ${contact.phone}` : ''}</span>
        </div>
        <div className="client-contact-badges">
          <span className={`client-contact-badge ${contact.gives_portal_access ? 'on' : 'off'}`}>
            {contact.gives_portal_access ? 'Portaaltoegang aan' : 'Portaaltoegang uit'}
          </span>
          {!contact.is_active && <span className="client-contact-badge off">Inactief</span>}
        </div>
        {canWrite && <div className="client-contact-actions">
          <button type="button" disabled={busyId === contact.id} onClick={() => toggleField(contact, 'gives_portal_access')}>
            {contact.gives_portal_access ? 'Toegang uitzetten' : 'Toegang geven'}
          </button>
          <button type="button" disabled={busyId === contact.id} onClick={() => toggleField(contact, 'is_active')}>
            {contact.is_active ? 'Deactiveren' : 'Activeren'}
          </button>
          <button type="button" disabled={busyId === contact.id} onClick={() => openEdit(contact)}>Bewerken</button>
          <button type="button" disabled={busyId === contact.id} onClick={() => remove(contact)}>Verwijderen</button>
        </div>}
      </div>)}
    </div>}

    {showForm && canWrite && <ClientContactForm
      organizationId={organizationId}
      clientId={client.id}
      contact={editing}
      onSaved={() => { closeForm(); onChanged(); }}
      onCancel={closeForm}
    />}
  </article>;
}

function ClientContactForm({
  organizationId, clientId, contact, onSaved, onCancel,
}: {
  organizationId: string;
  clientId: string;
  contact: ClientContact | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(contact?.name ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [role, setRole] = useState(contact?.role ?? '');
  const [givesPortalAccess, setGivesPortalAccess] = useState(contact?.gives_portal_access ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) { setError('Naam is verplicht.'); return; }
    if (!email.trim()) { setError('E-mailadres is verplicht.'); return; }
    setSaving(true); setError(null);
    try {
      const values = {
        client_id: clientId,
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || null,
        role: role.trim() || null,
        gives_portal_access: givesPortalAccess,
      };
      if (contact) {
        await updateClientContact(contact.id, values, organizationId);
      } else {
        await createClientContact(organizationId, values);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt');
    } finally {
      setSaving(false);
    }
  }

  return <div className="client-contact-form">
    <div className="client-contact-form-grid">
      <label className="client-contact-field"><span>Naam</span><Input value={name} onChange={e => setName(e.target.value)} placeholder="Jan Jansen" disabled={saving} /></label>
      <label className="client-contact-field"><span>E-mail</span><Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jan@bedrijf.nl" disabled={saving} /></label>
      <label className="client-contact-field"><span>Telefoon</span><Input value={phone ?? ''} onChange={e => setPhone(e.target.value)} placeholder="06-12345678" disabled={saving} /></label>
      <label className="client-contact-field"><span>Functie/rol</span><Input value={role ?? ''} onChange={e => setRole(e.target.value)} placeholder="Financiën" disabled={saving} /></label>
    </div>
    <label className="client-contact-form-toggle">
      <input type="checkbox" checked={givesPortalAccess} onChange={e => setGivesPortalAccess(e.target.checked)} disabled={saving} />
      <span>Geeft portaaltoegang: kan met dit e-mailadres inloggen op het klantportaal en daar offertes goedkeuren/weigeren, facturen betalen en tickets indienen.</span>
    </label>
    {error && <p className="error">{error}</p>}
    <div className="client-contact-form-actions">
      <Button onClick={onCancel} disabled={saving}>Annuleren</Button>
      <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Opslaan…' : 'Opslaan'}</Button>
    </div>
  </div>;
}
