import { Cloud, FileText, Image as ImageIcon, Presentation, Sheet } from 'lucide-react';
import type { Attachment, InternalDocument } from '../types';
import { cloudProviderLabel, cloudProviderOf } from '../lib/cloudDrive';

/**
 * Iconen, kleuren en typelabels van de verkenner op één plek. De Inhoud-pagina en
 * het klantdossier tonen dezelfde inhoud met dezelfde component; deze helpers staan
 * los zodat ook andere schermen (bijlagenlijsten, deelvensters) dezelfde beeldtaal
 * kunnen gebruiken zonder de hele verkenner te importeren.
 */

export function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function attExt(att: Attachment): string {
  return att.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}
/** Bestandscategorie — stuurt icoon én kleur, zodat die twee nooit uit de pas lopen. */
type AttCategory = 'word' | 'sheet' | 'slides' | 'image' | 'pdf' | 'other';
function attCategory(att: Attachment): AttCategory {
  const ext = attExt(att);
  if (['docx', 'doc', 'odt'].includes(ext)) return 'word';
  if (['xlsx', 'xls', 'ods', 'csv'].includes(ext)) return 'sheet';
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'slides';
  const m = att.mime_type || '';
  // De eigen bestanden van Google (Documenten, Spreadsheets, Presentaties)
  // hebben geen extensie; het mime-type zegt wat het is.
  if (m === GOOGLE_DOC) return 'word';
  if (m === GOOGLE_SHEET) return 'sheet';
  if (m === GOOGLE_SLIDES) return 'slides';
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'pdf';
  return 'other';
}
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';

function baseTypeLabel(att: Attachment): string {
  const m = att.mime_type || '';
  if (m === GOOGLE_DOC) return 'Google-document';
  if (m === GOOGLE_SHEET) return 'Google-spreadsheet';
  if (m === GOOGLE_SLIDES) return 'Google-presentatie';
  switch (attCategory(att)) {
    case 'word': return 'Word-document';
    case 'sheet': return attExt(att) === 'csv' ? 'CSV-bestand' : 'Excel-werkblad';
    case 'slides': return 'PowerPoint';
    case 'image': return 'Afbeelding';
    case 'pdf': return 'PDF';
    default: return 'Bestand';
  }
}
/** Het type in de kolom Type; bij een gekoppeld bestand met waar het staat ("PDF · OneDrive"). */
export function attTypeLabel(att: Attachment): string {
  const base = baseTypeLabel(att);
  const provider = cloudProviderOf(att);
  return provider ? `${base} · ${cloudProviderLabel(provider)}` : base;
}
function CategoryGlyph({ att, size }: { att: Attachment; size: number }) {
  switch (attCategory(att)) {
    case 'image': return <ImageIcon size={size} />;
    case 'sheet': return <Sheet size={size} />;
    case 'slides': return <Presentation size={size} />;
    default: return <FileText size={size} />;
  }
}
/**
 * Icoon voor een bestand op basis van het type. Een bestand uit Google Drive of
 * OneDrive krijgt een wolkje in de hoek: het opent daar, en verwijderen gooit
 * het daar in de prullenbak.
 */
export function AttachmentGlyph({ att, size }: { att: Attachment; size: number }) {
  const provider = cloudProviderOf(att);
  if (!provider) return <CategoryGlyph att={att} size={size} />;
  return <span className="att-cloud-glyph" title={`Staat in ${cloudProviderLabel(provider)}`}>
    <CategoryGlyph att={att} size={size} />
    <span className={`att-cloud-badge is-${provider}`} aria-hidden="true"><Cloud size={Math.max(9, Math.round(size * 0.42))} strokeWidth={2.4} /></span>
  </span>;
}
/**
 * Bestandstype-kleur: Word/tekst blauw, Excel/csv groen, presentaties oranje, PDF rood
 * (conventie), overig neutraal — zodat oranje exclusief van presentaties blijft.
 * Notities blijven paars en mappen goud (zie de aanroepers).
 */
export function attAccentColor(att: Attachment): string {
  switch (attCategory(att)) {
    case 'word': return 'var(--accent-b)';
    case 'sheet': return 'var(--accent-g)';
    case 'slides': return 'var(--accent-o)';
    case 'pdf': return 'var(--accent-r)';
    default: return 'var(--muted2)';
  }
}
/** Zelfde kleurtaal voor interne Documents: Office-modus volgt het mime-type, rich-text = tekstdocument = blauw. */
export function documentAccentColor(doc?: Pick<InternalDocument, 'mime_type'> | null): string {
  const m = doc?.mime_type || '';
  if (m.includes('spreadsheet') || m.includes('ms-excel') || m === 'text/csv') return 'var(--accent-g)';
  if (m.includes('presentation') || m.includes('powerpoint')) return 'var(--accent-o)';
  return 'var(--accent-b)';
}
/** Het bestandstype van een Office-document ("Word-document"); null voor een tekstdocument uit de editor. */
export function officeDocumentLabel(doc: Pick<InternalDocument, 'mime_type' | 'storage_key'>): string | null {
  if (!doc.storage_key) return null;
  const m = doc.mime_type || '';
  if (m.includes('spreadsheet') || m.includes('ms-excel') || m === 'text/csv') return 'Excel-werkblad';
  if (m.includes('presentation') || m.includes('powerpoint')) return 'PowerPoint';
  return 'Word-document';
}
/** Icoon voor een intern Document — volgt in Office-modus het bestandstype (Sheet/Presentation). */
export function DocumentGlyph({ doc, size }: { doc?: Pick<InternalDocument, 'mime_type'> | null; size: number }) {
  const m = doc?.mime_type || '';
  if (m.includes('spreadsheet') || m.includes('ms-excel') || m === 'text/csv') return <Sheet size={size} />;
  if (m.includes('presentation') || m.includes('powerpoint')) return <Presentation size={size} />;
  return <FileText size={size} />;
}
