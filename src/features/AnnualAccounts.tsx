import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BookText, CalendarClock, Check, Download, Eye, FileSignature,
  Landmark, Plus, RotateCcw, Scale, Trash2,
} from 'lucide-react';
import type {
  AccountingBasis, AnnualAccount, AnnualAccountAdoptionMethod, AnnualAccountListRow,
  AnnualAccountSignatureRole, AnnualAccountSnapshot, AppData, CompanySizeResult,
  FiscalYearListRow, FiscalYearSizeInputs, Shareholder, SizeClass,
} from '../types';
import { SIZE_CLASS_ARTICLES, SIZE_CLASS_LABELS } from '../types';
import { Button, Input, Select, Skeleton, Textarea } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import {
  adoptAnnualAccounts, buildAnnualAccountsSnapshot, determineCompanySize, extendPreparationTerm, fileAnnualAccounts,
  getAnnualAccount, listAnnualAccounts, listFiscalYears, listShareholders,
  loadFiscalYearSizeInputs, prepareAnnualAccounts, reverseAnnualAccounts,
  saveFiscalYearSizeInputs, signAnnualAccounts,
} from '../lib/repository';
import {
  downloadAnnualAccountsPdf, downloadAnnualAccountsPublication, pdfBlob,
  previewAnnualAccountsPdf, renderAnnualAccountsPdf, renderAnnualAccountsPublication,
  type AnnualAccountsPdfResult,
} from '../services/annualAccountsService';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const today = () => new Date().toISOString().slice(0, 10);

