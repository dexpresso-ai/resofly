import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import * as PdfLib from 'https://esm.sh/pdf-lib@1.17.1';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  HttpError, assertModuleAccess, createAdminClient, createUserClient, isUuid,
  makeCors, parseAllowedOrigins, requireOrganizationAccess, requireUser,
} from '../_shared/edgeAuth.ts';
import { documentAssetsFromSettings, PAGE_HEIGHT, parseDocumentLayouts, resolveDocumentLayout } from '../_shared/documentLayout.ts';
import { buildPageDocx, DOCX_MIME, type PageDocxChapter, type PageDocxFont, type PageDocxImage, type PageDocxLetterhead } from '../_shared/pageDocx.ts';
import {
  collectSubpages, EXPORT_SUBPAGE_LIMIT, exportBrand, exportContext, exportCover, exportLogo, exportMentionNames, exportOptions, exportReferences,
  letterheadMargins,
} from '../_shared/pageExport.ts';
import { pageExportFonts, type PageExportFont } from '../_shared/pageExportFonts.ts';
import { PDF_FONT_FILES } from '../_shared/pdfFonts.ts';
import { LetterheadUnusable, loadLetterhead, underlayLetterhead, type UnderlayDocument } from '../_shared/pdfLetterhead.ts';
import { sfntFamilyName, woffToSfnt } from '../_shared/woff.ts';

// ============================================================
// ResoFly — De PDF van een pagina (page-export, stap 1B-5)
//
// §9 van het bouwplan: "Eén route: pagina → DOCX → PDF via Collabora." Deze
// functie bouwt de DOCX met dezelfde module als de Word-download in de app
// (_shared/pageDocx.ts, samengesteld in _shared/pageExport.ts), en laat de
// media-worker er via Collabora een PDF van maken. Zo zien Word en PDF er
// hetzelfde uit.
//
// Wat je mag lezen, bepaalt de database: alles hier wordt gelezen met de
// sessie van wie exporteert (createUserClient, RLS). Een subpagina die je niet
// mag zien, of die in de prullenbak ligt, komt er dus niet in. De organisatie
// komt uit de rij van de pagina die je mocht lezen, nooit uit de invoer
// (CLAUDE.md, regel 1). Alleen de bytes van een afbeelding komen langs de
// interne weg (het interne geheim), en alleen voor bijlagen die je mocht lezen.
//
// De DOCX gaat in het verzoek naar de worker mee; er komt niets in R2 (zie
// handleInternalPageConvertPdf in workers/media-api). De worker rol je met de
// hand uit (wrangler). Ontbreekt het pad daar nog, dan zegt deze functie dat
// met een eigen code (pdf_niet_beschikbaar), zodat de app het kan uitleggen.
//
// Een briefpapier dat een PDF is, kan niet in de DOCX. Dat komt na het
// omzetten onder de PDF, met pdf-lib zoals bij facturen
// (_shared/pdfLetterhead.ts); de DOCX houdt er alleen de ruimte voor vrij.
// Met zo'n briefpapier verschillen Word en PDF dus: Word heeft het niet.
// ============================================================

const admin = createAdminClient();

const MEDIA_WORKER_URL = (Deno.env.get('MEDIA_WORKER_URL') || '').replace(/\/$/, '');
const MEDIA_INTERNAL_SECRET = Deno.env.get('INTERNAL_UPLOAD_SECRET') || Deno.env.get('R2_INTERNAL_SECRET') || '';

// De origin van de app staat per omgeving in APP_PUBLIC_URL óf in
// GERRIE_ALLOWED_ORIGINS (docs/setup/SUPABASE_STAGING_LAPTOP.md), dus beide,
// net als gerrie-agent. Eerst las deze functie alleen de eerste: stond de app
// alleen in de tweede, dan weigerde ze elke PDF met 403, en dat zag de
// rooktest niet (die stuurt origin "null"). Gevonden vóór de merge.
const cors = makeCors(
  parseAllowedOrigins([
    Deno.env.get('PAGE_EXPORT_ALLOWED_ORIGINS'),
    Deno.env.get('APP_ALLOWED_ORIGINS'),
    Deno.env.get('APP_PUBLIC_URL'),
    Deno.env.get('GERRIE_ALLOWED_ORIGINS'),
    Deno.env.get('MAIL_ALLOWED_ORIGINS'),
  ]),
  // localhost en verzoeken zonder Origin alleen als je dat lokaal aanzet (ALLOW_LOCAL_DEV=1).
  (Deno.env.get('ALLOW_LOCAL_DEV') ?? '0') === '1',
);

