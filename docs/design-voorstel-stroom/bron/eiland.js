/* ══ Het eiland ═════════════════════════════════════════════════════════════
   Eén vlak bovenin voor alles wat je zoekt, maakt of vraagt, en voor alles wat
   nú leeft: de timer van je focusblok, Gerrie die iets uitzoekt, en de tien
   seconden waarin je een verstuurde mail nog terughaalt. Het vervangt het
   zoekveld, de knop Nieuw, de zwevende Gerrie-knop, de meldingen en de timer.

   Standen: idle (rust) · open (zoeken, maken, vragen) · note (een melding,
   eventueel met ongedaan maken) · live (de timer, uitgeklapt). Het vlak
   verandert van vorm met een veer; de inhoud vloeit over. */

// "factuur bloem content oktober 650" → { kind, client, desc, amount, … }
function parseIntent(q) {
  const s = q.trim();
  const m = s.match(/^(factuur|offerte|taak|afspraak|uren)\b\s*(.*)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  let rest = ' ' + m[2] + ' ';
  const it = { kind, raw: s };
  for (const [id, re] of CLIENT_WORDS) {
    const mm = rest.match(re);
    if (mm) { it.client = id; rest = rest.replace(mm[0], ' '); break; }
  }
  const day = rest.match(/\b(vandaag|morgen|overmorgen|maandag|dinsdag|woensdag|donderdag|vrijdag)\b/i);
  if (day) { it.day = day[1].toLowerCase(); rest = rest.replace(day[0], ' '); }
  const time = rest.match(/\b(?:om\s+)?(\d{1,2})[:.](\d{2})\b|\bom\s+(\d{1,2})\s*(?:uur)?\b/i);
  if (time && (kind === 'afspraak' || kind === 'taak')) { const h = +(time[1] || time[3]), mi = +(time[2] || 0); if (h < 24) { it.time = h * 60 + mi; rest = rest.replace(time[0], ' '); } }
  if (kind === 'uren') {
    const hrs = rest.match(/\b(\d+(?:[.,]\d+)?)\s*(u|uur|h)\b|\b(\d+)\s*(m|min|minuten)\b/i);
    if (hrs) { it.minutes = hrs[1] ? Math.round(parseFloat(hrs[1].replace(',', '.')) * 60) : +hrs[3]; rest = rest.replace(hrs[0], ' '); }
  } else if (kind !== 'afspraak') {
    const am = rest.match(/(?:€\s*)?\b(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\b\s*(?:euro|eur)?/i);
    if (am) { it.amount = parseFloat(am[1].replace(/\./g, '').replace(',', '.')); rest = rest.replace(am[0], ' '); }
  }
  const words = rest.replace(/\b(voor|van|aan|de|het|een|met|om|euro|eur|excl|incl|btw|maken|nieuwe|nieuw)\b/gi, ' ').replace(/[€,]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length) { const d = words.join(' '); it.desc = d.charAt(0).toUpperCase() + d.slice(1); }
  return it;
}

const DAY_IDX = { vandaag: 3, morgen: 4, overmorgen: 5, maandag: 7, dinsdag: 8, woensdag: 9, donderdag: 10, vrijdag: 4 };
const DAY_NAME = { vandaag: 'vandaag', morgen: 'morgen, vrijdag 23 oktober', overmorgen: 'zaterdag 24 oktober', maandag: 'maandag 26 oktober', dinsdag: 'dinsdag 27 oktober', woensdag: 'woensdag 28 oktober', donderdag: 'donderdag 29 oktober', vrijdag: 'vrijdag 23 oktober' };
const looksLikeQuestion = q => /\?\s*$/.test(q) || /^(wat|wie|wanneer|hoe|waar|waarom|welke|hoeveel|kun|kan|kunnen|plan|zet|stuur|laat|geef|toon|vat|help)\b/i.test(q.trim());

// Woorden van een antwoord één voor één laten verschijnen, ook binnen <b>
function wordsHtml(html) {
  let n = 0;
  return html.split(/(<[^>]+>)/).map(part => part.startsWith('<') ? part : part.split(/(\s+)/).map(w => w.trim() ? `<span class="w" style="--w:${n++}">${w}</span>` : w).join('')).join('');
}

function createIsland(app) {
  const el = document.createElement('div');
  el.className = 'isl';
  el.dataset.state = 'idle';
  const uid = app.uid;
  el.innerHTML = `
  <div class="isl-shell glass glass-3">
    <div class="isl-l isl-idle" data-l="idle">
      <button type="button" class="isl-face" aria-haspopup="dialog" aria-label="Vraag Gerrie, zoek of maak iets (Ctrl K)">
        <span class="orb sm"></span><span class="isl-ph"><span class="isl-ph-l">Vraag Gerrie, zoek of maak iets…</span><span class="isl-ph-s">Vraag of zoek…</span></span><kbd class="isl-k">Ctrl K</kbd>
      </button>
      <button type="button" class="isl-live" hidden aria-label="Timer openen">
        <span class="isl-ring"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"></circle><circle class="pr" cx="10" cy="10" r="8" pathLength="100"></circle></svg></span>
        <b class="isl-t">0:41</b><span class="isl-tl">Logo-schetsen</span>
      </button>
    </div>
    <div class="isl-l isl-pal" data-l="open" role="dialog" aria-label="Eiland: vraag, zoek of maak">
      <div class="isl-in">
        <span class="orb sm"></span>
        <input id="${uid}-q" type="text" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="${uid}-list" aria-autocomplete="list" aria-label="Vraag Gerrie, zoek of maak iets" placeholder="Vraag Gerrie, zoek of maak iets…">
        <button type="button" class="isl-esc" aria-label="Sluiten"><kbd>esc</kbd></button>
      </div>
      <div class="isl-chips" hidden></div>
      <div class="isl-body">
        <div class="isl-list" id="${uid}-list" role="listbox" aria-label="Resultaten"></div>
        <aside class="isl-prev" hidden aria-live="polite"></aside>
      </div>
      <div class="isl-foot"><span><kbd>↑</kbd><kbd>↓</kbd> kiezen</span><span><kbd>↵</kbd> doen</span><span><kbd>⇥</kbd> vraag Gerrie</span><span class="isl-safe">${ic('shield-check', 'xs')}Er gaat niets de deur uit zonder jouw akkoord</span></div>
    </div>
    <div class="isl-l isl-note" data-l="note" role="status" aria-live="polite"></div>
    <div class="isl-l isl-livecard" data-l="live" role="dialog" aria-label="Timer"></div>
  </div>`;
  app.root.querySelector('.isl-slot').appendChild(el);

  const shell = el.querySelector('.isl-shell');
  const input = el.querySelector('input');
  const list = el.querySelector('.isl-list');
  const prev = el.querySelector('.isl-prev');
  const chipsEl = el.querySelector('.isl-chips');
  const liveBtn = el.querySelector('.isl-live');
  const noteEl = el.querySelector('.isl-note');
  const liveCard = el.querySelector('.isl-livecard');
  let state = 'idle', opts = [], active = 0, answering = false, intent = null, paperKind = null;
  const queue = [];
  let noteTimer = 0, current = null;

  // ── Vorm ──
  function fit() {
    const layer = el.querySelector(`.isl-l[data-l="${state}"]`);
    const max = app.root.clientWidth - (app.phone() ? 20 : 40);
    let w;
    if (state === 'open') { w = Math.min(intent || answering ? 1000 : 720, max); layer.style.width = w + 'px'; }
    else if (state === 'live') { w = Math.min(520, max); layer.style.width = w + 'px'; }
    else { layer.style.width = 'max-content'; w = Math.min(layer.scrollWidth, max); layer.style.width = w + 'px'; }
    const h = Math.min(layer.scrollHeight, app.root.clientHeight - 30);
    shell.style.width = w + 'px';
    shell.style.height = h + 'px';
  }
  function set(s) {
    state = s; el.dataset.state = s;
    app.root.classList.toggle('isl-open', s === 'open' || s === 'live');
    fit();
  }

  // ── Openen en sluiten ──
  function open(text = '', o = {}) {
    // Een gewone melding maakt plaats; een lopend ongedaan-maken telt op de
    // achtergrond door en komt terug zodra het eiland weer dichtgaat.
    if (current && !current.undo) { clearTimeout(noteTimer); current = null; }
    answering = false; intent = null;
    input.value = text;
    set('open');
    refresh();
    // Meteen focussen (niet pas in het volgende beeld): wie na ⌘K direct typt, raakt geen letter kwijt
    if (o.focus !== false) { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); }
  }
  function close() {
    if (state !== 'open' && state !== 'live') return;
    answering = false; intent = null; paperKind = null;
    prev.hidden = true; prev.innerHTML = '';
    if (current) set('note'); else { set('idle'); nextNote(); }
    app.focusMain && app.focusMain();
  }

  // ── Wat je ziet terwijl je typt ──
  function refresh() {
    const q = input.value;
    intent = parseIntent(q);
    renderChips();
    renderPreview();
    renderList(q);
    fit();
  }
  function renderChips() {
    if (!intent) { chipsEl.hidden = true; chipsEl.innerHTML = ''; return; }
    const c = intent.client && CLIENTS[intent.client];
    const label = { factuur: 'Factuur', offerte: 'Offerte', taak: 'Taak', afspraak: 'Afspraak', uren: 'Uren' }[intent.kind];
    const icon = { factuur: 'receipt', offerte: 'file-text', taak: 'list-todo', afspraak: 'calendar-clock', uren: 'timer' }[intent.kind];
    const chips = [`<span class="ch on">${ic(icon, 'xs')}${label}</span>`];
    chips.push(c ? `<span class="ch on"><i style="background:${c.color}"></i>${esc(c.name)}</span>` : `<span class="ch">${ic('users', 'xs')}klant?</span>`);
    if (intent.kind === 'factuur' || intent.kind === 'offerte' || intent.kind === 'taak') chips.push(intent.desc ? `<span class="ch on">${ic('type', 'xs')}${esc(intent.desc)}</span>` : `<span class="ch">${ic('type', 'xs')}omschrijving?</span>`);
    if (intent.kind === 'factuur' || intent.kind === 'offerte') chips.push(intent.amount ? `<span class="ch on">${ic('euro', 'xs')}${eurTxt(intent.amount)} excl.</span>` : `<span class="ch">${ic('euro', 'xs')}bedrag?</span>`);
    if (intent.kind === 'afspraak' || intent.kind === 'taak') chips.push(intent.day ? `<span class="ch on">${ic('calendar', 'xs')}${intent.day}${intent.time != null ? ' ' + hhmm(intent.time) : ''}</span>` : `<span class="ch">${ic('calendar', 'xs')}wanneer?</span>`);
    if (intent.kind === 'uren') chips.push(intent.minutes ? `<span class="ch on">${ic('timer', 'xs')}${dur(intent.minutes)}</span>` : `<span class="ch">${ic('timer', 'xs')}hoeveel?</span>`);
    chipsEl.innerHTML = `<span class="ch-lead">${ic('wand-sparkles', 'xs i-ai')}Gerrie leest</span>${chips.join('')}`;
    chipsEl.hidden = false;
  }

  // ── Gerrie bouwt mee: het voorbeeld dat zich opbouwt ──
  const nextNr = () => (app.state.invoices.length ? '2026-0' + (Math.max(...app.state.invoices.map(i => +i.n.slice(-3))) + 1) : '2026-043');
  function renderPreview() {
    if (answering) return;
    if (!intent) { prev.hidden = true; paperKind = null; return; }
    prev.hidden = false;
    const k = intent.kind;
    if (k === 'factuur' || k === 'offerte') return paper(k);
    paperKind = null;
    const c = intent.client && CLIENTS[intent.client];
    const proj = c && Object.values(PROJECTS).find(p => p.client === intent.client);
    if (k === 'taak') {
      prev.innerHTML = `<div class="pv-card glass glass-2"><div class="pv-k">${ic('list-todo', 'sm')}Nieuwe taak</div>
        <h4 class="${intent.desc ? 'on' : 'sk'}">${intent.desc ? esc(intent.desc) : 'Wat moet er gebeuren?'}</h4>
        <dl class="pv-dl"><div><dt>Project</dt><dd class="${proj ? 'on' : 'sk'}">${proj ? `<i style="background:${proj.color}"></i>${esc(proj.name)}` : 'kies een klant'}</dd></div>
        <div><dt>Wanneer</dt><dd class="${intent.day ? 'on' : 'sk'}">${intent.day ? DAY_NAME[intent.day] + (intent.time != null ? ', ' + hhmm(intent.time) : '') : 'geen datum'}</dd></div>
        <div><dt>Voor</dt><dd class="on"><span class="av" style="--s:18px">GL</span>Jij</dd></div></dl></div>`;
    } else if (k === 'afspraak') {
      const t = intent.time != null ? intent.time : 14 * 60;
      const busy = intent.day === 'morgen' || intent.day === 'vrijdag' ? WEEK.filter(w => w.d === 4) : intent.day === 'vandaag' || !intent.day ? TODAY.map(x => ({ s: x.s, e: x.e, t: x.short || x.t, c: colorOf(x) })) : [];
      const clash = busy.find(b => t < b.e && t + 60 > b.s);
      const pos = m => ((m - 480) / 600 * 100).toFixed(2) + '%';
      prev.innerHTML = `<div class="pv-card glass glass-2"><div class="pv-k">${ic('calendar-clock', 'sm')}Nieuwe afspraak</div>
        <h4 class="${c ? 'on' : 'sk'}">${c ? 'Afspraak met ' + esc(c.contact) : 'Met wie?'}</h4>
        <p class="pv-when ${intent.day ? 'on' : 'sk'}">${intent.day ? DAY_NAME[intent.day] : 'welke dag?'} · ${hhmm(t)} – ${hhmm(t + 60)}</p>
        <div class="pv-day" aria-hidden="true">${busy.map(b => `<i class="b" style="left:${pos(b.s)};width:calc(${pos(b.e)} - ${pos(b.s)});--c:${b.c}"></i>`).join('')}<i class="slot${clash ? ' clash' : ''}" style="left:${pos(t)};width:calc(${pos(t + 60)} - ${pos(t)})"></i><span>08</span><span>13</span><span>18</span></div>
        <p class="pv-note ${clash ? 'warn' : 'ok'}">${clash ? `${ic('triangle-alert', 'xs')}Botst met ${esc(clash.t)}. Om ${hhmm(clash.e)} is het vrij.` : `${ic('circle-check', 'xs')}Je bent dan vrij${c ? `; ${esc(c.contact.split(' ')[0])} krijgt een uitnodiging zodra jij hem goedkeurt` : ''}.`}</p></div>`;
    } else if (k === 'uren') {
      const mins = intent.minutes || 0;
      prev.innerHTML = `<div class="pv-card glass glass-2"><div class="pv-k">${ic('timer', 'sm')}Uren boeken</div>
        <h4 class="${mins ? 'on' : 'sk'}">${mins ? dur(mins) : 'Hoeveel tijd?'}</h4>
        <dl class="pv-dl"><div><dt>Project</dt><dd class="${proj ? 'on' : 'sk'}">${proj ? `<i style="background:${proj.color}"></i>${esc(proj.name)}` : 'kies een klant'}</dd></div>
        <div><dt>Datum</dt><dd class="on">vandaag, 22 oktober</dd></div>
        <div><dt>Declarabel</dt><dd class="${mins ? 'on' : 'sk'}">${mins ? eur(mins / 60 * 85) + ' · € 85 per uur' : '—'}</dd></div></dl></div>`;
    }
  }
  function paper(kind) {
    const c = intent.client && CLIENTS[intent.client];
    const nr = kind === 'factuur' ? nextNr() : '2026-022';
    const ex = intent.amount || 0, vat = Math.round(ex * 21) / 100, tot = ex + vat;
    if (paperKind !== kind) {
      paperKind = kind;
      prev.innerHTML = `<div class="pv-paper" data-kind="${kind}">
        <div class="pp-head"><span class="pp-logo">SL</span><div><b>Studio Lopik B.V.</b><span>Kerkstraat 12 · 3411 AB Lopik</span></div><span class="pp-type">${kind === 'factuur' ? 'Factuur' : 'Offerte'}</span></div>
        <div class="pp-meta"><div><span>Aan</span><b data-f="to" class="sk">Klant</b><em data-f="att" class="sk">t.a.v. …</em></div>
          <div><span>Nummer</span><b>${nr}</b><em>concept</em></div>
          <div><span>Datum</span><b>22 okt 2026</b><em data-f="due">${kind === 'factuur' ? 'vervalt 5 nov' : 'geldig tot 21 nov'}</em></div></div>
        <div class="pp-lines"><div class="pp-lh"><span>Omschrijving</span><span>Aantal</span><span>Bedrag</span></div>
          <div class="pp-line"><span data-f="desc" class="sk">Omschrijving</span><span>1</span><span data-f="ex" class="sk">€ —</span></div></div>
        <div class="pp-tot"><div><span>Subtotaal</span><span data-f="sub">€ 0,00</span></div><div><span>Btw 21%</span><span data-f="vat">€ 0,00</span></div><div class="pp-sum"><span>Totaal</span><b data-f="tot" class="amt">€ 0,00</b></div></div>
        <div class="pp-foot">${kind === 'factuur' ? 'Betaling binnen 14 dagen op NL12 ABNA 0123 4567 89 · iDEAL-link in de mail' : 'Akkoord geven kan online, met één klik'}</div>
        <div class="pp-ai">${ic('sparkles', 'xs i-ai')}<span>Gerrie vult in wat je zegt. Er wordt niets verstuurd: het wordt een concept.</span></div>
      </div>`;
    }
    const f = k => prev.querySelector(`[data-f="${k}"]`);
    const setF = (k, val, on) => { const e = f(k); if (!e) return; if (e.innerHTML !== val) { e.innerHTML = val; e.classList.remove('flash'); void e.offsetWidth; e.classList.add('flash'); } e.classList.toggle('sk', !on); e.classList.toggle('on', !!on); };
    setF('to', c ? esc(c.name) : 'Klant', !!c);
    setF('att', c ? 't.a.v. ' + esc(c.contact) : 't.a.v. …', !!c);
    setF('desc', intent.desc ? esc(intent.desc) : 'Omschrijving', !!intent.desc);
    setF('ex', ex ? eurTxt(ex) : '€ —', !!ex);
    setF('sub', eurTxt(ex), !!ex); setF('vat', eurTxt(vat), !!ex);
    const totEl = f('tot');
    const from = parseFloat(totEl.dataset.v || '0');
    totEl.dataset.v = tot;
    countUp(totEl, from, tot);
    totEl.classList.toggle('on', !!ex);
  }
  function countUp(elm, from, to) {
    if (from === to) { elm.innerHTML = eur(to); return; }
    const t0 = performance.now(), d = reducedMotion() ? 0 : 520;
    const tick = now => { const k = d ? Math.min(1, (now - t0) / d) : 1; elm.innerHTML = eur(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  // ── De lijst ──
  function renderList(q) {
    const qq = q.trim().toLowerCase();
    opts = [];
    const add = (g, o) => opts.push({ g, ...o });
    if (intent) {
      const c = intent.client && CLIENTS[intent.client];
      const what = { factuur: 'factuur', offerte: 'offerte', taak: 'taak', afspraak: 'afspraak', uren: 'uren' }[intent.kind];
      const ready = intent.kind === 'factuur' || intent.kind === 'offerte' ? !!(c && intent.amount) : intent.kind === 'uren' ? !!(intent.minutes && c) : !!(c || intent.desc);
      add('Gerrie zet klaar', { kind: 'intent', ic: 'wand-sparkles', ai: true, t: ready ? `Zet ${intent.kind === 'uren' ? 'de uren' : 'de ' + what} klaar${c ? ' voor ' + c.name : ''}` : `Nog even: ${!c ? 'voor welke klant?' : intent.kind === 'uren' ? 'hoeveel tijd?' : 'welk bedrag?'}`, sub: ready ? 'Als concept · er wordt niets verstuurd' : 'Typ verder, het voorbeeld vult zich', dis: !ready, key: '↵' });
      add('Gerrie zet klaar', { kind: 'ask', ic: 'sparkles', ai: true, t: `Vraag Gerrie: “${q.trim()}”`, sub: 'Open het gesprek met je vraag erin' });
    } else if (!qq) {
      ASK.forEach(a => add('Vraag Gerrie', { kind: a.startsWith('factuur') ? 'fill' : 'ask', fill: a, ic: a.startsWith('factuur') ? 'wand-sparkles' : 'sparkles', ai: true, t: a, sub: a.startsWith('factuur') ? 'Probeer: Gerrie bouwt de factuur terwijl je typt' : '' }));
      RECENT.forEach(r => add('Recent', { kind: 'go', ...r }));
      INDEX.filter(x => x.g === 'Maak').forEach(x => add('Maak', { kind: 'fill', ...x }));
    } else {
      const words = qq.split(/\s+/);
      const hits = INDEX.filter(x => { const hay = (x.t + ' ' + (x.sub || '') + ' ' + x.kw).toLowerCase(); return words.every(w => hay.includes(w)); });
      const ask = { kind: 'ask', ic: 'sparkles', ai: true, t: `Vraag Gerrie: “${q.trim()}”`, sub: looksLikeQuestion(q) ? 'Gerrie zoekt het voor je uit' : 'Of laat Gerrie het voor je zoeken' };
      add('Gerrie', ask);
      hits.slice(0, 7).forEach(x => add(x.g, { kind: x.fill ? 'fill' : 'go', ...x }));
    }
    const exact = opts.findIndex(o => o.kind === 'go' && o.t.toLowerCase() === qq);
    active = intent ? (opts[0].dis ? 1 : 0) : !qq ? 0 : exact >= 0 ? exact : (looksLikeQuestion(q) || opts.length === 1) ? 0 : 1;
    let lastG = '';
    list.innerHTML = opts.map((o, i) => {
      const head = o.g !== lastG ? `<div class="isl-g" role="presentation">${esc(o.g)}</div>` : '';
      lastG = o.g;
      const lead = o.c ? `<span class="isl-oi cl" style="--c:${CLIENTS[o.c].color}">${CLIENTS[o.c].ini}</span>` : `<span class="isl-oi${o.ai ? ' ai' : ''}">${ic(o.ic, o.ai ? 'sm i-ai' : 'sm')}</span>`;
      return `${head}<div class="isl-o${o.ai ? ' is-ai' : ''}${o.dis ? ' is-dis' : ''}" role="option" id="${uid}-o${i}" data-i="${i}" aria-selected="${i === active}"${o.dis ? ' aria-disabled="true"' : ''}>${lead}<span class="isl-ot"><b>${esc(o.t)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ''}</span>${o.key ? `<kbd>${o.key}</kbd>` : `<span class="isl-oa">${ic('arrow-right', 'xs')}</span>`}</div>`;
    }).join('');
    markActive();
  }
  function markActive() {
    list.querySelectorAll('.isl-o').forEach(o => o.setAttribute('aria-selected', +o.dataset.i === active));
    input.setAttribute('aria-activedescendant', `${uid}-o${active}`);
    // Alleen de lijst schuift mee; scrollIntoView zou ook de pagina eromheen verschuiven
    const a = list.querySelector(`[data-i="${active}"]`);
    if (a) { const lr = list.getBoundingClientRect(), ar = a.getBoundingClientRect(); if (ar.top < lr.top) list.scrollTop -= lr.top - ar.top + 8; else if (ar.bottom > lr.bottom) list.scrollTop += ar.bottom - lr.bottom + 8; }
  }

  // ── Doen ──
  function run(i) {
    const o = opts[i]; if (!o || o.dis) return;
    if (o.kind === 'go') { close(); app.go(o.go); }
    else if (o.kind === 'fill') { input.value = o.fill; refresh(); input.focus(); }
    else if (o.kind === 'ask') ask(o.fill || input.value.trim());
    else if (o.kind === 'intent') make();
  }
  function make() {
    const it = intent; if (!it) return;
    const c = it.client && CLIENTS[it.client];
    const src = prev.querySelector('.pv-paper, .pv-card');
    const target = { factuur: 'geld', offerte: 'geld', taak: 'werk', afspraak: 'agenda', uren: 'agenda' }[it.kind];
    let msg, sub, go;
    if (it.kind === 'factuur') { const nr = nextNr(); app.addInvoice({ n: nr, c: it.client, d: it.desc || 'Werkzaamheden', date: '22 okt', due: '5 nov', amt: Math.round(it.amount * 121) / 100, ex: it.amount, st: 'concept', note: 'Klaargezet door Gerrie', fresh: true }); msg = `Concept ${nr} staat klaar`; sub = `${c.short} · ${eurTxt(Math.round(it.amount * 121) / 100)} · nog niet verstuurd`; go = 'factuur:' + nr; }
    else if (it.kind === 'offerte') { msg = 'Conceptofferte 2026-022 staat klaar'; sub = `${c.short} · ${eurTxt(Math.round(it.amount * 121) / 100)} · nog niet verstuurd`; go = 'geld:offertes'; }
    else if (it.kind === 'taak') { msg = 'Taak staat in je lijst'; sub = (it.desc || 'Nieuwe taak') + (it.day ? ' · ' + it.day : ''); go = 'vandaag'; }
    else if (it.kind === 'afspraak') { msg = 'Afspraak staat in je agenda'; sub = `${c ? c.contact : 'Afspraak'} · ${it.day || 'vandaag'} ${hhmm(it.time != null ? it.time : 840)} · uitnodiging als concept`; go = 'agenda'; }
    else { msg = `${dur(it.minutes)} geboekt`; sub = c ? Object.values(PROJECTS).find(p => p.client === it.client).name : ''; go = 'agenda'; }
    if (src) app.fly(src, target);
    close();
    note({ icon: 'circle-check', tone: 'ok', text: msg, sub, action: { label: 'Bekijk', fn: () => app.go(go) }, ms: 5200 });
  }
  function ask(q) {
    if (!q) return;
    answering = true; intent = null;
    chipsEl.hidden = true; prev.hidden = true; prev.innerHTML = ''; paperKind = null;
    const hit = ANSWERS.find(a => a.re.test(q));
    list.innerHTML = `<div class="isl-ans"><p class="isl-ans-q">“${esc(q)}”</p><div class="isl-ans-a"><span class="orb sm live"></span><p class="isl-think">Gerrie kijkt in je administratie<span class="dots"><i></i><i></i><i></i></span></p></div></div>`;
    shell.classList.add('thinking');
    app.light && app.light.aurora(1.6);
    fit();
    setTimeout(() => {
      if (!answering) return;
      shell.classList.remove('thinking');
      app.light && app.light.aurora(1);
      const a = hit ? hit.a : 'In dit voorstel kent Gerrie vier onderwerpen: <b>Restaurant Bloem</b>, <b>je vrijdag</b>, <b>je geld</b> en <b>De Korenaar</b>. In de app beantwoordt hij elke vraag over je eigen administratie, met dezelfde rechten als jij.';
      const acts = hit ? hit.acts : [['Wat staat er open bij Bloem?', 'sparkles', 'ask:Wat staat er nog open bij Restaurant Bloem?', 'ai']];
      list.querySelector('.isl-ans-a').innerHTML = `<span class="orb sm"></span><p>${wordsHtml(a)}</p>`;
      const n = (a.match(/class="w"/g) || []).length || a.split(/\s+/).length;
      const actsEl = document.createElement('div');
      actsEl.className = 'isl-ans-acts';
      actsEl.style.setProperty('--w', n);
      actsEl.innerHTML = acts.map(([t, i, go, cls]) => `<button type="button" class="btn btn-sm ${cls === 'ai' ? 'btn-ai' : ''}" data-go="${go}">${ic(i, cls === 'ai' ? 'i-ai' : '')}${esc(t)}</button>`).join('') + `<span class="isl-ans-src">${ic('shield-check', 'xs')}Uit je eigen administratie</span>`;
      list.querySelector('.isl-ans').appendChild(actsEl);
      fit();
      setTimeout(fit, 60);
    }, reducedMotion() ? 0 : 900);
  }
  list.addEventListener('click', e => {
    const b = e.target.closest('[data-go]');
    if (b) {
      e.stopPropagation();   // het eiland handelt dit af; de app hoeft de klik niet nog eens te zien
      const go = b.dataset.go;
      if (go.startsWith('ask:')) return ask(go.slice(4));
      close();
      if (go.startsWith('dec:')) app.openDecision(go.slice(4));
      else if (go === 'plan') app.go('agenda', { plan: true });
      else app.go(go);
      return;
    }
    const o = e.target.closest('.isl-o'); if (o) run(+o.dataset.i);
  });
  list.addEventListener('pointermove', e => { const o = e.target.closest('.isl-o'); if (o && +o.dataset.i !== active) { active = +o.dataset.i; markActive(); } });
  input.addEventListener('input', () => { answering = false; refresh(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (answering || !opts.length) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      let n = active; do { n = (n + dir + opts.length) % opts.length; } while (opts[n].dis && n !== active);
      active = n; markActive();
    } else if (e.key === 'Enter') { e.preventDefault(); if (!answering) run(active); }
    else if (e.key === 'Tab' && input.value.trim() && !answering) { e.preventDefault(); ask(input.value.trim()); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (answering) { answering = false; refresh(); } else close(); }
  });
  el.querySelector('.isl-face').addEventListener('click', () => open());
  el.querySelector('.isl-esc').addEventListener('click', close);
  liveBtn.addEventListener('click', openLive);

  // ── Meldingen, met tien seconden om iets terug te halen ──
  function note(n) {
    // Een ongedaan-maken gaat voor: zijn tien seconden lopen vanaf nu, niet na een andere melding
    if (n.undo && current && !current.undo && state === 'note') { clearTimeout(noteTimer); current = null; set('idle'); queue.unshift(n); nextNote(); return; }
    queue.push(n); nextNote();
  }
  function nextNote() {
    if (state !== 'idle' || current || !queue.length) return;
    current = queue.shift();
    const n = current;
    const tone = n.tone || 'ok';
    noteEl.innerHTML = `<span class="isl-ni ${tone}">${n.undo ? `<svg viewBox="0 0 20 20" class="cd" aria-hidden="true"><circle cx="10" cy="10" r="8.5"></circle><circle class="pr" cx="10" cy="10" r="8.5" pathLength="100" style="--secs:${n.undo.secs}s"></circle></svg>` : ''}${ic(n.icon || 'circle-check', 'sm')}</span>
      <span class="isl-nt"><b>${esc(n.text)}</b>${n.sub ? `<span>${esc(n.sub)}</span>` : ''}</span>
      ${n.undo ? `<button type="button" class="btn btn-sm isl-undo">${ic('undo-2')}Ongedaan maken</button>` : ''}
      ${n.action ? `<button type="button" class="btn btn-sm btn-ghost isl-act">${esc(n.action.label)}${ic('arrow-right', 'xs')}</button>` : ''}`;
    shell.classList.toggle('thinking', !!n.think);
    set('note');
    if (n.undo) {
      let left = noteEl.querySelector('.isl-nt span');
      if (!left) { left = document.createElement('span'); noteEl.querySelector('.isl-nt').appendChild(left); }
      let s = n.undo.secs;
      const base = n.sub || '';
      const say = () => { left.textContent = `${base}${base ? ' · ' : ''}${n.undo.verb === 'boek' ? `nog ${s} s terug te halen` : `gaat over ${s} s de deur uit`}`; };
      say();
      noteTimer = setInterval(() => {
        s--; if (s > 0) say();
        if (s <= 0) { clearInterval(noteTimer); finish(true); }
      }, 1000);
      noteEl.querySelector('.isl-undo').addEventListener('click', () => {
        clearInterval(noteTimer);
        n.undo.onUndo && n.undo.onUndo();
        current = null;
        queue.unshift({ icon: 'undo-2', tone: 'muted', text: 'Teruggehaald', sub: 'Er is niets verstuurd', ms: 2200 });
        set('idle'); nextNote();
      });
    } else {
      noteTimer = setTimeout(() => finish(false), n.ms || 4200);
    }
    if (n.action) noteEl.querySelector('.isl-act').addEventListener('click', () => { clearTimeout(noteTimer); current = null; set('idle'); n.action.fn(); nextNote(); });
  }
  function finish(sent) {
    const n = current; current = null;
    shell.classList.remove('thinking');
    if (sent && n && n.undo) {
      n.undo.onDone && n.undo.onDone();
      queue.unshift({ icon: 'send', tone: 'ok', text: n.undo.doneText || 'Verstuurd', sub: n.undo.doneSub || '', ms: 2400 });
    }
    if (state === 'note') set('idle');
    nextNote();
  }

  // ── De timer ──
  const timer = { on: true, paused: false, start: 540, title: 'Logo-schetsen uitwerken', short: 'Logo-schetsen', p: 'huisstijl', until: 595, pausedAt: 0, pausedFor: 0 };
  function elapsed() { const now = app.clock(); const end = timer.paused ? timer.pausedAt : now; return Math.max(0, end - timer.start * 60 - timer.pausedFor); }
  function fmt(sec, long) { const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60); return long ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${h}:${String(m).padStart(2, '0')}`; }
  function tick() {
    const sec = elapsed();
    const pct = Math.min(100, sec / ((timer.until - timer.start) * 60) * 100);
    el.querySelector('.isl-t').textContent = fmt(sec);
    el.querySelector('.isl-tl').textContent = timer.short;
    liveBtn.style.setProperty('--pct', pct);
    liveBtn.classList.toggle('paused', timer.paused);
    liveBtn.setAttribute('aria-label', `Timer: ${timer.title}, ${Math.floor(sec / 60)} minuten${timer.paused ? ', gepauzeerd' : ''}. Openen`);
    const big = liveCard.querySelector('.lc-t'); if (big) { big.textContent = fmt(sec, true); liveCard.querySelector('.lc-bar i').style.width = pct + '%'; }
    app.onTimer && app.onTimer(sec, pct, timer);
  }
  setInterval(tick, 1000); tick();
  function openLive() {
    const p = PROJECTS[timer.p];
    const next = TODAY.find(x => x.s * 60 > app.clock() && x.kind !== 'focus');
    const inMin = next ? Math.round((next.s * 60 - app.clock()) / 60) : 0;
    liveCard.innerHTML = `<div class="lc-h"><span class="lc-dot" style="--c:${p.color}"></span><div><b>${esc(timer.title)}</b><span>${esc(p.name)} · focusblok tot ${hhmm(timer.until)}</span></div><button type="button" class="icon-btn lc-x" aria-label="Sluiten">${ic('x', 'sm')}</button></div>
      <div class="lc-mid"><span class="lc-t">0:00:00</span><span class="lc-bar"><i></i></span><span class="lc-r">${hhmm(timer.start)} → ${hhmm(timer.until)}</span></div>
      <div class="lc-acts"><button type="button" class="btn btn-sm lc-pause">${ic(timer.paused ? 'play' : 'pause')}${timer.paused ? 'Verder' : 'Pauze'}</button><button type="button" class="btn btn-sm btn-gold lc-stop">${ic('square')}Stop en boek ${Math.floor(elapsed() / 60)}m</button><button type="button" class="btn btn-sm btn-ghost lc-swap">${ic('repeat')}Wissel</button></div>
      ${next ? `<div class="lc-next"><span>Volgende</span><b>${hhmm(next.s)} ${esc(next.t)}</b><em>over ${inMin} min</em>${next.join === 'video' ? `<button type="button" class="btn btn-sm lc-join">${ic('video')}Deelnemen</button>` : ''}</div>` : ''}`;
    set('live'); tick();
    liveCard.querySelector('.lc-x').addEventListener('click', close);
    liveCard.querySelector('.lc-pause').addEventListener('click', () => { if (timer.paused) { timer.pausedFor += app.clock() - timer.pausedAt; timer.paused = false; } else { timer.paused = true; timer.pausedAt = app.clock(); } openLive(); });
    liveCard.querySelector('.lc-stop').addEventListener('click', () => { const m = Math.floor(elapsed() / 60); timer.on = false; liveBtn.hidden = true; app.timerStopped && app.timerStopped(); close(); note({ icon: 'timer', tone: 'ok', text: `${m} minuten geboekt`, sub: `${p.name} · declarabel ${eurTxt(m / 60 * 85)}`, ms: 4200 }); });
    liveCard.querySelector('.lc-swap').addEventListener('click', () => { close(); open('uren '); });
    const j = liveCard.querySelector('.lc-join'); if (j) j.addEventListener('click', () => { close(); note({ icon: 'video', tone: 'ok', text: 'Je doet mee aan Overleg Joost', sub: 'In de echte app opent nu Jitsi in een nieuw venster', ms: 3600 }); });
  }

  // ⌘K op een Mac, Ctrl K elders
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) { el.querySelector('.isl-k').textContent = '⌘K'; el.querySelector('.isl-face').setAttribute('aria-label', 'Vraag Gerrie, zoek of maak iets (⌘K)'); }

  return {
    el, open, close, note, fit,
    isOpen: () => state === 'open' || state === 'live',
    showLive(v) { liveBtn.hidden = !v || !timer.on; if (state === 'idle') fit(); },
    liveRect: () => liveBtn.getBoundingClientRect(),
    timer, elapsed,
    think(on, text) { shell.classList.toggle('thinking', on); },
  };
}
