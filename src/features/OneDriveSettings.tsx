/**
 * Instellingen → OneDrive: de kopie van Inhoud in de OneDrive van de eigenaar.
 * Plan en keuzes: docs/plannen/ONEDRIVE_KOPIE_PLAN_2026-11-24.md.
 *
 * Alleen de eigenaar ziet dit onderdeel (settingsTabRoleRule), en de edge
 * function onedrive-sync weigert het ook voor anderen. Het scherm haalt de
 * stand op bij het openen; loopt er werk, dan zwengelt het de wachtrij aan en
 * kijkt het om de paar seconden opnieuw, zodat de eigenaar ziet dat het gaat.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Cloud, ExternalLink, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '../components/Ui';
import { oneDriveStage, syncSummary, type OneDriveStatus } from '../lib/onedrive';
import {
  disableOneDrive, disconnectOneDrive, enableOneDrive, getOneDriveAuthUrl, loadOneDriveStatus,
  processOneDrive, resyncOneDrive, retryOneDrive, safeOneDriveUrl,
} from '../lib/onedrive-api';

/** Zo vaak kijkt het scherm achter elkaar opnieuw terwijl er werk is (ongeveer drie minuten). */
const MAX_WATCH_ROUNDS = 60;

export function OneDriveSettings({ organizationId }: { organizationId: string }) {
  const [status, setStatus] = useState<OneDriveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rounds = useRef(0);

  const reload = useCallback(async () => {
    try {
      setStatus(await loadOneDriveStatus(organizationId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'De stand van OneDrive laden lukte niet.');
    }
  }, [organizationId]);

  useEffect(() => { void reload(); }, [reload]);

  // Na het koppelen rondt main.tsx af en zegt het met dit event.
  useEffect(() => {
    const onChanged = () => { rounds.current = 0; void reload(); };
    window.addEventListener('resofly:onedrive-changed', onChanged);
    return () => window.removeEventListener('resofly:onedrive-changed', onChanged);
  }, [reload]);

  const stage = status ? oneDriveStage(status) : null;
  const pending = status?.queue.pending ?? 0;

  // Werk dat wacht: nu afwerken en de stand verversen, tot het klaar is. Niet
  // eindeloos: een taak die op een latere poging wacht (Microsoft vroeg om
  // te wachten), houdt "wacht" anders de hele tijd vast.
  useEffect(() => {
    if (stage !== 'aan' || pending === 0 || rounds.current >= MAX_WATCH_ROUNDS) return;
    let alive = true;
    const timer = window.setTimeout(async () => {
      rounds.current += 1;
      try { await processOneDrive(organizationId); } catch { /* de stand zegt wat er mis is */ }
      if (alive) await reload();
    }, 3000);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [stage, pending, status, organizationId, reload]);

  async function act(name: string, fn: () => Promise<OneDriveStatus | void>, done?: string) {
    setBusy(name); setError(null); setNotice(null);
    try {
      const next = await fn();
      if (next) setStatus(next);
      else await reload();
      rounds.current = 0;
      if (done) setNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dat lukte niet.');
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    setBusy('connect'); setError(null);
    try {
      window.location.assign(await getOneDriveAuthUrl(organizationId, window.location.href));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koppelen lukte niet.');
      setBusy(null);
    }
  }

  const connection = status?.connection ?? null;
  const rootUrl = safeOneDriveUrl(connection?.rootWebUrl);
  const summary = status && stage === 'aan' ? syncSummary(status) : null;

  const explanation = <div className="data-export-columns">
    <div>
      <h4>Wat er in OneDrive komt</h4>
      <ul className="data-export-list">
        <li>De bestanden in de mappen van Inhoud en het klantdossier.</li>
        <li>Word-, Excel- en PowerPoint-documenten uit Inhoud.</li>
        <li>In dezelfde mappen als hier: klant, project, map.</li>
      </ul>
    </div>
    <div>
      <h4>Wat er niet in komt</h4>
      <ul className="data-export-list">
        <li>Notities en tekstdocumenten.</li>
        <li>Facturen, offertes, contracten en inkoopfacturen: die bewaart ResoFly zelf, vanwege de bewaarplicht.</li>
        <li>De galerij en verstuurde bestanden.</li>
      </ul>
    </div>
  </div>;

  const rules = <ul className="data-export-list onedrive-rules">
    <li><strong>ResoFly is leidend.</strong> Uploaden, hernoemen, verplaatsen, bewerken en verwijderen in ResoFly gebeurt ook in OneDrive. Wat je in OneDrive zelf verandert, neemt ResoFly niet over; bij de volgende wijziging hier wordt het overschreven (OneDrive bewaart de vorige versie).</li>
    <li><strong>Verwijderen</strong> in ResoFly zet het bestand in OneDrive in de prullenbak. Daar kun je het nog terugzetten.</li>
    <li><strong>ResoFly bewaart je bestanden zelf ook.</strong> De kopie in OneDrive komt erbij; er verandert niets aan hoe je in ResoFly werkt.</li>
  </ul>;

  const warning = <p className="onedrive-warning" role="note">
    <AlertTriangle size={15} aria-hidden="true" />
    <span>Iedereen die bij deze map in OneDrive kan, ziet alle bestanden van je klanten, ook wie in ResoFly geen toegang heeft tot Inhoud. Deel de map in OneDrive dus alleen met wie dat mag.</span>
  </p>;

  const account = connection && <div className="onedrive-account">
    <Cloud size={16} aria-hidden="true" />
    <span>
      Gekoppeld met OneDrive{connection.account ? <> als <strong>{connection.account}</strong></> : null}
      {connection.rootName ? <> · map <strong>{connection.rootName}</strong></> : null}
    </span>
  </div>;

  return <section className="settings-card onedrive-card">
    <div className="settings-card-head">
      <div>
        <h3>Kopie in OneDrive</h3>
        <p className="settings-help">Houd een kopie van je bestanden bij in je eigen OneDrive. Handig om ze ook buiten ResoFly bij de hand te hebben, of als extra back-up.</p>
      </div>
    </div>

    {error && <div className="error">{error}</div>}
    {notice && <div className="success">{notice}</div>}

    {!status && !error && <p className="settings-help"><Loader2 size={14} className="spin" /> Laden…</p>}

    {stage === 'niet-ingericht' && <p className="settings-help">OneDrive is op deze omgeving nog niet ingericht. De beheerder van ResoFly zet dat aan (zie <em>docs/setup/ONEDRIVE_SETUP.md</em>).</p>}

    {stage === 'niet-gekoppeld' && <>
      {explanation}
      {rules}
      {warning}
      <div className="onedrive-actions">
        <Button variant="primary" disabled={busy !== null} onClick={() => void connect()}>
          {busy === 'connect' ? <Loader2 size={15} className="spin" /> : <Cloud size={15} />} OneDrive koppelen
        </Button>
      </div>
      <p className="settings-help">Je logt in bij Microsoft en geeft ResoFly toegang tot je OneDrive. Daarna zet je hier de kopie aan.</p>
    </>}

    {stage === 'opnieuw-koppelen' && connection && <>
      {account}
      <div className="onedrive-status is-warn" role="status">
        <AlertTriangle size={15} aria-hidden="true" />
        <span>{connection.lastError || 'De koppeling met OneDrive werkt niet meer.'} Wat er intussen in ResoFly verandert, wacht tot je opnieuw koppelt.</span>
      </div>
      <div className="onedrive-actions">
        <Button variant="primary" disabled={busy !== null} onClick={() => void connect()}>
          {busy === 'connect' ? <Loader2 size={15} className="spin" /> : <Cloud size={15} />} Opnieuw koppelen
        </Button>
        <Button disabled={busy !== null} onClick={() => {
          if (!window.confirm('OneDrive ontkoppelen? De map in OneDrive blijft staan, maar ResoFly houdt hem niet meer bij. Koppel je later opnieuw, dan maakt ResoFly een nieuwe map.')) return;
          void act('disconnect', () => disconnectOneDrive(organizationId), 'OneDrive is ontkoppeld. De map in OneDrive staat er nog.');
        }}>Ontkoppelen</Button>
      </div>
    </>}

    {stage === 'uit' && connection && <>
      {account}
      {explanation}
      {rules}
      {warning}
      <div className="onedrive-actions">
        <Button variant="primary" disabled={busy !== null} onClick={() => void act('enable', () => enableOneDrive(organizationId), 'De kopie staat aan. Vanaf nu komt elke wijziging in Inhoud ook in OneDrive.')}>
          {busy === 'enable' ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />} Kopie aanzetten
        </Button>
        <Button disabled={busy !== null} onClick={() => {
          if (!window.confirm('OneDrive ontkoppelen? Wat er al in OneDrive staat, blijft staan.')) return;
          void act('disconnect', () => disconnectOneDrive(organizationId), 'OneDrive is ontkoppeld.');
        }}>Ontkoppelen</Button>
      </div>
      <p className="settings-help">Na het aanzetten komt alles wat er verandert in OneDrive. Wat er al staat, zet je erin met <em>Alles opnieuw kopiëren</em>.</p>
    </>}

    {stage === 'aan' && connection && status && <>
      {account}
      {summary && <div className={`onedrive-status is-${summary.tone}`} role="status" aria-live="polite">
        {summary.tone === 'ok' ? <CheckCircle2 size={15} aria-hidden="true" /> : summary.tone === 'busy' ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
        <span>{summary.text}</span>
      </div>}

      {status.queue.failedItems.length > 0 && <div className="onedrive-failed">
        <h4>Niet in OneDrive gekomen</h4>
        <ul>
          {status.queue.failedItems.map(item => <li key={item.id}>
            <strong>{item.name}</strong>
            <span>{item.kind === 'delete' ? 'Verwijderen' : 'Bijwerken'} lukte niet{item.lastError ? `: ${item.lastError}` : '.'}</span>
          </li>)}
        </ul>
        <Button disabled={busy !== null} onClick={() => void act('retry', () => retryOneDrive(organizationId), 'ResoFly probeert het opnieuw.')}>
          {busy === 'retry' ? <Loader2 size={15} className="spin" /> : <RotateCcw size={15} />} Opnieuw proberen
        </Button>
      </div>}

      <div className="onedrive-actions">
        {rootUrl && <a className="btn btn-ghost" href={rootUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /> Openen in OneDrive</a>}
        <Button disabled={busy !== null} onClick={() => {
          if (!window.confirm('Alles opnieuw kopiëren? ResoFly kijkt van elk bestand of het in OneDrive klopt, en zet terug wat er ontbreekt of daar is veranderd. Met veel bestanden duurt dat even.')) return;
          void act('resync', async () => {
            const res = await resyncOneDrive(organizationId);
            setNotice(res.queued ? `${res.queued === 1 ? 'Eén bestand gaat' : `${res.queued} bestanden gaan`} opnieuw langs OneDrive.` : 'Er zijn nog geen bestanden om te kopiëren.');
            return res;
          });
        }}>
          {busy === 'resync' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Alles opnieuw kopiëren
        </Button>
        <Button disabled={busy !== null} onClick={() => {
          if (!window.confirm('De kopie uitzetten? Wat er nu in OneDrive staat, blijft staan. Wat je daarna in ResoFly verandert, komt er niet meer in.')) return;
          void act('disable', () => disableOneDrive(organizationId), 'De kopie staat uit. Wat er in OneDrive staat, blijft staan.');
        }}>Kopie uitzetten</Button>
        <Button disabled={busy !== null} onClick={() => {
          if (!window.confirm('OneDrive ontkoppelen? De kopie stopt, en de map in OneDrive blijft staan. Koppel je later opnieuw, dan maakt ResoFly een nieuwe map.')) return;
          void act('disconnect', () => disconnectOneDrive(organizationId), 'OneDrive is ontkoppeld. De map in OneDrive staat er nog.');
        }}>Ontkoppelen</Button>
      </div>
      {warning}
    </>}
  </section>;
}