/** De PDF kan hier (nog) niet: de worker kent het pad niet, of het is niet ingericht. */
class PdfUnavailable extends Error {}

type PageRow = { id: string; organization_id: string; title: string; body: unknown; client_id: string | null; project_id: string | null };
type TreeRow = { id: string; title: string; parent_id: string | null; position: number | null };

type Settings = {
  company_name: string | null;
  brand_logo_data_url: string | null;
  brand_accent_color: string | null;
  brand_footer_text: string | null;
  brand_heading_font: string | null;
  brand_body_font: string | null;
  invoice_template_kind: string | null;
  invoice_template_data_url: string | null;
  invoice_template_mime_type: string | null;
  document_layouts: unknown;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });

  try {
    cors.assert(req);
    if (req.method !== 'POST') throw new HttpError('Alleen POST.', 400);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('Een verzoek zonder inhoud.', 400);
    const pageId = String(body.pageId || '');
    if (!isUuid(pageId)) throw new HttpError('pageId is verplicht.', 400);

    const user = await requireUser(admin, req);
    const db = createUserClient(req);
    const page = await loadPage(db, pageId);
    // De organisatie van de pagina die je mocht lezen; daarna nog eens het
    // lidmaatschap en de module, voor een duidelijke melding.
    await requireOrganizationAccess(admin, user.id, page.organization_id);
    await assertModuleAccess(admin, user.id, page.organization_id, 'content', 'read');

    const pdf = await pagePdf(db, page, {
      cover: body.cover === true,
      toc: body.toc === true,
      chapters: body.chapters === true,
      letterhead: body.letterhead === true,
      // Namen (bij @-vermeldingen, en de klant en het project op het
      // voorblad) alleen als de app erom vraagt: bij een download. Een PDF die
      // in het dossier komt, kan iedereen met Inhoud openen, ook wie de klant
      // of de factuur niet mag zien (regel 3, stap 2-1a). Eerst kwam de klant
      // ook op het voorblad van een vastgelegde PDF.
      names: body.names === true,
    });
    return new Response(pdf, {
      status: 200,
      headers: { ...cors.headers(req), 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    if (err instanceof PdfUnavailable) return cors.json(req, { ok: false, error: err.message, code: 'pdf_niet_beschikbaar' }, 501);
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Onbekende fout';
    if (status >= 500) console.error('page-export error', message, err instanceof Error ? err.stack : undefined);
    return cors.json(req, { ok: false, error: status >= 500 ? 'De PDF kon niet worden gemaakt. Probeer het zo nog eens.' : message }, status);
  }
});

async function loadPage(db: SupabaseClient, pageId: string): Promise<PageRow> {
  const { data, error } = await db.from('documents')
    .select('id,organization_id,title,body,client_id,project_id')
    .eq('id', pageId).eq('format', 'page').maybeSingle();
  if (error) throw new HttpError(`De pagina kon niet worden gelezen: ${error.message}`, 500);
  if (!data) throw new HttpError('Deze pagina bestaat niet (meer), of je mag haar niet lezen.', 404);
  return data as PageRow;
}

/** Een rij per id, in stukken: een lange in-lijst past niet in één adres. */
async function rowsById<T>(db: SupabaseClient, table: string, columns: string, organizationId: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from(table).select(columns).eq('organization_id', organizationId).in('id', ids.slice(i, i + 100));
    if (error) throw new HttpError(`${table} kon niet worden gelezen: ${error.message}`, 500);
    out.push(...(data as T[]));
  }
  return out;
}