/** Euro-invoer naar centen; accepteert zowel komma als punt. */
function parseEuro(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const STATUS_LABELS: Record<string, string> = {
  prepared: 'Opgemaakt',
  adopted: 'Vastgesteld',
  filed: 'Gedeponeerd',
  reversed: 'Ingetrokken',
};

const SIZE_CLASSES: SizeClass[] = ['micro', 'klein', 'middelgroot', 'groot'];

/** Hoe ver een datum nog weg is; stuurt alleen de kleur van de tegel. */
function deadlineTone(date: string | null | undefined): '' | 'is-soon' | 'is-late' {
  if (!date) return '';
  const now = today();
  if (date < now) return 'is-late';
  const days = (Date.parse(date) - Date.parse(now)) / 86400000;
  return days <= 30 ? 'is-soon' : '';
}

/**
 * Wat er per grootteklasse openbaar wordt gemaakt, en wat ResoFly daarvan
 * NIET levert. Spiegel van PUBLICATION_SETS in
 * supabase/functions/_shared/annualAccountsLayout.ts — daar wordt het stuk
 * werkelijk opgebouwd; hier staat het zodat de gebruiker vóór het genereren
 * ziet wat hij krijgt en wat hij er zelf bij moet doen.
 */
const PUBLICATION_SETS: Record<SizeClass, { article: string; contents: string[]; missing: string[] }> = {
  micro: {
    article: 'art. 2:395a lid 8 jo. lid 3 en 4 BW',
    contents: ['Beperkte balans op het niveau van de hoofdrubrieken'],
    missing: [],
  },
  klein: {
    article: 'art. 2:396 lid 8 jo. lid 3 en lid 7 BW',
    contents: [
      'Verkorte balans op rubriekniveau',
      'Toelichting, zonder de gegevens van art. 2:380a BW',
    ],
    missing: [],
  },
  middelgroot: {
    article: 'art. 2:397 BW (samentrekking tot Bruto-bedrijfsresultaat: lid 4)',
    contents: [
      'Enigszins beperkte balans (rubrieken met de onderliggende rekeningen)',
      'Vereenvoudigde winst-en-verliesrekening met de post Bruto-bedrijfsresultaat',
      'Toelichting: grondslagen, eigen vermogen, niet in de balans opgenomen verplichtingen, gemiddeld aantal werknemers en de belastinglast',
    ],
    missing: [
      'Bestuursverslag (art. 2:391 BW)',
      'Accountantsverklaring (art. 2:393 BW)',
      'Overige gegevens (art. 2:392 BW)',
      'Bezoldiging van bestuurders en commissarissen (art. 2:383 BW)',
      'Honoraria van de accountantsorganisatie (art. 2:382a BW)',
    ],
  },
  groot: {
    article: 'geen vrijstellingsartikel van toepassing (art. 2:361 e.v. BW)',
    contents: [
      'Balans met de onderliggende grootboekrekeningen',
      'Winst-en-verliesrekening met de onderliggende grootboekrekeningen',
      'Toelichting: grondslagen, eigen vermogen, niet in de balans opgenomen verplichtingen, gemiddeld aantal werknemers en de belastinglast',
    ],
    missing: [
      'Bestuursverslag (art. 2:391 BW)',
      'Accountantsverklaring (art. 2:393 BW)',
      'Overige gegevens (art. 2:392 BW)',
      'Bezoldiging van bestuurders en commissarissen (art. 2:383 BW)',
      'Honoraria van de accountantsorganisatie (art. 2:382a BW)',
    ],
  },
};

const PUBLICATION_BANNER =
  'Dit PDF-bestand is een werk- en archiefstuk. Deponeren bij het handelsregister gaat voor micro, kleine en '
  + 'middelgrote rechtspersonen verplicht digitaal in SBR/XBRL (en voor grote rechtspersonen vanaf boekjaar 2025); '
  + 'ResoFly levert dat bestand niet. Gebruik dit stuk om te controleren en te archiveren, niet om te deponeren.';

type SizeForm = {
  averageEmployees: string;
  totalAssets: string;
  netTurnover: string;
  overrideReason: string;
  earlyAdopt: boolean;
  isFirstYear: boolean;
  openingSizeClass: string;
  parentName: string;
  parentCity: string;
  note: string;
};

const EMPTY_SIZE_FORM: SizeForm = {
  averageEmployees: '', totalAssets: '', netTurnover: '', overrideReason: '',
  earlyAdopt: false, isFirstYear: false, openingSizeClass: '',
  parentName: '', parentCity: '', note: '',
};

function sizeFormFrom(row: FiscalYearSizeInputs | null): SizeForm {
  if (!row) return { ...EMPTY_SIZE_FORM };
  return {
    averageEmployees: String(row.average_employees ?? '').replace('.', ','),
    totalAssets: row.total_assets_cents == null ? '' : (row.total_assets_cents / 100).toFixed(2).replace('.', ','),
    netTurnover: row.net_turnover_cents == null ? '' : (row.net_turnover_cents / 100).toFixed(2).replace('.', ','),
    overrideReason: row.override_reason ?? '',
    earlyAdopt: row.early_adopt_new_thresholds,
    isFirstYear: row.is_first_fiscal_year_of_entity,
    openingSizeClass: row.opening_size_class ?? '',
    parentName: row.consolidating_parent_name ?? '',
    parentCity: row.consolidating_parent_city ?? '',
    note: row.note ?? '',
  };
}

type DialogState =
  | { kind: 'prepare' }
  | { kind: 'adopt'; account: AnnualAccount }
  | { kind: 'file'; account: AnnualAccount }
  | { kind: 'extend'; account: AnnualAccount }
  | { kind: 'reverse'; account: AnnualAccount };

/**
 * De jaarrekening.
 *
 * Vier juridisch verschillende gebeurtenissen met vier beslissers en vier
 * termijnen: het bestuur MAAKT OP (art. 2:210 lid 1 BW), de bestuurders en
 * commissarissen ONDERTEKENEN (lid 2), de algemene vergadering STELT VAST
 * (lid 3) of de ondertekening doet dat zelf (lid 5), en de rechtspersoon
 * DEPONEERT bij het handelsregister (art. 2:394 BW). Dit scherm houdt ze uit
 * elkaar; de database bewaakt de volgorde en weigert met een melding die de
 * volgende knop noemt.
 *
 * Twee dingen waar dit scherm zich niet uit laat praten:
 *   * De deponeerdatum voor een BV waarvan alle aandeelhouders bestuurder zijn
 *     is BETWIST. KVK houdt tien maanden en acht dagen aan; Hof
 *     's-Hertogenbosch 13-9-2022 (ECLI:NL:GHSHE:2022:3141) houdt de twaalf
 *     maanden van art. 2:394 lid 3 BW aan. Er is geen uitspraak van de Hoge
 *     Raad, dus staan beide datums naast elkaar en kiest ResoFly niet.
 *   * Vaststellen via ondertekening (art. 2:210 lid 5 BW) strekt TEVENS tot
 *     kwijting. Wie die route kiest dechargeert zijn medebestuurders; dat staat
 *     als waarschuwing in de bevestiging, met de drie voorwaarden erbij.
 */
export function AnnualAccountsPage({ data, organizationId, canWrite, canAdmin, businessActive, onChanged }: {
  data: AppData; organizationId: string; canWrite: boolean; canAdmin: boolean;
  businessActive: boolean; onChanged: () => void;
}) {
  const [years, setYears] = useState<FiscalYearListRow[]>([]);
  const [fiscalYearId, setFiscalYearId] = useState<string>('');
  const [rows, setRows] = useState<AnnualAccountListRow[]>([]);
  const [detail, setDetail] = useState<AnnualAccount | null>(null);
  /** Ongehashte cijfers vóór het opmaken; hetzelfde beeld, alleen niet bevroren. */
  const [concept, setConcept] = useState<AnnualAccountSnapshot | null>(null);
  const [size, setSize] = useState<CompanySizeResult | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [sizeInputs, setSizeInputs] = useState<FiscalYearSizeInputs | null>(null);
  const [sizeForm, setSizeForm] = useState<SizeForm>({ ...EMPTY_SIZE_FORM });
  const [shareholders, setShareholders] = useState<Shareholder[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [preview, setPreview] = useState<{ url: string; result: AnnualAccountsPdfResult } | null>(null);

  const legalForm = data.companySettings?.legal_form ?? 'eenmanszaak';
  const isCorporate = ['bv', 'nv', 'cooperatie'].includes(legalForm);

  /** Het stuk dat voor dit boekjaar telt: eerst wat nog in behandeling is. */
  const current = useMemo(() => {
    const own = rows.filter(r => r.fiscal_year_id === fiscalYearId);
    return own.find(r => r.status === 'prepared' || r.status === 'adopted')
      ?? own.find(r => r.status === 'filed')
      ?? null;
  }, [rows, fiscalYearId]);

  /** De laatst gedeponeerde jaarrekening van dit boekjaar; die wordt vervangen. */
  const filedForYear = useMemo(
    () => rows.filter(r => r.fiscal_year_id === fiscalYearId && r.status === 'filed'),
    [rows, fiscalYearId],
  );

  /**
   * Het oudste boekjaar in deze administratie. Alleen dáár is "eerste boekjaar
   * van de rechtspersoon" te bevestigen; de database weigert het elders, en het
   * is het startpunt van de tweejaarstoets.
   */
  const oldestYearId = useMemo(() => {
    let oldest: FiscalYearListRow | null = null;
    for (const y of years) if (!oldest || y.period_start < oldest.period_start) oldest = y;
    return oldest?.id ?? null;
  }, [years]);

  const loadBase = useCallback(async () => {
    const [ys, as, sh] = await Promise.all([
      listFiscalYears(organizationId),
      listAnnualAccounts(organizationId),
      listShareholders(organizationId).catch(() => [] as Shareholder[]),
    ]);
    setYears(ys);
    setRows(as);
    setShareholders(sh);
    setFiscalYearId(prev => prev || ys.find(y => y.status === 'closed')?.id || ys[0]?.id || '');
  }, [organizationId]);

  /** Groottegegevens en groottetoets van het gekozen boekjaar. */
  const loadYear = useCallback(async (id: string) => {
    // Conceptcijfers horen bij één boekjaar; ze mogen niet blijven staan als er
    // van boekjaar wordt gewisseld.
    setConcept(null);
    if (!id) { setSize(null); setSizeInputs(null); setSizeForm({ ...EMPTY_SIZE_FORM }); return; }
    const inputs = await loadFiscalYearSizeInputs(organizationId, id);
    setSizeInputs(inputs);
    setSizeForm(sizeFormFrom(inputs));
    try {
      setSize(await determineCompanySize(organizationId, id));
      setSizeError(null);
    } catch (e) {
      // Een weigering hier (geen afgesloten boekjaar, ontbrekende drempels) mag
      // de rest van het scherm niet leegtrekken.
      setSize(null);
      setSizeError(e instanceof Error ? e.message : 'De grootteklasse kon niet worden bepaald.');
    }
  }, [organizationId]);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      await loadBase();
    } catch (e) { setError(e instanceof Error ? e.message : 'Laden mislukt'); }
    finally { setLoading(false); }
  }, [loadBase]);

  useEffect(() => { if (isCorporate && businessActive) void reload(); }, [reload, isCorporate, businessActive]);

  useEffect(() => {
    if (!isCorporate || !businessActive || !fiscalYearId) return;
    void loadYear(fiscalYearId).catch(e => setError(e instanceof Error ? e.message : 'Groottegegevens laden mislukt'));
  }, [fiscalYearId, loadYear, isCorporate, businessActive]);

  // Het detail hangt aan de rij die voor dit boekjaar telt; zonder rij is er
  // niets te tonen dan de knop "Jaarrekening opmaken".
  useEffect(() => {
    let cancelled = false;
    // Meteen leegmaken, vóór de await. Anders blijft bij een wissel van boekjaar
    // het stuk van het VORIGE jaar in beeld — en erger: de actieknoppen geven dat
    // id door, zodat je denkt boekjaar B vast te stellen terwijl je A vaststelt.
    // De database weigert dat niet; die controleert alleen of het id in de
    // organisatie bestaat, niet of het bij het gekozen boekjaar hoort.
    setDetail(null);
    if (!current) return () => { cancelled = true; };
    getAnnualAccount(organizationId, current.id)
      .then(a => { if (!cancelled) setDetail(a); })
      .catch(e => {
        if (cancelled) return;
        setDetail(null);
        setError(e instanceof Error ? e.message : 'Jaarrekening laden mislukt');
      });
    return () => { cancelled = true; };
  }, [organizationId, current]);

  // Object-URL's van een voorbeeld moeten weer vrij; anders houdt het tabblad
  // elke bekeken PDF in het geheugen vast.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  async function run(action: () => Promise<void>, ok: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      await action();
      await loadBase();
      await loadYear(fiscalYearId);
      onChanged();
      setMessage(ok);
    } catch (e) { setError(e instanceof Error ? e.message : 'Actie mislukt'); }
    finally { setBusy(false); }
  }

  /** PDF-acties: geen herlaadronde over de hele lijst, wel de melding. */
  async function runPdf(action: () => Promise<AnnualAccountsPdfResult>, ok: string, asPreview = false) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await action();
      if (asPreview) {
        if (preview) URL.revokeObjectURL(preview.url);
        setPreview({ url: URL.createObjectURL(pdfBlob(result)), result });
      } else if (current) {
        // Na het archiveren wijzen pdf_attachment_id / publication_attachment_id
        // naar het opgeslagen exemplaar; die stand komt uit de database.
        setRows(await listAnnualAccounts(organizationId));
        setDetail(await getAnnualAccount(organizationId, current.id));
      }
      setMessage(result.source === 'regenerated'
        ? `${ok} Let op: er was geen gearchiveerd exemplaar, dit stuk is opnieuw opgebouwd uit dezelfde bevroren cijfers.`
        : ok);
    } catch (e) { setError(e instanceof Error ? e.message : 'PDF maken mislukt'); }
    finally { setBusy(false); }
  }

  /**
   * De conceptcijfers ophalen. Bewust NIET via run(): die herlaadt het boekjaar
   * en zou het net opgehaalde concept meteen weer wissen.
   */
  async function loadConcept() {
    setBusy(true); setError(null); setMessage(null);
    try {
      setConcept(await buildAnnualAccountsSnapshot(organizationId, fiscalYearId));
    } catch (e) {
      setConcept(null);
      setError(e instanceof Error ? e.message : 'Conceptcijfers ophalen mislukt');
    } finally { setBusy(false); }
  }

  const saveSize = () => run(async () => {
    const employees = Number(sizeForm.averageEmployees.replace(',', '.'));
    if (!sizeForm.averageEmployees.trim() || !Number.isFinite(employees) || employees < 0) {
      throw new Error('Vul het gemiddeld aantal werknemers over het boekjaar in (art. 2:395a/396/397 lid 1 onder c BW). Zonder dat getal is de grootteklasse niet te bepalen.');
    }
    await saveFiscalYearSizeInputs(organizationId, {
      fiscalYearId,
      averageEmployees: employees,
      totalAssetsCents: parseEuro(sizeForm.totalAssets),
      netTurnoverCents: parseEuro(sizeForm.netTurnover),
      overrideReason: sizeForm.overrideReason.trim() || null,
      earlyAdoptNewThresholds: sizeForm.earlyAdopt,
      consolidatingParentName: sizeForm.parentName.trim() || null,
      consolidatingParentCity: sizeForm.parentCity.trim() || null,
      note: sizeForm.note.trim() || null,
      isFirstFiscalYearOfEntity: sizeForm.isFirstYear,
      openingSizeClass: (sizeForm.openingSizeClass || null) as SizeClass | null,
    });
  }, 'Groottegegevens vastgelegd.');

  // ── Vroege returns, ná alle hooks ────────────────────────────────────────
  if (!isCorporate) {
    return <div className="bk-page"><div className="empty">
      <div className="e-big">Jaarrekening</div>
      <div>
        Een jaarrekening volgens Titel 9 Boek 2 BW hoort bij een BV, NV of coöperatie.
        Bij deze rechtsvorm ({legalForm}) geldt die verplichting niet.
        Staat je rechtsvorm verkeerd, pas hem dan aan bij Instellingen → Bedrijfsgegevens.
      </div>
    </div></div>;
  }

  if (!businessActive) {
    return <div className="bk-page"><div className="bk-setup">
      <div><strong>De zakelijke module staat uit.</strong>
        <p>De jaarrekening, de groottetoets en de publicatiestukken horen bij de zakelijke module. Zet die aan via Instellingen → Abonnement.</p></div>
    </div></div>;
  }

  const selectedYear = years.find(y => y.id === fiscalYearId) ?? null;
  const effectiveClass: SizeClass | null = detail?.effectiveSizeClass ?? size?.sizeClass ?? null;

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div>
          <h2>Jaarrekening</h2>
          <p>
            Opmaken, ondertekenen, vaststellen en deponeren — vier verschillende handelingen met vier eigen termijnen.
            De cijfers worden bij het opmaken bevroren met een hash, zodat het stuk dat de algemene vergadering vaststelt
            en dat bij het handelsregister ligt over jaren nog letterlijk hetzelfde is.
          </p>
        </div>
        <div className="bk-head-actions">
          <Select value={fiscalYearId} onChange={e => setFiscalYearId(e.target.value)}>
            {years.length === 0 && <option value="">Geen boekjaren</option>}
            {years.map(y => (
              <option key={y.id} value={y.id}>{y.label}{y.status === 'open' ? ' (open)' : ''}</option>
            ))}
          </Select>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <p className="bk-note">{message}</p>}

      {loading ? <div className="bk-report-loading"><Skeleton lines={8} /></div> : (
        <>
          {selectedYear?.status === 'open' && (
            <div className="bk-setup">
              <div>
                <strong>Boekjaar {selectedYear.label} staat nog open.</strong>
                <p>
                  Een jaarrekening wordt opgemaakt op de afgesloten cijfers. Sluit het boekjaar eerst af
                  (Boekjaren → Boekjaar afsluiten) en leg daarna de resultaatbestemming vast; pas dan kan er worden opgemaakt.
                </p>
              </div>
            </div>
          )}

          {/* ── Groottebepaling ── */}
          <SizeSection
            year={selectedYear}
            size={size}
            sizeError={sizeError}
            inputs={sizeInputs}
            form={sizeForm}
            onForm={setSizeForm}
            canWrite={canWrite}
            busy={busy}
            frozen={Boolean(detail)}
            isOldestYear={Boolean(selectedYear) && selectedYear?.id === oldestYearId}
            onSave={saveSize}
          />

          {/* ── Het stuk zelf ── */}
          <div className="bk-report">
            <div className="bk-subhead">
              <div>
                <h3><BookText size={15} /> De jaarrekening van {selectedYear?.label ?? 'dit boekjaar'}</h3>
                <p className="bk-muted">
                  Opmaken bevriest balans, winst-en-verliesrekening, groottetoets, resultaatbestemming en Vpb-berekening in één
                  gehashte momentopname. Daarna komt alles wat je hier ziet uit die momentopname en niet meer uit het grootboek.
                </p>
              </div>
              {/* Ook ná een deponering: die deponering blijft staan, maar herstel
                  gaat met een OPVOLGEND stuk (art. 2:394 BW). Zonder deze knop zou
                  een fout in een gedeponeerde jaarrekening niet te herstellen zijn. */}
              {canWrite && (!detail || detail.status === 'filed') && (
                <Button variant="primary" disabled={busy || !fiscalYearId} onClick={() => { setDialog({ kind: 'prepare' }); setError(null); setMessage(null); }}>
                  <Plus size={14} /> {detail ? 'Vervangend stuk opmaken' : 'Jaarrekening opmaken'}
                </Button>
              )}
            </div>

            {!detail ? (
              <>
                <p className="bk-muted">
                  Voor dit boekjaar is nog geen jaarrekening opgemaakt.
                  {filedForYear.length > 0 && ' Er ligt wél een gedeponeerd stuk; een nieuwe jaarrekening vervangt dat, met opgaaf van reden.'}
                </p>
                {/* De cijfers zoals ze bij het opmaken bevroren zouden worden.
                    Hier zie je vóóraf of de balans sluit en of er een
                    resultaatbestemming ligt — precies waar het opmaken op weigert. */}
                <div className="bk-fy-new-actions">
                  <Button disabled={busy || !fiscalYearId} onClick={loadConcept}>
                    <Eye size={14} /> Conceptcijfers bekijken
                  </Button>
                </div>
                <FrozenFigures snapshot={concept} />
              </>
            ) : (
              <>
                <div className="bk-report-bar">
                  <div className="bk-report-kpis">
                    <div><span>Stand</span><strong>{STATUS_LABELS[detail.status] ?? detail.status}</strong></div>
                    <div><span>Grootteklasse</span><strong>{SIZE_CLASS_LABELS[detail.effectiveSizeClass]}</strong></div>
                    <div><span>Opgemaakt op</span><strong>{dateNL(detail.preparedOn)}</strong></div>
                    <div>
                      <span>Ondertekend</span>
                      <strong>{detail.signatures.filter(s => s.signed).length} / {detail.signatures.length}</strong>
                    </div>
                  </div>
                  <span className={`status-pill ${detail.status === 'filed' ? 'bk-je-posted' : detail.status === 'prepared' ? 'bk-status-draft' : ''}`}>
                    {STATUS_LABELS[detail.status] ?? detail.status}
                  </span>
                </div>

                {detail.snapshotStale && (
                  <div className="error">
                    <strong>De bevroren cijfers wijken af van de administratie.</strong>{' '}
                    Het boekjaar is heropend of de resultaatbestemming is vervangen ná het opmaken. Wat hieronder staat is
                    het stuk zoals het is opgemaakt — niet wat er nu in het grootboek staat. Vaststellen en deponeren zijn
                    geblokkeerd zolang dit zo is.{' '}
                    {detail.status === 'filed'
                      ? 'Dit stuk is gedeponeerd en kan niet worden ingetrokken (art. 2:394 BW): verwerk de correctie in een opvolgend stuk dat deze jaarrekening vervangt.'
                      : 'Laat een eigenaar of beheerder de jaarrekening intrekken en maak haar daarna opnieuw op.'}
                  </div>
                )}

                {detail.supersedesAnnualAccountId && (
                  <p className="bk-note">
                    Dit stuk vervangt een eerder gedeponeerde jaarrekening van hetzelfde boekjaar. Reden: {detail.supersedeReason}.
                    De oude deponering blijft staan — die is een feit (art. 2:394 BW).
                  </p>
                )}

                <DeadlinePanel account={detail} row={current} />

                <SignatureTable
                  account={detail}
                  canWrite={canWrite}
                  busy={busy}
                  onSign={(signatureId, input) => run(
                    async () => { await signAnnualAccounts(organizationId, signatureId, input); },
                    input.signed ? 'Handtekening vastgelegd.' : 'Reden van de ontbrekende handtekening vastgelegd.',
                  )}
                />

                <FrozenFigures snapshot={detail.snapshot} />

                <div className="bk-fy-new-actions">
                  {canWrite && detail.status === 'prepared' && (
                    <Button disabled={busy} onClick={() => { setDialog({ kind: 'extend', account: detail }); setError(null); setMessage(null); }}>
                      <CalendarClock size={14} /> Opmaaktermijn verlengen
                    </Button>
                  )}
                  {canWrite && detail.adoptionDate === null && (
                    <Button variant="primary" disabled={busy || detail.snapshotStale} onClick={() => { setDialog({ kind: 'adopt', account: detail }); setError(null); setMessage(null); }}>
                      <Check size={14} /> Vaststellen
                    </Button>
                  )}
                  {canWrite && detail.status !== 'reversed' && (
                    <Button disabled={busy || detail.snapshotStale} onClick={() => { setDialog({ kind: 'file', account: detail }); setError(null); setMessage(null); }}>
                      <Landmark size={14} /> Deponering vastleggen
                    </Button>
                  )}
                  <Button disabled={busy} onClick={() => runPdf(() => previewAnnualAccountsPdf(organizationId, detail.id, 'annual'), 'Voorbeeld gemaakt.', true)}>
                    <Eye size={14} /> Voorbeeld
                  </Button>
                  {canWrite && (
                    <Button disabled={busy} onClick={() => runPdf(() => renderAnnualAccountsPdf(organizationId, detail.id), 'Jaarrekening-PDF gemaakt en gearchiveerd.')}>
                      <FileSignature size={14} /> PDF vastleggen
                    </Button>
                  )}
                  <Button disabled={busy} onClick={() => runPdf(() => downloadAnnualAccountsPdf(organizationId, detail.id), 'Jaarrekening gedownload.')}>
                    <Download size={14} /> Downloaden
                  </Button>
                  {canAdmin && (detail.status === 'prepared' || detail.status === 'adopted') && (
                    <Button variant="ghost" disabled={busy} onClick={() => { setDialog({ kind: 'reverse', account: detail }); setError(null); setMessage(null); }}>
                      <RotateCcw size={14} /> Jaarrekening intrekken
                    </Button>
                  )}
                </div>

                <p className="settings-help">
                  ResoFly is hierbij een hulpmiddel: geen accountantsproduct en geen fiscaal of juridisch advies.
                  Het bestuur maakt op, de algemene vergadering stelt vast en de rechtspersoon deponeert.
                  Hash van de bevroren cijfers: <code>{detail.snapshotHash.slice(0, 16)}…</code>
                </p>
              </>
            )}
          </div>

          {/* ── Publicatiestukken ── */}
          {detail && (
            <PublicationSection
              account={detail}
              canWrite={canWrite}
              busy={busy}
              onPreview={() => runPdf(() => previewAnnualAccountsPdf(organizationId, detail.id, 'publication'), 'Voorbeeld van het publicatiestuk gemaakt.', true)}
              onRender={() => runPdf(() => renderAnnualAccountsPublication(organizationId, detail.id), 'Publicatiestuk gemaakt en gearchiveerd.')}
              onDownload={() => runPdf(() => downloadAnnualAccountsPublication(organizationId, detail.id), 'Publicatiestuk gedownload.')}
            />
          )}

          {/* ── Alle jaarrekeningen ── */}
          {rows.length > 0 && (
            <div className="bk-report">
              <div className="bk-subhead">
                <div>
                  <h3><Scale size={15} /> Alle jaarrekeningen</h3>
                  <p className="bk-muted">
                    Per boekjaar één stuk in behandeling; een ingetrokken exemplaar blijft staan als spoor en een gedeponeerd
                    exemplaar als feit. Beide blokkeren een opvolgend stuk niet.
                  </p>
                </div>
              </div>
              <div className="bk-table-wrap"><table className="bk-table">
                <thead><tr>
                  <th>Boekjaar</th><th>Stand</th><th>Klasse</th><th>Opgemaakt</th>
                  <th>Vastgesteld</th><th>Gedeponeerd</th><th>Deponeertermijnen</th><th>Handtekeningen</th>
                </tr></thead>
                <tbody>{rows.map(r => (
                  <tr key={r.id} className={r.status === 'reversed' ? 'is-reversed' : ''}>
                    <td>
                      <strong>{r.fiscal_year_label}</strong>
                      {r.snapshot_stale && <span className="bk-neg" title="De bevroren cijfers wijken af van de administratie"> · afwijking</span>}
                    </td>
                    <td>
                      {STATUS_LABELS[r.status] ?? r.status}
                      {r.filed_unadopted && <span className="bk-muted"> · onvastgesteld</span>}
                      {r.refiling_required && <span className="bk-neg"> · opnieuw deponeren</span>}
                    </td>
                    <td>
                      {SIZE_CLASS_LABELS[r.effective_size_class]}
                      {r.size_class_override && <span className="bk-muted"> · handmatig</span>}
                    </td>
                    <td>{dateNL(r.prepared_on)}</td>
                    <td>{r.adoption_date ? dateNL(r.adoption_date) : <span className="bk-muted">—</span>}</td>
                    <td>{r.filing_date ? dateNL(r.filing_date) : <span className="bk-muted">—</span>}</td>
                    {/* Na vaststelling is de STRENGSTE termijn acht dagen daarna
                        (art. 2:394 lid 1 BW), niet de twaalfmaandsgrens. Alleen die
                        grens tonen leest als "je hebt nog maanden" terwijl de plicht
                        al over een week verstrijkt. Daarom altijd de strengste
                        toepasselijke datum vooraan, met de andere ernaast. */}
                    <td className={deadlineTone(r.adoption_date ? r.file_deadline_after_adoption : r.file_deadline_hard) === 'is-late' ? 'bk-neg' : ''}>
                      {r.adoption_date && r.file_deadline_after_adoption ? <>
                        {dateNL(r.file_deadline_after_adoption)}
                        <span className="bk-muted" title="Acht dagen na vaststelling (art. 2:394 lid 1 BW)"> · 8 dagen na vaststelling</span>
                        {r.file_deadline_hard && <span className="bk-muted"> · uiterlijk {dateNL(r.file_deadline_hard)}</span>}
                      </> : <>
                        {r.file_deadline_hard ? dateNL(r.file_deadline_hard) : '—'}
                        {r.file_deadline_safe && (
                          <span className="bk-muted" title="Streefdatum volgens de lijn van KVK bij een BV waarvan alle aandeelhouders bestuurder zijn. Hierover wordt verschillend geoordeeld: Hof 's-Hertogenbosch 13-9-2022 (ECLI:NL:GHSHE:2022:3141) houdt twaalf maanden aan.">
                            {' '}· streef {dateNL(r.file_deadline_safe)} (betwist)
                          </span>
                        )}
                      </>}
                    </td>
                    <td>
                      {r.signatures_signed} / {r.signatures_total}
                      {r.signatures_missing_without_reason > 0 && (
                        <span className="bk-neg" title="Ontbrekende handtekening zonder opgave van reden (art. 2:210 lid 2 BW)">
                          {' '}· {r.signatures_missing_without_reason} zonder reden
                        </span>
                      )}
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          )}
        </>
      )}

      {/* ── Voorbeeld ── */}
      {preview && (
        <div className="bk-modal-backdrop" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>
          <div className="bk-modal bk-modal-wide" onClick={e => e.stopPropagation()}>
            <h3>{preview.result.variant === 'publication' ? 'Publicatiestuk' : 'Jaarrekening'} — voorbeeld</h3>
            <p className="bk-muted">
              Exact dezelfde bytes als het definitieve stuk; alleen niet opgeslagen. {preview.result.fileName}
            </p>
            <iframe title="Voorbeeld" src={preview.url} style={{ width: '100%', height: '62vh', border: '1px solid var(--border)', borderRadius: 12 }} />
            <div className="bk-modal-actions">
              <Button onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>Sluiten</Button>
            </div>
          </div>
        </div>
      )}

      {dialog?.kind === 'prepare' && (
        <PrepareDialog
          year={selectedYear}
          size={size}
          shareholders={shareholders}
          filed={filedForYear}
          busy={busy}
          error={error}
          onCancel={() => setDialog(null)}
          onSubmit={(input) => run(async () => {
            await prepareAnnualAccounts(organizationId, { ...input, fiscalYearId });
            setDialog(null);
          }, 'Jaarrekening opgemaakt en de cijfers bevroren.')}
        />
      )}

      {dialog?.kind === 'adopt' && (
        <AdoptDialog
          account={dialog.account}
          busy={busy}
          error={error}
          onCancel={() => setDialog(null)}
          onSubmit={(input) => run(async () => {
            await adoptAnnualAccounts(organizationId, dialog.account.id, input);
            setDialog(null);
          }, 'Jaarrekening vastgesteld.')}
        />
      )}

      {dialog?.kind === 'file' && (
        <FileDialog
          account={dialog.account}
          busy={busy}
          error={error}
          onCancel={() => setDialog(null)}
          onSubmit={(input) => run(async () => {
            await fileAnnualAccounts(organizationId, dialog.account.id, input);
            setDialog(null);
          }, 'Deponering vastgelegd.')}
        />
      )}

      {dialog?.kind === 'extend' && (
        <ExtendDialog
          account={dialog.account}
          busy={busy}
          error={error}
          onCancel={() => setDialog(null)}
          onSubmit={(input) => run(async () => {
            await extendPreparationTerm(organizationId, dialog.account.id, input);
            setDialog(null);
          }, 'Verlenging van de opmaaktermijn vastgelegd.')}
        />
      )}

      {dialog?.kind === 'reverse' && (
        <ReverseDialog
          account={dialog.account}
          busy={busy}
          error={error}
          onCancel={() => setDialog(null)}
          onSubmit={(reason) => run(async () => {
            await reverseAnnualAccounts(organizationId, dialog.account.id, reason);
            setDialog(null);
          }, 'Jaarrekening ingetrokken.')}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────── groottebepaling

/**
 * De groottetoets. Drie criteria (balanstotaal, netto-omzet, gemiddeld aantal
 * werknemers), minstens twee ervan, en een PLAKKERIGE tweejaarsregel: een
 * over- of onderschrijding telt pas als zij zich op twee opeenvolgende
 * balansdata voordoet. Het werknemersaantal is nergens uit af te leiden en dus
 * verplichte invoer; zonder dat getal geeft de database een blokkerende reden
 * en weigert het opmaken.
 */
function SizeSection({ year, size, sizeError, inputs, form, onForm, canWrite, busy, frozen, isOldestYear, onSave }: {
  year: FiscalYearListRow | null;
  size: CompanySizeResult | null;
  sizeError: string | null;
  inputs: FiscalYearSizeInputs | null;
  form: SizeForm;
  onForm: (updater: (f: SizeForm) => SizeForm) => void;
  canWrite: boolean;
  busy: boolean;
  /** Is er al opgemaakt? Dan bepaalt de bevroren klasse het stuk, niet deze toets. */
  frozen: boolean;
  /** Alleen op het oudste boekjaar is "eerste boekjaar" te bevestigen. */
  isOldestYear: boolean;
  onSave: () => void;
}) {
  const set = <K extends keyof SizeForm>(k: K, v: SizeForm[K]) => onForm(f => ({ ...f, [k]: v }));
  // Art. 4 Stb. 2024, 52 stelt de vervroegde toepassing uitsluitend open voor een
  // boekjaar dat in 2023 aanvangt; elders weigert de database hem.
  const canEarlyAdopt = (year?.period_start ?? '').slice(0, 4) === '2023';

  return (
    <div className="bk-report">
      <div className="bk-subhead">
        <div>
          <h3><Scale size={15} /> Grootteklasse van {year?.label ?? 'het boekjaar'}</h3>
          <p className="bk-muted">
            Micro, klein, middelgroot of groot (art. 2:395a, 2:396 en 2:397 lid 1 BW). De klasse bepaalt wat er moet worden
            opgemaakt, of er een accountantscontrole nodig is en hoe beperkt het publicatiestuk mag zijn.
          </p>
        </div>
      </div>

      {sizeError && <p className="bk-note">{sizeError}</p>}

      {size && (
        <>
          <div className="bk-report-bar">
            <div className="bk-report-kpis">
              <div>
                <span>Klasse</span>
                <strong>{size.sizeClass ? SIZE_CLASS_LABELS[size.sizeClass] : '—'}</strong>
              </div>
              <div><span>Balanstotaal</span><strong>{euroCents(size.current.assetsCents)}</strong></div>
              <div><span>Netto-omzet</span><strong>{euroCents(size.current.turnoverCents)}</strong></div>
              <div><span>Werknemers (gem.)</span><strong>{size.current.employees ?? '—'}</strong></div>
              <div>
                <span>Controleplicht</span>
                <strong>{size.auditRequired === null ? 'onbepaald' : size.auditRequired ? 'ja' : 'nee'}</strong>
              </div>
            </div>
          </div>

          {size.sizeClass && (
            <p className="bk-muted">
              {SIZE_CLASS_LABELS[size.sizeClass]} — {SIZE_CLASS_ARTICLES[size.sizeClass]}.
              {size.rawClass && size.rawClass !== size.sizeClass && (
                <> De rauwe toets van dit boekjaar komt uit op {SIZE_CLASS_LABELS[size.rawClass]}; de klasse wisselt pas
                  na twee opeenvolgende balansdata buiten de klasse.</>
              )}
              {size.previousClass && <> Vorig boekjaar: {SIZE_CLASS_LABELS[size.previousClass]}.</>}
              {size.firstYear && ' Dit is het eerste boekjaar; er is geen voorgaande balansdatum om aan te toetsen.'}
            </p>
          )}

          {size.blockingReason && (
            <div className="error">
              <strong>De grootteklasse kan niet worden bepaald.</strong> {size.blockingReason}
              <br />
              Vul dat hieronder aan bij de groottegegevens van dit boekjaar. Lukt dat niet, dan kun je bij het opmaken de
              klasse handmatig vastleggen — met onderbouwing, want zonder die onderbouwing is de klasse bij een controle
              niet te verdedigen.
            </div>
          )}

          {size.warnings.length > 0 && (
            <ul className="settings-help" style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {size.warnings.map((w, i) => <li key={i}><AlertTriangle size={11} /> {w}</li>)}
            </ul>
          )}
        </>
      )}

      {frozen && (
        <p className="bk-muted">
          Er is al opgemaakt. De klasse van dat stuk staat vast in de bevroren onderbouwing; wat je hier wijzigt telt pas
          bij een volgende jaarrekening.
        </p>
      )}

      <div className="bk-fy-new-fields">
        <label><span>Gemiddeld aantal werknemers</span>
          <Input value={form.averageEmployees} onChange={e => set('averageEmployees', e.target.value)}
            placeholder="12,4" disabled={!canWrite} />
        </label>
        <label><span>Balanstotaal (correctie)</span>
          <Input value={form.totalAssets} onChange={e => set('totalAssets', e.target.value)}
            placeholder="leeg = uit het grootboek" disabled={!canWrite} />
        </label>
        <label><span>Netto-omzet (correctie)</span>
          <Input value={form.netTurnover} onChange={e => set('netTurnover', e.target.value)}
            placeholder="leeg = uit het grootboek" disabled={!canWrite} />
        </label>
        <label><span>Klasse vóór dit boekjaar</span>
          <Select value={form.openingSizeClass} onChange={e => set('openingSizeClass', e.target.value)} disabled={!canWrite}>
            <option value="">Niet vastgelegd</option>
            {SIZE_CLASSES.map(c => <option key={c} value={c}>{SIZE_CLASS_LABELS[c]}</option>)}
          </Select>
        </label>
        <label><span>Consoliderende moeder</span>
          <Input value={form.parentName} onChange={e => set('parentName', e.target.value)}
            placeholder="Naam (art. 2:396 lid 5 BW)" disabled={!canWrite} />
        </label>
        <label><span>Woonplaats moeder</span>
          <Input value={form.parentCity} onChange={e => set('parentCity', e.target.value)} disabled={!canWrite} />
        </label>
      </div>

      {isOldestYear && (
        <label className="bk-setting-check">
          <input type="checkbox" checked={form.isFirstYear} disabled={!canWrite}
            onChange={e => set('isFirstYear', e.target.checked)} />
          <span>
            Dit is het eerste boekjaar van de rechtspersoon
            <small className="bk-muted"> De tweejaarstoets heeft een startpunt nodig. ResoFly weet alleen wat het oudste
              boekjaar in de administratie is; of dat ook het eerste boekjaar van de BV is, weet alleen jij. Kwam je met een
              lopende vennootschap over, vul dan hierboven de klasse vóór dit boekjaar in.</small>
          </span>
        </label>
      )}

      {canEarlyAdopt && (
        <label className="bk-setting-check">
          <input type="checkbox" checked={form.earlyAdopt} disabled={!canWrite}
            onChange={e => set('earlyAdopt', e.target.checked)} />
          <span>
            De verhoogde grensbedragen al toepassen op boekjaar 2023
            <small className="bk-muted"> Art. 4 Stb. 2024, 52 staat dat toe voor een boekjaar dat in 2023 aanvangt; het is
              een keuze van deze rechtspersoon.</small>
          </span>
        </label>
      )}

      {(form.totalAssets.trim() || form.netTurnover.trim()) && (
        <label className="bk-setting-field"><span>Waarom wijkt het af van het grootboek?</span>
          <Input value={form.overrideReason} onChange={e => set('overrideReason', e.target.value)}
            placeholder="Bijv. balanstotaal op verkrijgingsprijs, of groepscijfers meegeteld (art. 2:406 BW)"
            disabled={!canWrite} />
        </label>
      )}

      <label className="bk-setting-field"><span>Notitie (optioneel)</span>
        <Input value={form.note} onChange={e => set('note', e.target.value)} disabled={!canWrite} />
      </label>

      {canWrite && (
        <div className="bk-fy-new-actions">
          <Button disabled={busy || !year} onClick={onSave}>
            <Check size={14} /> Groottegegevens opslaan
          </Button>
          {inputs && <span className="bk-muted">Laatst bijgewerkt {dateNL(inputs.updated_at.slice(0, 10))}</span>}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────── deadlines

/**
 * De termijnen naast elkaar. Twee ervan zijn geen keuze van ResoFly:
 * `fileDeadlineSafe` is de KVK-lijn (tien maanden en acht dagen) en
 * `fileDeadlineHard` de twaalf maanden van art. 2:394 lid 3 BW. Over welke van
 * beide geldt bij een BV waarvan alle aandeelhouders bestuurder zijn, wordt
 * verschillend geoordeeld — dus staan ze samen, met de bron erbij.
 */
function DeadlinePanel({ account, row }: { account: AnnualAccount; row: AnnualAccountListRow | null }) {
  const d = account.deadlines ?? {} as AnnualAccount['deadlines'];
  const tile = (label: string, date: string | null, article: string) => (
    <div className={`bk-deadline ${deadlineTone(date)}`} key={label}>
      <span>{label}</span>
      <strong>{date ? dateNL(date) : '—'}</strong>
      <small>{article}</small>
    </div>
  );

  return (
    <div className="bk-deadline-grid">
      {tile('Opmaken', d.prepareDeadlineExtended ?? d.prepareDeadline, account.extensionMonths > 0
        ? `art. 2:210 lid 1 BW · verlengd met ${account.extensionMonths} maand${account.extensionMonths === 1 ? '' : 'en'}`
        : 'art. 2:210 lid 1 BW')}
      {tile('Vaststellen of alsnog deponeren', d.adoptDeadline, 'art. 2:394 lid 2 BW')}
      {account.adoptionDate && tile('Deponeren na vaststelling', d.fileDeadlineAfterAdoption, 'art. 2:394 lid 1 BW — acht dagen')}

      <div className="bk-deadline bk-deadline-disputed">
        <span>Uiterlijk deponeren</span>
        <div className="bk-deadline-pair">
          <div>
            <strong className={deadlineTone(d.fileDeadlineSafe) === 'is-late' ? 'bk-neg' : undefined}>
              {d.fileDeadlineSafe ? dateNL(d.fileDeadlineSafe) : 'n.v.t.'}
            </strong>
            <small>streefdatum — KVK-lijn</small>
          </div>
          <div>
            <strong className={deadlineTone(d.fileDeadlineHard) === 'is-late' ? 'bk-neg' : undefined}>
              {d.fileDeadlineHard ? dateNL(d.fileDeadlineHard) : '—'}
            </strong>
            <small>harde grens — art. 2:394 lid 3 BW</small>
          </div>
        </div>
        <small className="bk-deadline-note">
          {d.fileDeadlineSafeDisputed
            ? 'Hierover wordt verschillend geoordeeld. KVK houdt aan dat een BV waarvan alle aandeelhouders tevens bestuurder zijn binnen tien maanden en acht dagen na afloop van het boekjaar deponeert; Hof ’s-Hertogenbosch 13-9-2022 (ECLI:NL:GHSHE:2022:3141) oordeelde dat de twaalfmaandstermijn leidend blijft. Een uitspraak van de Hoge Raad ontbreekt — ResoFly kiest niet en toont beide.'
            : 'De streefdatum verschijnt alleen zolang er nog niet is vastgesteld én je hebt bevestigd dat alle aandeelhouders tevens bestuurder zijn. Is er vastgesteld, dan geldt de strengere termijn van acht dagen na de vaststelling (art. 2:394 lid 1 BW).'}
        </small>
      </div>

      {row?.refiling_required && (
        <div className="bk-deadline is-late">
          <span>Opnieuw deponeren</span>
          <strong>{d.fileDeadlineAfterAdoption ? dateNL(d.fileDeadlineAfterAdoption) : '—'}</strong>
          <small>
            Dit stuk is onvastgesteld gedeponeerd (art. 2:394 lid 2 BW) en daarna alsnog vastgesteld; het vastgestelde
            exemplaar moet binnen acht dagen opnieuw openbaar worden gemaakt (lid 1).
          </small>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── handtekeningen

function SignatureTable({ account, canWrite, busy, onSign }: {
  account: AnnualAccount;
  canWrite: boolean;
  busy: boolean;
  onSign: (signatureId: string, input: { signed: boolean; signedOn?: string | null; missingReason?: string | null }) => void;
}) {
  return (
    <>
      <div className="bk-subhead">
        <div>
          <h3><FileSignature size={15} /> Ondertekening</h3>
          <p className="bk-muted">
            De jaarrekening wordt ondertekend door de bestuurders en door de commissarissen. Ontbreekt de ondertekening
            van een van hen, dan wordt daarvan onder opgave van reden melding gemaakt (art. 2:210 lid 2 BW) — en die reden
            wordt in het stuk afgedrukt. Ondertekening kent geen eigen wettelijke termijn.
          </p>
        </div>
      </div>

      {/* De waarschuwing hoort HIER, niet pas bij Vaststellen. Zijn de voorwaarden
          van art. 2:210 lid 5 BW vervuld, dan treedt de vaststelling — mét kwijting —
          van rechtswege in zodra de laatste handtekening staat. Wie alleen bij de
          knop "Vaststellen" waarschuwt, waarschuwt te laat: dan is het al gebeurd. */}
      {account.allShareholdersAreDirectors && account.status !== 'reversed' && !account.adoptionDate && (
        <div className="error">
          <strong>Let op: tekenen kan hier meteen vaststellen én kwijting betekenen.</strong>
          <p className="settings-help">
            Bij deze vennootschap is vastgelegd dat alle aandeelhouders tevens bestuurder zijn. Zijn ook de
            overige voorwaarden van art. 2:210 lid 5 BW vervuld — de overige vergadergerechtigden zijn in de
            gelegenheid gesteld kennis te nemen van de opgemaakte jaarrekening en hebben ingestemd met deze
            wijze van vaststelling (art. 2:238 lid 1 BW), en de statuten sluiten het niet uit — dan geldt de
            ondertekening door alle bestuurders en commissarissen <strong>tevens als vaststelling</strong>, en
            strekt zij in afwijking van lid 3 <strong>tevens tot kwijting</strong>. Dat gebeurt van rechtswege
            op de dag van de laatste handtekening; een later besluit maakt het niet ongedaan.
          </p>
          <p className="settings-help">
            Wil de vennootschap de kwijting los kunnen besluiten, laat de algemene vergadering dan vaststellen
            (art. 2:210 lid 3 BW) in plaats van deze route te volgen. Of dit voor uw vennootschap opgaat,
            beoordeelt u zelf of samen met uw adviseur; ResoFly stelt dat niet vast.
          </p>
        </div>
      )}

      <div className="bk-table-wrap"><table className="bk-table">
        <thead><tr><th>Naam</th><th>Rol</th><th>Getekend</th><th>Reden bij ontbreken</th>{canWrite && <th></th>}</tr></thead>
        <tbody>{account.signatures.map(s => (
          <SignatureRow key={s.id} signature={s} canWrite={canWrite} busy={busy} onSign={onSign} />
        ))}</tbody>
      </table></div>
    </>
  );
}

function SignatureRow({ signature, canWrite, busy, onSign }: {
  signature: AnnualAccount['signatures'][number];
  canWrite: boolean;
  busy: boolean;
  onSign: (signatureId: string, input: { signed: boolean; signedOn?: string | null; missingReason?: string | null }) => void;
}) {
  const [date, setDate] = useState(signature.signedOn ?? today());
  const [reason, setReason] = useState(signature.missingReason ?? '');

  return (
    <tr>
      <td>{signature.personName}</td>
      <td>{signature.role === 'bestuurder' ? 'Bestuurder' : 'Commissaris'}</td>
      <td>
        {signature.signed
          ? <>{dateNL(signature.signedOn ?? '')}</>
          : canWrite
            ? <input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} />
            : <span className="bk-muted">nog niet</span>}
      </td>
      <td>
        {signature.signed
          ? <span className="bk-muted">—</span>
          : canWrite
            ? <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Bijv. langdurig in het buitenland" />
            : (signature.missingReason || <span className="bk-neg">geen reden vastgelegd</span>)}
      </td>
      {canWrite && (
        <td className="bk-cell-action">
          {signature.signed ? (
            <Button variant="ghost" disabled={busy} onClick={() => onSign(signature.id, { signed: false, missingReason: reason || null })}>
              Terugnemen
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => onSign(signature.id, { signed: true, signedOn: date })}>Tekenen</Button>
              <Button variant="ghost" disabled={busy || !reason.trim()}
                onClick={() => onSign(signature.id, { signed: false, missingReason: reason.trim() })}>
                Reden vastleggen
              </Button>
            </>
          )}
        </td>
      )}
    </tr>
  );
}

// ───────────────────────────────────────────────────────────── bevroren cijfers

/**
 * De kerncijfers uit de onderbouwing. Ná het opmaken komen ze uit de bevroren
 * snapshot en nooit uit een live query; vóór het opmaken is het exact hetzelfde
 * beeld, alleen ongehashed — dan heet het een concept.
 */
function FrozenFigures({ snapshot }: { snapshot: AnnualAccountSnapshot | null }) {
  const snap = snapshot;
  if (!snap) return null;
  const balance = snap.balanceSheetAfterAppropriation;
  const ra = snap.resultAppropriation;

  return (
    <div className="bk-balance-cols">
      <div className="bk-table-wrap"><table className="bk-table bk-report-table">
        <thead><tr><th>Balans ná resultaatbestemming</th><th className="bk-num">{snap.fiscalYear.label}</th></tr></thead>
        <tbody>
          <tr><td>Balanstotaal (activa)</td><td className="bk-num">{euroCents(balance?.totalAssetsCents)}</td></tr>
          <tr><td>Passiva</td><td className="bk-num">{euroCents(balance?.totalEquityAndLiabilitiesCents)}</td></tr>
          <tr className="bk-report-total">
            <td>Sluitcontrole</td>
            <td className={`bk-num ${balance?.balances ? 'bk-pos' : 'bk-neg'}`}>
              {balance?.balances ? 'sluit' : `verschil ${euroCents(balance?.differenceCents)}`}
            </td>
          </tr>
          <tr>
            <td>Vrij uitkeerbaar eigen vermogen<span className="bk-muted"> · telt alleen eigenvermogensrekeningen op de balansdatum</span></td>
            <td className="bk-num">{euroCents(snap.distributableEquityCents)}</td>
          </tr>
        </tbody>
      </table></div>

      <div className="bk-table-wrap"><table className="bk-table bk-report-table">
        <thead><tr><th>Resultaat en bestemming</th><th className="bk-num">Bedrag</th></tr></thead>
        <tbody>
          <tr><td>Resultaat boekjaar</td><td className="bk-num">{euroCents(snap.fiscalYear.resultCents)}</td></tr>
          {ra ? (
            <>
              <tr className="bk-balance-sub"><td>Naar de reserves</td><td className="bk-num">{euroCents(ra.reservesCents)}</td></tr>
              <tr className="bk-balance-sub"><td>Als dividend</td><td className="bk-num">{euroCents(ra.dividendCents)}</td></tr>
              <tr className="bk-balance-sub"><td>Besluit van</td><td className="bk-num">{dateNL(ra.decisionDate)}</td></tr>
            </>
          ) : <tr><td colSpan={2} className="bk-muted">Geen resultaatbestemming in de bevroren cijfers.</td></tr>}
          {snap.corporateTax && (
            <tr className="bk-report-total">
              <td>Vennootschapsbelasting {snap.corporateTax.year}</td>
              <td className="bk-num">{euroCents(snap.corporateTax.taxCents)}</td>
            </tr>
          )}
        </tbody>
      </table></div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────── publicatiestukken

/**
 * Het publicatiestuk is een ánder document dan de vastgestelde jaarrekening:
 * beperkter, en gestuurd door de grootteklasse. Dat is geen fout maar de wet.
 * Geen eigen paginasleutel — het hoort bij het stuk waar het uit voortkomt.
 */
function PublicationSection({ account, canWrite, busy, onPreview, onRender, onDownload }: {
  account: AnnualAccount;
  canWrite: boolean;
  busy: boolean;
  onPreview: () => void;
  onRender: () => void;
  onDownload: () => void;
}) {
  const set = PUBLICATION_SETS[account.effectiveSizeClass];

  return (
    <div className="bk-report">
      <div className="bk-subhead">
        <div>
          <h3><Landmark size={15} /> Publicatiestukken</h3>
          <p className="bk-muted">
            Wat er bij het handelsregister openbaar wordt gemaakt, is beperkter dan wat de algemene vergadering vaststelt.
            Hoeveel beperkter hangt af van de grootteklasse: hier {SIZE_CLASS_LABELS[account.effectiveSizeClass]} — {set.article}.
          </p>
        </div>
      </div>

      <div className="bk-balance-cols">
        <div>
          <p className="bk-muted"><strong>Dit bestand bevat</strong></p>
          <ul className="settings-help" style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {set.contents.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
        <div>
          <p className="bk-muted"><strong>Dit bestand bevat níet</strong></p>
          {set.missing.length === 0
            ? <p className="settings-help">Voor deze grootteklasse is de set compleet.</p>
            : <ul className="settings-help" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {set.missing.map((m, i) => <li key={i}>{m}</li>)}
              </ul>}
        </div>
      </div>

      {account.effectiveSizeClass === 'klein' && (
        <p className="settings-help">
          Bij een kleine rechtspersoon blijven de gegevens van art. 2:380a BW uit de gedeponeerde toelichting weg
          (art. 2:396 lid 8 BW). Wat daar precies onder valt is in ResoFly niet tegen de wettekst geverifieerd; controleer
          dit met je accountant voordat je het stuk gebruikt.
        </p>
      )}

      {account.auditRequired && (
        <p className="bk-note">
          Deze rechtspersoon is controleplichtig (art. 2:393 lid 1 BW). Het bestuursverslag, de accountantsverklaring en de
          overige gegevens genereert ResoFly niet — een gegenereerde accountantsverklaring zou per definitie vals zijn.
          Voeg die stukken zelf bij het exemplaar dat je archiveert of laat deponeren.
          {account.auditorName && <> Accountant: {account.auditorName}.</>}
          {!account.auditorOpinionReceived && account.auditorMissingGround && (
            <> De verklaring ontbreekt; vastgelegde wettige grond: {account.auditorMissingGround} (art. 2:393 lid 7 BW).</>
          )}
        </p>
      )}

      <p className="settings-help"><AlertTriangle size={11} /> {PUBLICATION_BANNER}</p>

      <div className="bk-fy-new-actions">
        <Button disabled={busy} onClick={onPreview}><Eye size={14} /> Voorbeeld</Button>
        {canWrite && <Button disabled={busy} onClick={onRender}><BookText size={14} /> Publicatiestuk vastleggen</Button>}
        <Button disabled={busy} onClick={onDownload}><Download size={14} /> Downloaden</Button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────── dialogen

type SignatoryDraft = { name: string; role: AnnualAccountSignatureRole; shareholderId: string };

/** Opmaken door het bestuur (art. 2:210 lid 1 BW). Hier ontstaat het stuk. */
function PrepareDialog({ year, size, shareholders, filed, busy, error, onCancel, onSubmit }: {
  year: FiscalYearListRow | null;
  size: CompanySizeResult | null;
  shareholders: Shareholder[];
  filed: AnnualAccountListRow[];
  busy: boolean;
  /** De weigering uit de database; MOET in de modal staan, want de overlay dekt de paginabrede foutbalk af. */
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: {
    preparedOn: string;
    accountingBasis: AccountingBasis;
    signatories: Array<{ name: string; role: AnnualAccountSignatureRole; shareholderId?: string | null }>;
    offBalanceCommitments: string | null;
    policyChangeNote: string | null;
    sizeClassOverride: SizeClass | null;
    sizeOverrideReason: string | null;
    note: string | null;
    allShareholdersAreDirectors: boolean;
    supersedesAnnualAccountId: string | null;
    supersedeReason: string | null;
  }) => void;
}) {
  const [preparedOn, setPreparedOn] = useState(today());
  const [basis, setBasis] = useState<AccountingBasis>('commercieel');
  const [signatories, setSignatories] = useState<SignatoryDraft[]>([{ name: '', role: 'bestuurder', shareholderId: '' }]);
  const [offBalance, setOffBalance] = useState('');
  const [policyChange, setPolicyChange] = useState('');
  const [override, setOverride] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [note, setNote] = useState('');
  const [allDirectors, setAllDirectors] = useState(false);
  const [supersedes, setSupersedes] = useState(filed[0]?.id ?? '');
  const [supersedeReason, setSupersedeReason] = useState('');

  const hasDirector = signatories.some(s => s.role === 'bestuurder' && s.name.trim());
  const needsSupersede = filed.length > 0;
  const blocked = busy || !hasDirector
    || (Boolean(override) && !overrideReason.trim())
    || (needsSupersede && (!supersedes || !supersedeReason.trim()));

  const setRow = (index: number, patch: Partial<SignatoryDraft>) =>
    setSignatories(list => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  return (
    <div className="bk-modal-backdrop" onClick={onCancel}>
      <div className="bk-modal bk-modal-wide" onClick={e => e.stopPropagation()}>
        <h3>Jaarrekening opmaken — {year?.label ?? ''}</h3>
        <div className="bk-modal-body">
          <p className="bk-muted">
            Opmaken bevriest de cijfers. Vanaf dat moment komt alles uit die momentopname; het boekjaar heropenen of de
            resultaatbestemming terugdraaien kan dan pas nadat dit stuk is ingetrokken.
          </p>

          <div className="bk-grid2">
            <label className="bk-setting-field"><span>Opgemaakt op</span>
              <input type="date" className="form-input" value={preparedOn} onChange={e => setPreparedOn(e.target.value)} />
            </label>
            <label className="bk-setting-field"><span>Waarderingsgrondslagen</span>
              <Select value={basis} onChange={e => setBasis(e.target.value as AccountingBasis)}>
                <option value="commercieel">Commercieel</option>
                <option value="fiscaal">Fiscaal (alleen klein of micro)</option>
              </Select>
            </label>
          </div>
          {basis === 'fiscaal' && (
            <p className="settings-help">
              Waarderen op fiscale grondslagen mag alleen bij een kleine (art. 2:396 lid 6 BW) of micro-rechtspersoon
              (art. 2:395a lid 7 BW), en dan alles-of-niets: álle voor haar geldende fiscale grondslagen.
            </p>
          )}

          <p className="bk-muted"><strong>Ondertekenaars</strong> — alle bestuurders en alle commissarissen (art. 2:210 lid 2 BW).</p>
          {signatories.map((s, i) => (
            <div className="bk-fy-new-fields" key={i}>
              <label><span>Naam</span>
                <Input value={s.name} onChange={e => setRow(i, { name: e.target.value })} placeholder="Voor- en achternaam" />
              </label>
              <label><span>Rol</span>
                <Select value={s.role} onChange={e => setRow(i, { role: e.target.value as AnnualAccountSignatureRole })}>
                  <option value="bestuurder">Bestuurder</option>
                  <option value="commissaris">Commissaris</option>
                </Select>
              </label>
              <label><span>Aandeelhouder (optioneel)</span>
                <Select value={s.shareholderId} onChange={e => setRow(i, { shareholderId: e.target.value })}>
                  <option value="">Niet gekoppeld</option>
                  {shareholders.map(sh => <option key={sh.id} value={sh.id}>{sh.name}</option>)}
                </Select>
              </label>
              {signatories.length > 1 && (
                <button className="bk-line-del" title="Regel verwijderen" type="button"
                  onClick={() => setSignatories(list => list.filter((_, x) => x !== i))}>
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
          <div className="bk-fy-new-actions">
            <Button onClick={() => setSignatories(list => [...list, { name: '', role: 'bestuurder', shareholderId: '' }])}>
              <Plus size={14} /> Ondertekenaar
            </Button>
          </div>
          {!hasDirector && <p className="bk-neg">Geef minstens één bestuurder op.</p>}

          <label className="bk-setting-check">
            <input type="checkbox" checked={allDirectors} onChange={e => setAllDirectors(e.target.checked)} />
            <span>
              Alle aandeelhouders zijn tevens bestuurder van de vennootschap
              <small className="bk-muted"> Dit is een feitelijke bevestiging, geen besluit. Zij bepaalt of de betwiste
                streefdatum voor het deponeren in beeld komt — juist in de fase waarin die datum ertoe doet — en of
                vaststelling door ondertekening (art. 2:210 lid 5 BW) later mogelijk is.</small>
            </span>
          </label>

          <label className="bk-setting-field"><span>Niet in de balans opgenomen verplichtingen</span>
            <Textarea value={offBalance} onChange={e => setOffBalance(e.target.value)} rows={2}
              placeholder="Huur, lease, meerjarige contracten (art. 2:381 lid 1 BW)" />
          </label>
          <label className="bk-setting-field"><span>Stelselwijziging (optioneel)</span>
            <Textarea value={policyChange} onChange={e => setPolicyChange(e.target.value)} rows={2}
              placeholder="Reden en betekenis voor vermogen en resultaat (art. 2:384 lid 6 BW)" />
          </label>

          <div className="bk-grid2">
            <label className="bk-setting-field"><span>Grootteklasse handmatig</span>
              <Select value={override} onChange={e => setOverride(e.target.value)}>
                <option value="">
                  Berekend{size?.sizeClass ? `: ${SIZE_CLASS_LABELS[size.sizeClass]}` : ' (nog niet bepaald)'}
                </option>
                {SIZE_CLASSES.map(c => <option key={c} value={c}>{SIZE_CLASS_LABELS[c]}</option>)}
              </Select>
            </label>
            {override && (
              <label className="bk-setting-field"><span>Onderbouwing</span>
                <Input value={overrideReason} onChange={e => setOverrideReason(e.target.value)}
                  placeholder="Bijv. groepscijfers tellen mee (art. 2:406 BW)" />
              </label>
            )}
          </div>
          {size?.blockingReason && !override && (
            <p className="bk-neg">{size.blockingReason} Vul de groottegegevens aan, of leg hier de klasse handmatig vast met onderbouwing.</p>
          )}

          {needsSupersede && (
            <>
              <p className="bk-neg">
                Voor dit boekjaar ligt al een gedeponeerde jaarrekening. Die deponering blijft staan (art. 2:394 BW);
                dit stuk vervangt haar. Geef aan welke, en waarom.
              </p>
              <div className="bk-grid2">
                <label className="bk-setting-field"><span>Vervangt</span>
                  <Select value={supersedes} onChange={e => setSupersedes(e.target.value)}>
                    {filed.map(f => (
                      <option key={f.id} value={f.id}>
                        Gedeponeerd {f.filing_date ? dateNL(f.filing_date) : '—'}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="bk-setting-field"><span>Reden van de vervanging</span>
                  <Input value={supersedeReason} onChange={e => setSupersedeReason(e.target.value)}
                    placeholder="Bijv. vergeten voorziening alsnog verwerkt" />
                </label>
              </div>
            </>
          )}

          <label className="bk-setting-field"><span>Notitie (optioneel)</span>
            <Input value={note} onChange={e => setNote(e.target.value)} />
          </label>
          {error && <div className="error bk-modal-error">{error}</div>}
        </div>
        <div className="bk-modal-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Annuleren</Button>
          <Button variant="primary" disabled={blocked} onClick={() => onSubmit({
            preparedOn,
            accountingBasis: basis,
            signatories: signatories
              .filter(s => s.name.trim())
              .map(s => ({ name: s.name.trim(), role: s.role, shareholderId: s.shareholderId || null })),
            offBalanceCommitments: offBalance.trim() || null,
            policyChangeNote: policyChange.trim() || null,
            sizeClassOverride: (override || null) as SizeClass | null,
            sizeOverrideReason: overrideReason.trim() || null,
            note: note.trim() || null,
            allShareholdersAreDirectors: allDirectors,
            supersedesAnnualAccountId: needsSupersede ? supersedes : null,
            supersedeReason: needsSupersede ? supersedeReason.trim() : null,
          })}>
            {busy ? 'Bezig…' : 'Opmaken en bevriezen'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Vaststellen. Twee routes, en de tweede dechargeert automatisch: art. 2:210
 * lid 5 BW bepaalt dat ondertekening door alle bestuurders en commissarissen —
 * wanneer alle aandeelhouders bestuurder zijn — geldt als vaststelling én, in
 * afwijking van lid 3, tevens strekt tot kwijting. Wie hier op de knop drukt
 * dechargeert dus zijn medebestuurders; daarom staat het er letterlijk.
 */
function AdoptDialog({ account, busy, error, onCancel, onSubmit }: {
  account: AnnualAccount;
  busy: boolean;
  /** De weigering uit de database; MOET in de modal staan, want de overlay dekt de paginabrede foutbalk af. */
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: {
    adoptionDate: string;
    method: AnnualAccountAdoptionMethod;
    dischargeGranted: boolean;
    allShareholdersAreDirectors: boolean;
    otherMeetingRightsInformed: boolean;
    articlesAllow2105: boolean;
    auditorOpinionReceived: boolean | null;
    auditorName: string | null;
    auditorMissingGround: string | null;
  }) => void;
}) {
  /** Bij lid 5 is de vaststellingsdatum geen keuze: de laatste handtekening. */
  const lastSignature = useMemo(() => {
    const dates = account.signatures.map(s => s.signedOn).filter((d): d is string => Boolean(d));
    return dates.length ? dates.sort().slice(-1)[0] : null;
  }, [account.signatures]);

  const [method, setMethod] = useState<AnnualAccountAdoptionMethod>('ava');
  const [date, setDate] = useState(today());
  const [discharge, setDischarge] = useState(false);
  const [allDirectors, setAllDirectors] = useState(account.allShareholdersAreDirectors);
  const [meetingRights, setMeetingRights] = useState(account.otherMeetingRightsInformed);
  const [articles, setArticles] = useState(account.articlesAllow2105);
  const [opinionReceived, setOpinionReceived] = useState(account.auditorOpinionReceived);
  const [auditorName, setAuditorName] = useState(account.auditorName ?? '');
  const [missingGround, setMissingGround] = useState(account.auditorMissingGround ?? '');

  const unsigned = account.signatures.filter(s => !s.signed);
  const unsignedWithoutReason = unsigned.filter(s => !(s.missingReason ?? '').trim());

  useEffect(() => {
    if (method === 'signature_210_5' && lastSignature) setDate(lastSignature);
  }, [method, lastSignature]);

  const auditBlocked = account.auditRequired && !opinionReceived && !missingGround.trim();
  const blocked = busy
    || !date
    || unsignedWithoutReason.length > 0
    || auditBlocked
    || (method === 'signature_210_5' && (!allDirectors || !meetingRights || !articles || unsigned.length > 0 || !lastSignature));

  return (
    <div className="bk-modal-backdrop" onClick={onCancel}>
      <div className="bk-modal bk-modal-wide" onClick={e => e.stopPropagation()}>
        <h3>Jaarrekening vaststellen</h3>
        <div className="bk-modal-body">
          <label className="bk-setting-field"><span>Hoe is er vastgesteld?</span>
            <Select value={method} onChange={e => setMethod(e.target.value as AnnualAccountAdoptionMethod)}>
              <option value="ava">Besluit van de algemene vergadering (art. 2:210 lid 3 BW)</option>
              <option value="signature_210_5">Door ondertekening — alle aandeelhouders zijn bestuurder (art. 2:210 lid 5 BW)</option>
            </Select>
          </label>

          {method === 'signature_210_5' && (
            <div className="error">
              <strong>Let op: deze route verleent automatisch décharge.</strong>{' '}
              Art. 2:210 lid 5 BW bepaalt dat de ondertekening geldt als vaststelling en, in afwijking van lid 3, tevens
              strekt tot kwijting van de bestuurders en commissarissen voor het gevoerde beleid. Er komt geen apart
              dechargebesluit meer aan te pas; dat kan niet ongedaan worden gemaakt door hier iets anders aan te vinken.
              Wil je de kwijting los kunnen besluiten, kies dan een besluit van de algemene vergadering.
            </div>
          )}

          {method === 'signature_210_5' && (
            <>
              <p className="bk-muted"><strong>Bevestig de drie voorwaarden van art. 2:210 lid 5 BW</strong></p>
              <label className="bk-setting-check">
                <input type="checkbox" checked={allDirectors} onChange={e => setAllDirectors(e.target.checked)} />
                <span>Alle aandeelhouders zijn tevens bestuurder van de vennootschap.</span>
              </label>
              <label className="bk-setting-check">
                <input type="checkbox" checked={meetingRights} onChange={e => setMeetingRights(e.target.checked)} />
                <span>
                  De overige vergadergerechtigden zijn in de gelegenheid gesteld kennis te nemen van de opgemaakte
                  jaarrekening en hebben met deze wijze van vaststellen ingestemd (art. 2:238 lid 1 BW).
                </span>
              </label>
              <label className="bk-setting-check">
                <input type="checkbox" checked={articles} onChange={e => setArticles(e.target.checked)} />
                <span>De statuten sluiten deze wijze van vaststellen niet uit.</span>
              </label>
              {unsigned.length > 0 && (
                <p className="bk-neg">
                  Bij deze route moeten álle bestuurders en commissarissen hebben getekend; een ontbrekende handtekening
                  mét reden is niet genoeg. Nog niet getekend: {unsigned.map(s => s.personName).join(', ')}.
                </p>
              )}
              {lastSignature
                ? <p className="settings-help">
                    De vaststelling valt van rechtswege op de dag van de laatste handtekening: {dateNL(lastSignature)}.
                    Die dag wordt op het gedeponeerde stuk vermeld en bepaalt de acht dagen van art. 2:394 lid 1 BW.
                  </p>
                : <p className="bk-neg">Er is nog geen handtekeningdatum bekend; leg die eerst per ondertekenaar vast.</p>}
            </>
          )}

          <label className="bk-setting-field"><span>Datum van vaststelling</span>
            <input type="date" className="form-input" value={date}
              disabled={method === 'signature_210_5'}
              onChange={e => setDate(e.target.value)} />
          </label>

          {method === 'ava' && (
            <label className="bk-setting-check">
              <input type="checkbox" checked={discharge} onChange={e => setDischarge(e.target.checked)} />
              <span>
                De algemene vergadering heeft ook décharge verleend
                <small className="bk-muted"> Vaststelling strekt bij deze route NIET tot kwijting (art. 2:210 lid 3 BW);
                  dat is een apart besluit. Vink dit alleen aan als dat besluit werkelijk is genomen.</small>
              </span>
            </label>
          )}

          {unsignedWithoutReason.length > 0 && (
            <p className="bk-neg">
              Voor {unsignedWithoutReason.map(s => s.personName).join(', ')} ontbreekt de handtekening zonder opgave van
              reden. Art. 2:210 lid 2 BW eist dat daarvan melding wordt gemaakt onder opgave van reden; leg die reden vast
              bij de ondertekenaar, of laat alsnog tekenen.
            </p>
          )}

          {account.auditRequired && (
            <>
              <p className="bk-muted">
                <strong>Controleplicht (art. 2:393 lid 1 BW).</strong> De jaarrekening kan niet worden vastgesteld zolang
                het bevoegde orgaan geen kennis heeft kunnen nemen van de verklaring van de accountant (lid 7) — tenzij
                onder de overige gegevens een wettige grond wordt medegedeeld waarom die verklaring ontbreekt.
              </p>
              <label className="bk-setting-check">
                <input type="checkbox" checked={opinionReceived} onChange={e => setOpinionReceived(e.target.checked)} />
                <span>De accountantsverklaring is ontvangen en het bevoegde orgaan heeft er kennis van kunnen nemen.</span>
              </label>
              <label className="bk-setting-field"><span>Naam van de accountant</span>
                <Input value={auditorName} onChange={e => setAuditorName(e.target.value)} />
              </label>
              {!opinionReceived && (
                <label className="bk-setting-field"><span>Wettige grond waarom de verklaring ontbreekt</span>
                  <Textarea value={missingGround} onChange={e => setMissingGround(e.target.value)} rows={2} />
                </label>
              )}
            </>
          )}
          {error && <div className="error bk-modal-error">{error}</div>}
        </div>
        <div className="bk-modal-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Annuleren</Button>
          <Button variant="primary" disabled={blocked} onClick={() => onSubmit({
            adoptionDate: method === 'signature_210_5' ? (lastSignature ?? date) : date,
            method,
            dischargeGranted: method === 'signature_210_5' ? true : discharge,
            allShareholdersAreDirectors: allDirectors,
            otherMeetingRightsInformed: meetingRights,
            articlesAllow2105: articles,
            auditorOpinionReceived: account.auditRequired ? opinionReceived : null,
            auditorName: auditorName.trim() || null,
            auditorMissingGround: missingGround.trim() || null,
          })}>
            {busy ? 'Bezig…' : method === 'signature_210_5' ? 'Vaststellen én décharge verlenen' : 'Vaststellen'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Deponeren: ResoFly legt alleen vast dát en wannéér het is gebeurd. */
function FileDialog({ account, busy, error, onCancel, onSubmit }: {
  account: AnnualAccount;
  busy: boolean;
  /** De weigering uit de database; MOET in de modal staan, want de overlay dekt de paginabrede foutbalk af. */
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: {
    filingDate: string;
    filingReference: string | null;
    unadopted: boolean;
    note: string | null;
    auditorOpinionReceived: boolean | null;
    auditorName: string | null;
    auditorMissingGround: string | null;
  }) => void;
}) {
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [unadopted, setUnadopted] = useState(account.adoptionDate === null);
  const [note, setNote] = useState('');
  const [opinionReceived, setOpinionReceived] = useState(account.auditorOpinionReceived);
  const [auditorName, setAuditorName] = useState(account.auditorName ?? '');
  const [missingGround, setMissingGround] = useState(account.auditorMissingGround ?? '');

  const missingWithoutReason = account.signatures.filter(s => !s.signed && !(s.missingReason ?? '').trim());
  const auditBlocked = unadopted && account.auditRequired && !opinionReceived && !missingGround.trim();
  const blocked = busy || !date || missingWithoutReason.length > 0 || auditBlocked;

  return (
    <div className="bk-modal-backdrop" onClick={onCancel}>
      <div className="bk-modal bk-modal-wide" onClick={e => e.stopPropagation()}>
        <h3>Deponering vastleggen</h3>
        <div className="bk-modal-body">
          <p className="bk-muted">
            ResoFly deponeert niet zelf. Micro, kleine en middelgrote rechtspersonen moeten digitaal in SBR/XBRL
            deponeren en dat bestand levert ResoFly niet; de gegenereerde PDF is geen deponeerbestand. Hier leg je alleen
            vast dát en wannéér er is gedeponeerd, met de bevestiging van het handelsregister erbij.
          </p>

          <div className="bk-grid2">
            <label className="bk-setting-field"><span>Datum van deponering</span>
              <input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} />
            </label>
            <label className="bk-setting-field"><span>Referentie van het register</span>
              <Input value={reference} onChange={e => setReference(e.target.value)} placeholder="Bevestigingsnummer of kenmerk" />
            </label>
          </div>

          {account.adoptionDate === null ? (
            <>
              <label className="bk-setting-check">
                <input type="checkbox" checked={unadopted} onChange={e => setUnadopted(e.target.checked)} />
                <span>
                  Gedeponeerd terwijl de jaarrekening nog niet is vastgesteld (art. 2:394 lid 2 BW)
                  <small className="bk-muted"> Is er twee maanden na afloop van de opmaaktermijn nog niet vastgesteld,
                    dan wordt de opgemaakte jaarrekening onverwijld openbaar gemaakt met die vermelding. Dat is een begin,
                    geen einde: de vaststelling moet alsnog komen en daarna moet het vastgestelde stuk binnen acht dagen
                    opnieuw worden gedeponeerd.</small>
                </span>
              </label>
              {!unadopted && (
                <p className="bk-neg">
                  Deze jaarrekening is nog niet vastgesteld. Stel haar eerst vast, of leg de deponering vast als
                  onvastgesteld stuk op grond van art. 2:394 lid 2 BW.
                </p>
              )}
            </>
          ) : (
            <p className="settings-help">
              Vastgesteld op {dateNL(account.adoptionDate)} — openbaarmaking binnen acht dagen daarna (art. 2:394 lid 1 BW),
              met vermelding van die dag op het stuk.
            </p>
          )}

          {missingWithoutReason.length > 0 && (
            <p className="bk-neg">
              Voor {missingWithoutReason.map(s => s.personName).join(', ')} ontbreekt de handtekening zonder opgave van
              reden (art. 2:210 lid 2 BW). Leg die reden vast voordat het stuk openbaar wordt gemaakt.
            </p>
          )}

          {unadopted && account.auditRequired && (
            <>
              <p className="bk-muted">
                <strong>Controleplicht.</strong> Een controleplichtig stuk gaat niet naar buiten zonder accountantsverklaring
                of zonder de wettige grond waarom zij ontbreekt — die verklaring wordt immers mee openbaar gemaakt
                (art. 2:392 lid 1 jo. 2:393 lid 7 BW).
              </p>
              <label className="bk-setting-check">
                <input type="checkbox" checked={opinionReceived} onChange={e => setOpinionReceived(e.target.checked)} />
                <span>De accountantsverklaring is ontvangen.</span>
              </label>
              <label className="bk-setting-field"><span>Naam van de accountant</span>
                <Input value={auditorName} onChange={e => setAuditorName(e.target.value)} />
              </label>
              {!opinionReceived && (
                <label className="bk-setting-field"><span>Wettige grond waarom de verklaring ontbreekt</span>
                  <Textarea value={missingGround} onChange={e => setMissingGround(e.target.value)} rows={2} />
                </label>
              )}
            </>
          )}

          <label className="bk-setting-field"><span>Aantekening bij deze deponering</span>
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Bijv. het kanaal, of dat dit de herdeponering ná de vaststelling is" />
          </label>
          {error && <div className="error bk-modal-error">{error}</div>}
        </div>
        <div className="bk-modal-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Annuleren</Button>
          <Button variant="primary" disabled={blocked} onClick={() => onSubmit({
            filingDate: date,
            filingReference: reference.trim() || null,
            unadopted,
            note: note.trim() || null,
            auditorOpinionReceived: account.auditRequired ? opinionReceived : null,
            auditorName: auditorName.trim() || null,
            auditorMissingGround: missingGround.trim() || null,
          })}>
            {busy ? 'Bezig…' : 'Deponering vastleggen'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Verlenging van de opmaaktermijn: geen schuifje maar een besluit. */
function ExtendDialog({ account, busy, error, onCancel, onSubmit }: {
  account: AnnualAccount;
  busy: boolean;
  /** De weigering uit de database; MOET in de modal staan, want de overlay dekt de paginabrede foutbalk af. */
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: { months: number; reason: string; decidedOn: string }) => void;
}) {
  const [months, setMonths] = useState('5');
  const [reason, setReason] = useState('');
  const [decidedOn, setDecidedOn] = useState(today());
  const blocked = busy || !reason.trim() || !decidedOn || !Number(months);

  return (
    <div className="bk-modal-backdrop" onClick={onCancel}>
      <div className="bk-modal" onClick={e => e.stopPropagation()}>
        <h3>Opmaaktermijn verlengen</h3>
        <div className="bk-modal-body">
          <p className="bk-muted">
            De algemene vergadering kan de opmaaktermijn met ten hoogste vijf maanden verlengen, en alleen op grond van
            bijzondere omstandigheden (art. 2:210 lid 1 BW). De wettelijke termijn zelf blijft staan
            ({dateNL(account.prepareDeadline)}); de verlenging komt daar apart bij en schuift ook de tweemaandsgrens van
            art. 2:394 lid 2 BW op. Een besluit dat ná afloop van de wettelijke termijn is genomen, wordt geweigerd.
          </p>
          <div className="bk-grid2">
            <label className="bk-setting-field"><span>Aantal maanden</span>
              <Select value={months} onChange={e => setMonths(e.target.value)}>
                {[1, 2, 3, 4, 5].map(m => <option key={m} value={String(m)}>{m}</option>)}
              </Select>
            </label>
            <label className="bk-setting-field"><span>Besluit genomen op</span>
              <input type="date" className="form-input" value={decidedOn} onChange={e => setDecidedOn(e.target.value)} />
            </label>
          </div>
          <label className="bk-setting-field"><span>Bijzondere omstandigheden</span>
            <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
              placeholder="Waarom kon het bestuur de jaarrekening niet binnen de wettelijke termijn opmaken?" />
          </label>
          {error && <div className="error bk-modal-error">{error}</div>}
        </div>
        <div className="bk-modal-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Annuleren</Button>
          <Button variant="primary" disabled={blocked}
            onClick={() => onSubmit({ months: Number(months), reason: reason.trim(), decidedOn })}>
            {busy ? 'Bezig…' : 'Verlenging vastleggen'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Intrekken: alleen zolang het stuk niet is gedeponeerd. */
function ReverseDialog({ account, busy, error, onCancel, onSubmit }: {
  account: AnnualAccount;
  busy: boolean;
  /** De weigering uit de database; MOET in de modal staan, want de overlay dekt de paginabrede foutbalk af. */
  error: string | null;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <div className="bk-modal-backdrop" onClick={onCancel}>
      <div className="bk-modal" onClick={e => e.stopPropagation()}>
        <h3>Jaarrekening intrekken</h3>
        <div className="bk-modal-body">
          <p className="bk-muted">
            De jaarrekening van {account.fiscalYearLabel} ({STATUS_LABELS[account.status] ?? account.status}) blijft als
            spoor staan en blokkeert daarna niets meer. Pas ná het intrekken kunnen het boekjaar worden heropend en de
            resultaatbestemming worden teruggedraaid. Een gedeponeerd stuk kan niet worden ingetrokken — dat wordt
            hersteld met een opvolgend stuk (art. 2:394 BW).
          </p>
          <label className="bk-setting-field"><span>Reden van intrekking</span>
            <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} />
          </label>
          {error && <div className="error bk-modal-error">{error}</div>}
        </div>
        <div className="bk-modal-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Annuleren</Button>
          <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => onSubmit(reason.trim())}>
            {busy ? 'Bezig…' : 'Intrekken'}
          </Button>
        </div>
      </div>
    </div>
  );
}