/**
 * De subpagina's als hoofdstukken (stap 1B-4a), zoals de app ze vindt
 * (collectSubpages). Laadt er een niet, dan geen PDF: een bestand waar stil
 * een hoofdstuk uit ontbreekt, valt pas op als het bij de klant ligt.
 */
async function loadChapters(db: SupabaseClient, page: PageRow): Promise<PageDocxChapter[]> {
  const found = await collectSubpages<TreeRow>(page.id, async (parents) => {
    const rows: TreeRow[] = [];
    for (let i = 0; i < parents.length; i += 100) {
      const { data, error } = await db.from('documents').select('id,title,parent_id,position')
        .eq('organization_id', page.organization_id).eq('format', 'page')
        .in('parent_id', parents.slice(i, i + 100)).limit(EXPORT_SUBPAGE_LIMIT + 1);
      if (error) throw new HttpError(`De subpagina's konden niet worden gelezen: ${error.message}`, 500);
      rows.push(...(data as TreeRow[]));
    }
    return rows;
  });
  if (found.tooMany) {
    throw new HttpError(`Er staan meer dan ${EXPORT_SUBPAGE_LIMIT} subpagina's onder deze pagina. Zoveel hoofdstukken passen niet in één bestand.`, 422);
  }
  const ids = found.subpages.map(entry => entry.page.id);
  const bodies = new Map((await rowsById<{ id: string; title: string; body: unknown }>(db, 'documents', 'id,title,body', page.organization_id, ids))
    .map(row => [row.id, row]));
  return found.subpages.map(({ page: sub, depth }) => {
    const row = bodies.get(sub.id);
    if (!row) throw new HttpError(`De subpagina "${sub.title.trim() || 'Naamloze pagina'}" kon niet worden geladen, dus er is geen PDF gemaakt. Probeer het zo nog eens.`, 409);
    return { title: row.title, body: row.body, depth };
  });
}

/** Eén letter van de huisstijl, als TTF, uit de letters die de edge functions al hebben (pdfFonts.ts). */
async function loadFont(font: PageExportFont): Promise<PageDocxFont> {
  const load = async (name: string | null) => {
    const base64 = name ? PDF_FONT_FILES[name] : undefined;
    if (!base64) return undefined;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return await woffToSfnt(bytes);
    } catch {
      return undefined;
    }
  };
  const [regular, bold] = await Promise.all([load(font.regular), load(font.bold)]);
  // De naam zoals de letter zichzelf noemt: daaronder zoekt Word (en LibreOffice) hem.
  const family = (regular && sfntFamilyName(regular)) || (bold && sfntFamilyName(bold)) || font.family;
  return { family, regular, bold };
}

/** De bytes van een afbeelding die je mocht lezen, langs de interne weg; null als dat niet lukt ("[Afbeelding]"). */
async function imageBytes(organizationId: string, storageKey: string, contentType: string): Promise<PageDocxImage | null> {
  if (!MEDIA_WORKER_URL || !MEDIA_INTERNAL_SECRET) return null;
  try {
    const res = await fetch(`${MEDIA_WORKER_URL}/internal/media/${encodeURIComponent(storageKey)}`, {
      headers: { Authorization: `Bearer ${MEDIA_INTERNAL_SECRET}`, 'x-organization-id': organizationId },
    });
    if (!res.ok) return null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
  } catch {
    return null;
  }
}

/**
 * Het briefpapier (stap 1B-4b), zoals de app het doet: gevraagd maar niet te
 * gebruiken, dan geen PDF. Nooit stil zonder briefpapier.
 *
 * Een afbeelding gaat in de DOCX. Een PDF niet (stap 1B-5): de DOCX houdt
 * alleen de ruimte vrij, en `pdf` komt na het omzetten onder de PDF. Het is
 * hier al geladen en op proef ingesloten: een kapot briefpapier geeft zo
 * meteen een melding, en niet pas na een minuut omzetten.
 */
async function letterheadOf(settings: Settings | null): Promise<{ docx: PageDocxLetterhead; pdf: UnderlayDocument | null }> {
  const kind = settings?.invoice_template_kind;
  if (!settings || !kind || kind === 'none') throw new HttpError('Er is geen briefpapier ingesteld. Dat doe je bij Instellingen → Documentopmaak.', 422);
  const paper = documentAssetsFromSettings(settings).letterhead;
  if (!paper) throw new HttpError('Het briefpapier is leeg of niet te lezen. Kies het opnieuw bij Instellingen → Documentopmaak.', 422);
  const layout = resolveDocumentLayout(parseDocumentLayouts(settings.document_layouts), 'invoice', { letterhead: true });
  const margins = letterheadMargins(layout, PAGE_HEIGHT);
  if (paper.kind === 'pdf') {
    try {
      return { docx: { image: null, ...margins }, pdf: await loadLetterhead(PdfLib, paper.bytes) };
    } catch (error) {
      if (error instanceof LetterheadUnusable) throw new HttpError(error.message, 422);
      throw error;
    }
  }
  return {
    docx: { image: { bytes: paper.bytes, contentType: paper.type === 'png' ? 'image/png' : 'image/jpeg' }, ...margins },
    pdf: null,
  };
}

async function pagePdf(
  db: SupabaseClient,
  page: PageRow,
  choice: { cover: boolean; toc: boolean; chapters: boolean; letterhead: boolean; names: boolean },
): Promise<ArrayBuffer> {
  const org = page.organization_id;
  const chapters = choice.chapters ? await loadChapters(db, page) : [];
  const refs = exportReferences([page.body, ...chapters.map(chapter => chapter.body)]);
  const { data: settingsRow, error: settingsError } = await db.from('company_settings')
    .select('company_name,brand_logo_data_url,brand_accent_color,brand_footer_text,brand_heading_font,brand_body_font,invoice_template_kind,invoice_template_data_url,invoice_template_mime_type,document_layouts')
    .eq('organization_id', org).maybeSingle();
  if (settingsError) throw new HttpError(`De bedrijfsinstellingen konden niet worden gelezen: ${settingsError.message}`, 500);
  const settings = settingsRow as Settings | null;
  // Eerst het briefpapier: een fout daar hoort vóór al het andere werk.
  const letterhead = choice.letterhead ? await letterheadOf(settings) : null;

  const [titleRows, fileRows, imageRows, mentionNames] = await Promise.all([
    rowsById<{ id: string; title: string }>(db, 'documents', 'id,title', org, refs.pages),
    rowsById<{ id: string; name: string }>(db, 'attachments', 'id,name', org, refs.files),
    rowsById<{ id: string; storage_key: string; mime_type: string }>(db, 'attachments', 'id,storage_key,mime_type', org, refs.images),
    // De namen bij @-vermeldingen (stap 2-1a), met de rechten van wie
    // exporteert: wat de database niet geeft, wordt de soort.
    choice.names ? exportMentionNames(refs.mentions, (source, ids) => mentionRows(db, org, source, ids)) : [],
  ]);
  const titleOf = new Map(titleRows.map(row => [row.id, row.title]));
  const nameOf = new Map(fileRows.map(row => [row.id, row.name]));
  const imageOf = new Map(imageRows.map(row => [row.id, row]));
  const fonts = pageExportFonts(settings);
  const logo = exportLogo(settings?.brand_logo_data_url);
  const [images, body, heading, names] = await Promise.all([
    Promise.all(refs.images.map(async (id): Promise<[string, PageDocxImage | null]> => {
      const row = imageOf.get(id);
      return [id, row ? await imageBytes(org, row.storage_key, row.mime_type) : null];
    })),
    loadFont(fonts.body),
    fonts.heading.key === fonts.body.key ? null : loadFont(fonts.heading),
    choice.cover ? (choice.names ? dossierNames(db, page) : { client: null, project: null }) : null,
  ]);
  const context = exportContext({
    titles: refs.pages.map((id): [string, string | null] => [id, titleOf.get(id) ?? null]),
    fileNames: refs.files.map((id): [string, string | null] => [id, nameOf.get(id) ?? null]),
    images,
    font: body,
    headingFont: heading,
    brand: exportBrand(settings, logo),
    mentionNames,
  });
  const cover = names
    ? exportCover({
      clientName: names.client,
      projectName: names.project,
      date: new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' }),
      company: settings?.company_name ?? null,
      logo,
    })
    : null;
  // Als ArrayBuffer: dat is in elke versie van de typen een geldige body.
  const docx = await (await buildPageDocx(page.title, page.body, context, exportOptions({ cover, toc: choice.toc, chapters, letterhead: letterhead?.docx ?? null }))).arrayBuffer();
  const pdf = await convertToPdf(org, docx);
  if (!letterhead?.pdf) return pdf;
  const withPaper = await underlayLetterhead(PdfLib, new Uint8Array(pdf), letterhead.pdf);
  // Een eigen ArrayBuffer van precies deze bytes (zie hierboven).
  return withPaper.buffer.slice(withPaper.byteOffset, withPaper.byteOffset + withPaper.byteLength) as ArrayBuffer;
}

/**
 * De rijen achter de vermeldingen van één soort. Lukt het lezen niet, dan
 * staat de soort er: een naam is geen reden om de hele PDF te laten mislukken.
 */
async function mentionRows(
  db: SupabaseClient,
  organizationId: string,
  source: { table: string; idColumn: string; nameColumn: string },
  ids: string[],
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from(source.table).select(`${source.idColumn},${source.nameColumn}`)
      .eq('organization_id', organizationId).in(source.idColumn, ids.slice(i, i + 100));
    if (error) {
      console.warn('page-export: namen van vermeldingen niet gelezen', { table: source.table, error: error.message });
      return out;
    }
    out.push(...((data ?? []) as unknown as Array<Record<string, unknown>>));
  }
  return out;
}

/** De klant en het project, als je die mag zien; anders blijft die regel leeg. */
async function dossierNames(db: SupabaseClient, page: PageRow): Promise<{ client: string | null; project: string | null }> {
  const name = async (table: string, id: string | null) => {
    if (!id) return null;
    const { data } = await db.from(table).select('name').eq('id', id).eq('organization_id', page.organization_id).maybeSingle();
    return (data as { name?: string } | null)?.name?.trim() || null;
  };
  const [client, project] = await Promise.all([name('clients', page.client_id), name('projects', page.project_id)]);
  return { client, project };
}

/** De DOCX naar de worker, de PDF terug. Kent de worker het pad niet, dan PdfUnavailable. */
async function convertToPdf(organizationId: string, docx: ArrayBuffer): Promise<ArrayBuffer> {
  if (!MEDIA_WORKER_URL || !MEDIA_INTERNAL_SECRET) {
    throw new PdfUnavailable('De PDF is hier nog niet ingericht (MEDIA_WORKER_URL of het interne geheim ontbreekt). Word downloaden kan wel.');
  }
  let res: Response;
  try {
    res = await fetch(`${MEDIA_WORKER_URL}/internal/office/convert-page`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MEDIA_INTERNAL_SECRET}`, 'x-organization-id': organizationId, 'Content-Type': DOCX_MIME },
      body: docx,
    });
  } catch (error) {
    throw new HttpError(`De media-worker is niet bereikbaar: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
  // De worker antwoordt "Route not found" (404) zolang hij niet is bijgewerkt.
  if (res.status === 404) {
    throw new PdfUnavailable('De PDF kan nog niet: de media-worker moet eerst worden bijgewerkt. Word downloaden kan wel.');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    console.error('page-export: omzetten naar PDF mislukt', { status: res.status, detail: detail.slice(0, 300) });
    if (res.status === 413) throw new HttpError('De pagina is te groot voor een PDF.', 413);
    throw new HttpError('De PDF kon niet worden gemaakt. Probeer het zo nog eens.', 502);
  }
  const pdf = await res.arrayBuffer();
  if (pdf.byteLength < 5 || String.fromCharCode(...new Uint8Array(pdf, 0, 5)) !== '%PDF-') {
    throw new HttpError('De PDF-conversie leverde geen geldig PDF-bestand op.', 502);
  }
  return pdf;
}
