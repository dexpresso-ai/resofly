/* ══ De schermen ════════════════════════════════════════════════════════════
   Elk scherm: html(app, arg, o) geeft de opbouw, mount(app, arg, o) maakt hem
   levend. Dezelfde gegevens en dezelfde regels als in Zenit; de opbouw volgt
   de vijf regels van Onbewolkt (één keer zeggen, eerst de zin, filters slapen,
   dichtbij scherp, vandaag eerst). */

const SCREENS = {};

/* ── Vandaag ────────────────────────────────────────────────────────────── */
function streamSum(app) {
  const f = app.state.flow;
  const onderweg = f.filter(x => x.st === 'factuur').reduce((a, x) => a + x.amt, 0);
  const knots = f.filter(x => x.knot === 'wait' || x.knot === 'late').length;
  const sent = f.filter(x => x.knot === 'sent').length;
  const lead = app.state.paid ? '<b>€ 786,50</b> kwam net binnen van Bloem. ' : '';
  const k = knots ? `${['', 'Eén knoop', 'Twee knopen'][knots] || knots + ' knopen'}, en Gerrie heeft ${knots === 1 ? 'iets klaar om hem los te maken' : 'voor allebei iets klaar'}.` : sent ? `${sent === 1 ? 'De knoop is' : 'De knopen zijn'} opgevolgd; Gerrie let op het antwoord.` : 'Alles stroomt.';
  return `${lead}<b class="amt">${eur(onderweg)}</b> onderweg naar je rekening. ${k}`;
}
function nuHtml(app) {
  const t = app.island.timer;
  if (!t.on) return `<div class="nu glass sheen is-off"><div class="nu-k">${ic('timer', 'xs')}Geen timer</div><b class="nu-t">Wat doe je nu?</b><span class="nu-p">De volgende is om 10:00: Overleg Joost</span><div class="nu-next"><button type="button" class="btn btn-sm" data-ask="uren ">${ic('play')}Start een timer</button></div></div>`;
  const p = PROJECTS[t.p];
  const next = TODAY.find(x => x.s > DEMO.now && x.kind !== 'focus');
  const sec = app.island.elapsed(), pct = Math.min(100, sec / ((t.until - t.start) * 60) * 100);
  return `<div class="nu glass sheen" aria-label="Nu: ${esc(t.title)}">
    <div class="nu-k"><span class="nu-live" aria-hidden="true"></span>Nu · focusblok</div>
    <b class="nu-t">${esc(t.title)}</b>
    <span class="nu-p"><i style="background:${p.color}"></i>${esc(p.name)}</span>
    <div class="nu-time"><span class="nu-clock amt" data-nu-clock>${Math.floor(sec / 3600)}:${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}</span><span class="nu-bar" aria-hidden="true"><i data-nu-bar style="width:${pct.toFixed(2)}%"></i></span><span class="nu-end">tot ${hhmm(t.until)}</span></div>
    <div class="nu-next"><span class="nu-nx"><em>Daarna · over ${next.s - DEMO.now} min</em><b>${hhmm(next.s)} ${esc(next.short)}</b></span><button type="button" class="btn btn-sm" data-join>${ic('video')}Deelnemen</button></div>
  </div>`;
}
function dayHtml() {
  const now = DEMO.now;
  const rows = [];
  rows.push(`<li class="day-i left"><span class="day-tm">${ic('triangle-alert', 'xs')}</span><span class="day-c" style="--c:${PROJECTS[LEFTOVER.p].color}"></span><span class="day-x"><b>${esc(LEFTOVER.t)}</b><em>Gisteren blijven liggen · Van Dijk</em></span><button type="button" class="btn btn-sm btn-ghost" data-ask="taak terugbellen peter vandaag 16:30">Plan in</button></li>`);
  let placed = false;
  TODAY.forEach(x => {
    if (!placed && x.s > now) { rows.push(`<li class="day-now"><span>${hhmm(now)}</span><i></i><span class="sr-only">Nu</span></li>`); placed = true; }
    const past = x.e <= now, cur = x.s <= now && x.e > now;
    const act = x.join === 'video' ? `<button type="button" class="btn btn-sm" data-join>${ic('video')}Deelnemen</button>` : x.join === 'route' ? `<button type="button" class="btn btn-sm btn-ghost">${ic('map-pin')}Route</button>` : x.join === 'call' ? `<button type="button" class="btn btn-sm btn-ghost">${ic('phone')}Bellen</button>` : '';
    rows.push(`<li class="day-i ${x.kind}${past ? ' past' : ''}${cur ? ' cur' : ''}"><span class="day-tm">${hhmm(x.s)}</span><span class="day-c" style="--c:${colorOf(x)}"></span><span class="day-x"><b>${esc(x.t)}</b><em>${x.kind === 'focus' ? 'Focus' : esc(x.where || '')}${x.p ? ' · ' + esc(CLIENTS[PROJECTS[x.p].client].short) : ''}</em></span>${act}</li>`);
  });
  return `<ol class="day">${rows.join('')}</ol><p class="day-end">${ic('flag', 'xs')}Klaar rond 17:30 · 4 afspraken en 3 focusblokken</p>`;
}
function pick(app, f) {
  if (f.dec && (f.knot === 'wait' || f.knot === 'late')) return app.openDecision(f.dec);
  if (f.go) app.go(f.go);
}
SCREENS.vandaag = {
  html(app) {
    const n = app.state.decisions.filter(d => !d.done && !d.dismissed).length;
    return `<div class="vd">
      <header class="vd-hero">
        <div class="vd-hi">
          <p class="eyebrow rise" style="--r:0">${ic('sunrise', 'xs')}${DEMO.date} · week ${DEMO.week}</p>
          <h1 class="hello rise" style="--r:1">Goedemorgen, <span>Gerjan</span>.</h1>
          <p class="brief rise" style="--r:2">Rustige ochtend. Om <b>10:00</b> Joost over het kleurenpalet, om <b>13:30</b> de kennismaking bij Zonnetje. <span data-brief-dec>${briefDec(n)}</span></p>
        </div>
        <div class="rise" style="--r:2">${nuHtml(app)}</div>
      </header>
      <section class="panel glass vd-stream rise" style="--r:3" aria-labelledby="${app.uid}-st">
        <header class="ph"><div class="ph-t"><h2 id="${app.uid}-st">De stroom</h2><span class="pill">Oktober</span></div><p class="vd-sum">${streamSum(app)}</p></header>
        <div class="st-host"></div>
      </section>
      <section class="panel glass vd-deck rise" style="--r:4" aria-labelledby="${app.uid}-dk">
        <header class="ph"><div class="ph-t"><span class="orb sm"></span><h2 id="${app.uid}-dk">Te beslissen</h2><span class="pill gold" data-dcount${n ? '' : ' hidden'}>${n}</span></div><button type="button" class="btn btn-sm btn-ghost" data-go="gerrie">Beslismodus${ic('arrow-right', 'xs')}</button></header>
        ${deckHtml(app, false)}
      </section>
      <section class="panel glass vd-day rise" style="--r:5" aria-labelledby="${app.uid}-dy">
        <header class="ph"><div class="ph-t"><h2 id="${app.uid}-dy">Je dag</h2></div><div class="seg" role="group" aria-label="Wiens dag"><button type="button" aria-pressed="true">Mijn</button><button type="button" aria-pressed="false" data-team>Team</button></div></header>
        ${dayHtml()}
      </section>
    </div>`;
  },
  mount(app) {
    const host = app.root.querySelector('.st-host');
    app.stream = createStream(host, {
      mode: app.phone() ? 'mini' : 'app', flow: app.state.flow, label: 'De stroom van oktober: van gesprek tot betaald',
      onPick: f => pick(app, f), onStation: s => app.go(s.go),
      onHover: id => { const f = app.state.flow.find(x => x.id === id); app.root.querySelectorAll('.dk-card.k0').forEach(c => c.classList.toggle('linked', !!(f && f.dec === c.dataset.id))); },
    });
    app.bindDeck();
    app.root.querySelectorAll('[data-join]').forEach(b => b.addEventListener('click', () => app.island.note({ icon: 'video', tone: 'ok', text: 'Je doet mee aan Overleg Joost', sub: 'In de echte app opent nu Jitsi in een nieuw venster', ms: 3600 })));
    const team = app.root.querySelector('[data-team]');
    if (team) team.addEventListener('click', () => app.island.note({ icon: 'users', tone: 'muted', text: 'De dag van het team', sub: 'Sanne is tot 14:00 bij Bloem · Daan zit in de studio', ms: 3600 }));
  },
};
// De timer in de Nu-kaart loopt met het eiland mee
function nuTick(app, sec, pct) {
  const c = app.root.querySelector('[data-nu-clock]'); if (!c) return;
  c.textContent = `${Math.floor(sec / 3600)}:${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}`;
  const b = app.root.querySelector('[data-nu-bar]'); if (b) b.style.width = pct + '%';
}

/* ── Gerrie: beslismodus ────────────────────────────────────────────────── */
SCREENS.gerrie = {
  html(app) {
    const n = app.state.decisions.filter(d => !d.done && !d.dismissed).length;
    return `<div class="gr">
      <header class="sh rise" style="--r:0"><div><p class="eyebrow">${ic('sparkles', 'xs i-ai')}Gerrie · beslismodus</p><h1>Te beslissen</h1><p class="sh-s"><b>${n} ${n === 1 ? 'voorstel' : 'voorstellen'}</b> voor jou. Beslis met een klik, veeg met je duim, of gebruik <kbd>A</kbd> akkoord, <kbd>L</kbd> later en <kbd>N</kbd> niet meer.</p></div><button type="button" class="btn" aria-disabled="true" title="In dit voorstel niet uitgewerkt">${ic('bot')}Nieuwe agent</button></header>
      <div class="gr-grid">
        <section class="gr-main rise" style="--r:1" aria-label="De stapel">${deckHtml(app, true)}<p class="gr-safe">${ic('shield-check', 'xs')}Uitvoeren gebeurt onder jouw account, met jouw rechten. Een mail gaat pas na tien seconden de deur uit; tot die tijd haal je hem terug in het eiland.</p></section>
        <aside class="gr-side">
          <section class="panel glass rise" style="--r:2" aria-labelledby="${app.uid}-ag"><header class="ph"><div class="ph-t"><h2 id="${app.uid}-ag">Je agents</h2></div><span class="ph-m">3 actief</span></header>
            <ul class="ag-l">${AGENTS.map(a => `<li class="${a.idle ? 'idle' : ''}"><span class="ag-orb${a.run ? ' run' : ''}">${ic(a.icon, 'sm')}</span><span><b>${a.name}</b><em>${a.when}</em></span><span class="ag-st">${a.st}</span></li>`).join('')}</ul></section>
          <section class="panel glass rise" style="--r:3" aria-labelledby="${app.uid}-tm"><header class="ph"><div class="ph-t"><h2 id="${app.uid}-tm">Bij je team</h2></div></header>
            <ul class="tm-l">${TEAM_DECISIONS.map(t => `<li><span class="av ${t.owner === 'Sanne' ? 'av-sb' : 'av-db'}" style="--s:26px">${t.owner === 'Sanne' ? 'SB' : 'DB'}</span><span><b>${esc(t.title)}</b><em>${t.owner} · ${t.agent} · ${esc(t.why)}</em></span></li>`).join('')}</ul></section>
          <section class="panel glass rise gr-month" style="--r:4" aria-labelledby="${app.uid}-mo"><header class="ph"><div class="ph-t"><h2 id="${app.uid}-mo">Deze maand</h2></div></header>
            <dl><div><dt>Voorstellen</dt><dd>31</dd></div><div><dt>Goedgekeurd</dt><dd>26 · 84%</dd></div><div><dt>Tijd bespaard</dt><dd>± 6 uur</dd></div></dl></section>
        </aside>
      </div>
    </div>`;
  },
  mount(app) { app.bindDeck(); },
};

/* ── Agenda: de week, en Gerrie die ruimte zoekt ────────────────────────── */
const DAYS = [['ma', 19], ['di', 20], ['wo', 21], ['do', 22], ['vr', 23]];
function weekEvents(app) {
  const ev = WEEK.map(w => ({ ...w }));
  TODAY.forEach(x => ev.push({ d: 3, s: x.s, e: x.e, t: x.t, w: x.kind === 'focus' ? 'Focus' : (x.where || ''), c: colorOf(x), focus: x.kind === 'focus' }));
  return ev.concat(app.state.plannedEv || []);
}
const evHtml = (x, cls = '') => `<div class="ev${x.focus ? ' focus' : ''}${x.e - x.s <= 30 ? ' tiny' : ''}${cls ? ' ' + cls : ''}" style="--c:${x.c};--s:${x.s};--e:${x.e}" data-ev="${x.id || ''}"><b>${esc(x.t)}</b><span>${hhmm(x.s)} – ${hhmm(x.e)}${x.w ? ' · ' + esc(x.w) : ''}</span></div>`;
SCREENS.agenda = {
  html(app) {
    const ev = weekEvents(app);
    const tray = TRAY.filter(t => !(app.state.placed || []).includes(t.id));
    const later = (app.state.placed || []).includes('p3');
    return `<div class="ag">
      <header class="sh rise" style="--r:0"><div><p class="eyebrow">${ic('calendar', 'xs')}Agenda · week ${DEMO.week}</p><h1>19 – 23 oktober</h1><p class="sh-s">Deze week <b>26,5 van 32 uur</b> gepland. Vrijdag heeft nog <b>2 vrije momenten</b>.</p></div>
        <div class="sh-r"><div class="seg" role="group" aria-label="Weergave"><button type="button" aria-pressed="false" aria-disabled="true">Dag</button><button type="button" aria-pressed="true">Week</button><button type="button" aria-pressed="false" aria-disabled="true">Maand</button></div>
        <button type="button" class="btn btn-ai" data-plan${tray.length ? '' : ' disabled'}>${ic('wand-sparkles', 'i-ai')}Plan met Gerrie</button></div></header>
      <div class="ag-grid">
        <section class="panel glass wk rise" style="--r:1" aria-label="Week 43">
          <div class="wk-h"><span></span>${DAYS.map(([d, n], i) => `<span class="${i === 3 ? 'today' : ''}">${d} <b>${n}</b></span>`).join('')}</div>
          <div class="wk-b">
            <div class="wk-t">${Array.from({ length: 10 }, (_, i) => `<span>${String(8 + i).padStart(2, '0')}:00</span>`).join('')}</div>
            ${DAYS.map((_, d) => `<div class="wk-d${d === 3 ? ' today' : ''}${d < 3 ? ' past' : ''}" data-day="${d}">${ev.filter(x => x.d === d).sort((a, b) => a.s - b.s).map(x => evHtml(x, x.planned ? 'planned' : '')).join('')}${d === 3 ? `<i class="wk-now" style="--s:${DEMO.now}"><span>${hhmm(DEMO.now)}</span></i>` : ''}</div>`).join('')}
          </div>
        </section>
        <aside class="panel glass tray rise" style="--r:2" aria-labelledby="${app.uid}-tr">
          <header class="ph"><div class="ph-t"><h2 id="${app.uid}-tr">Nog in te plannen</h2><span class="pill" data-tray-n>${tray.length}</span></div></header>
          <ul class="tray-l">${tray.map(t => `<li class="tray-i" data-t="${t.id}" style="--c:${PROJECTS[t.p].color}"><span class="tray-g" aria-hidden="true">${ic('grip-vertical', 'sm')}</span><span class="tray-x"><b>${esc(t.t)}</b><em>${dur(t.est)} · ${esc(t.due)}</em></span></li>`).join('')}</ul>
          ${tray.length ? `<p class="tray-h">Sleep een taak naar een vrij moment, of laat Gerrie het doen. Hij houdt rekening met je deadlines, je focusblokken en de lunch.</p>` : `<p class="tray-h done">${ic('check-check', 'sm')}Alles staat erin.</p>`}
          <div class="tray-next"${later ? '' : ' hidden'}><span>${ic('calendar-clock', 'xs')}Volgende week</span><b>Teksten homepage</b><em>maandag 26 okt · 09:30 – 11:00</em></div>
        </aside>
      </div>
    </div>`;
  },
  mount(app, arg, o) {
    const btn = app.root.querySelector('[data-plan]');
    if (btn) btn.addEventListener('click', () => planWithGerrie(app));
    bindDrag(app);
    if (o && o.plan) setTimeout(() => planWithGerrie(app), reducedMotion() ? 0 : 650);
  },
};
function planWithGerrie(app) {
  const todo = TRAY.filter(t => !(app.state.placed || []).includes(t.id));
  if (!todo.length) return;
  const btn = app.root.querySelector('[data-plan]'); if (btn) btn.disabled = true;
  app.island.note({ icon: 'wand-sparkles', tone: 'ai', think: true, text: 'Gerrie zoekt ruimte in je week', sub: 'Deadlines, focusblokken en de lunch', ms: 1300 });
  app.light.aurora(1.7);
  const placed = [];
  setTimeout(() => {
    app.light.aurora(1);
    todo.forEach((t, k) => setTimeout(() => {
      const li = app.root.querySelector(`.tray-i[data-t="${t.id}"]`);
      if (!li) return;
      if (t.plan.next) {
        const nx = app.root.querySelector('.tray-next');
        nx.hidden = false;
        moveGhost(li, nx, () => { li.remove(); count(); });
      } else {
        const col = app.root.querySelector(`.wk-d[data-day="${t.plan.d}"]`);
        const x = { id: t.id, d: t.plan.d, s: t.plan.s, e: t.plan.s + t.est, t: t.t, w: 'Focus · door Gerrie', c: PROJECTS[t.p].color, focus: true, planned: true };
        col.insertAdjacentHTML('beforeend', evHtml(x, 'planned fresh'));
        const evEl = col.lastElementChild;
        evEl.style.opacity = 0;
        moveGhost(li, evEl, () => { evEl.style.opacity = ''; li.remove(); count(); });
        placed.push(x);
      }
      app.state.placed = (app.state.placed || []).concat(t.id);
    }, k * 320));
    setTimeout(() => {
      app.state.plannedEv = (app.state.plannedEv || []).concat(placed);
      app.island.note({ icon: 'calendar-plus', tone: 'ok', text: '2 taken ingepland, 1 naar maandag', sub: 'Vrijdag 13:00 en 16:00', undo: { secs: 8, verb: 'boek', onUndo: () => { app.state.plannedEv = (app.state.plannedEv || []).filter(x => !placed.includes(x)); app.state.placed = []; app.render({}); }, doneText: 'Je week staat', doneSub: 'De blokken staan in je agenda als focus' } });
    }, todo.length * 320 + 700);
  }, reducedMotion() ? 0 : 1100);
  function count() { const n = app.root.querySelectorAll('.tray-i').length; const p = app.root.querySelector('[data-tray-n]'); if (p) p.textContent = n; if (!n) { const h = app.root.querySelector('.tray-h'); if (h) { h.classList.add('done'); h.innerHTML = `${ic('check-check', 'sm')}Alles staat erin.`; } } }
}
// Een spook van de taak zweeft van het bakje naar zijn plek
function moveGhost(from, to, done) {
  if (reducedMotion()) { done(); return; }
  const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const g = from.cloneNode(true);
  g.classList.add('tray-ghost');
  Object.assign(g.style, { position: 'fixed', left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', margin: 0, zIndex: 9999, pointerEvents: 'none' });
  document.body.appendChild(g);
  from.style.visibility = 'hidden';
  g.animate([
    { transform: 'translate(0,0)', width: a.width + 'px', height: a.height + 'px', boxShadow: '0 0 0 1px var(--ai-line), 0 0 0 0 var(--ai-1)' },
    { transform: `translate(${(b.left - a.left) * .5}px,${(b.top - a.top) * .5 - 30}px)`, offset: .45, boxShadow: '0 0 0 1px var(--ai-line), 0 18px 40px -12px var(--ai-1)' },
    { transform: `translate(${b.left - a.left}px,${b.top - a.top}px)`, width: b.width + 'px', height: b.height + 'px', boxShadow: '0 0 0 1px var(--ai-line), 0 0 0 0 var(--ai-1)' },
  ], { duration: 760, easing: 'cubic-bezier(.55,0,.2,1)' }).finished.then(() => { g.remove(); done(); });
}
// Slepen uit het bakje naar een dag, op een kwartier nauwkeurig
function bindDrag(app) {
  const root = app.root;
  root.querySelectorAll('.tray-i').forEach(li => {
    li.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const t = TRAY.find(x => x.id === li.dataset.t);
      const a = li.getBoundingClientRect();
      const g = li.cloneNode(true); g.classList.add('tray-ghost', 'dragging');
      Object.assign(g.style, { position: 'fixed', left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', margin: 0, zIndex: 9999, pointerEvents: 'none' });
      document.body.appendChild(g);
      const ox = e.clientX - a.left, oy = e.clientY - a.top;
      li.style.opacity = .35;
      let ph = null, slot = null;
      const move = ev => {
        g.style.left = (ev.clientX - ox) + 'px'; g.style.top = (ev.clientY - oy) + 'px';
        const col = document.elementsFromPoint(ev.clientX, ev.clientY).find(n => n.classList && n.classList.contains('wk-d'));
        if (ph && (!col || ph.parentNode !== col)) { ph.remove(); ph = null; slot = null; }
        if (col && +col.dataset.day >= 3) {
          const r = col.getBoundingClientRect();
          const hr = r.height / 10;
          let s = 480 + Math.round(((ev.clientY - oy + 6 - r.top) / hr * 60) / 15) * 15;
          s = Math.max(480, Math.min(1080 - t.est, s));
          slot = { d: +col.dataset.day, s };
          if (!ph) { col.insertAdjacentHTML('beforeend', `<div class="ev drop" style="--c:${PROJECTS[t.p].color};--s:${s};--e:${s + t.est}"><b>${esc(t.t)}</b><span></span></div>`); ph = col.lastElementChild; }
          ph.style.setProperty('--s', s); ph.style.setProperty('--e', s + t.est);
          ph.querySelector('span').textContent = `${hhmm(s)} – ${hhmm(s + t.est)}`;
        }
      };
      const up = () => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', up);
        g.remove(); li.style.opacity = '';
        if (ph) ph.remove();
        if (slot) {
          const x = { id: t.id, d: slot.d, s: slot.s, e: slot.s + t.est, t: t.t, w: 'Focus', c: PROJECTS[t.p].color, focus: true, planned: true };
          app.state.plannedEv = (app.state.plannedEv || []).concat(x);
          app.state.placed = (app.state.placed || []).concat(t.id);
          app.render({});
          app.island.note({ icon: 'calendar-plus', tone: 'ok', text: `${t.t} staat erin`, sub: `${DAYS[slot.d][0]} ${DAYS[slot.d][1]} okt · ${hhmm(slot.s)} – ${hhmm(slot.s + t.est)}`, ms: 3000 });
        }
      };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
      e.preventDefault();
    });
  });
}

/* ── Werk: klanten ──────────────────────────────────────────────────────── */
const CL_LINE = {
  korenaar: ['Werk · huisstijl 35%', null], fysio: ['Betaald · oplevering 1 nov', null], vandijk: ['Offerte · wacht 9 dagen', 'wait'],
  zonnetje: ['Gesprek · kennismaking 13:30', null], bloem: ['Factuur · 10 dagen te laat', 'late'], hendriks: ['Niet in de stroom · stil sinds juni', null],
};
SCREENS.werk = {
  html(app) {
    const total = Object.values(CLIENTS).reduce((a, c) => a + c.value, 0);
    return `<div class="wr">
      <header class="sh rise" style="--r:0"><div><p class="eyebrow">${ic('folder-kanban', 'xs')}Werk</p><h1>Klanten</h1><p class="sh-s">6 klanten, 4 actief. Samen <b>${eur(total, true)}</b> relatiewaarde. Twee hebben een knoop in hun stroom.</p></div>
        <div class="sh-r"><button type="button" class="btn" data-ask="Wat staat er nog open bij Restaurant Bloem?">${ic('sparkles', 'i-ai')}Vraag over een klant</button><button type="button" class="btn btn-gold" aria-disabled="true" title="In dit voorstel niet uitgewerkt">${ic('plus')}Nieuwe klant</button></div></header>
      <nav class="lens rise" style="--r:1" aria-label="Werk"><button type="button" aria-current="page">Klanten<span>6</span></button><button type="button" aria-disabled="true">Projecten<span>5</span></button><button type="button" aria-disabled="true">Planning</button><button type="button" aria-disabled="true">Tickets<span>2</span></button><button type="button" aria-disabled="true">Archief</button></nav>
      <div class="cl-grid">${Object.entries(CLIENTS).map(([id, c], i) => {
        const [txt, knot] = CL_LINE[id];
        return `<button type="button" class="cl-card glass sheen rise" style="--r:${2 + i};--c:${c.color}" data-go="klant:${id}" data-morph-from aria-label="${esc(c.name)}, ${esc(txt)}">
          <span class="cl-top"><span class="cl-ini" data-morph-src>${c.ini}</span><span class="pill ${c.status === 'Actief' ? 'ok' : c.status === 'Prospect' ? 'info' : ''}">${c.status}</span></span>
          <span class="cl-n">${esc(c.name)}</span><span class="cl-s">${esc(c.contact)} · ${c.code}</span>
          <span class="cl-st">${streamLine(c.st, c.color, { knot })}<em class="${knot || ''}">${esc(txt)}</em></span>
          <span class="cl-v"><b>${eur(c.value, true)}</b> relatiewaarde</span>
        </button>`;
      }).join('')}</div>
    </div>`;
  },
};

/* ── Klant 360 ──────────────────────────────────────────────────────────── */
function c360(id) {
  if (C360[id]) return C360[id];
  const c = CLIENTS[id];
  const i = c.st ? STATIONS.findIndex(s => s.id === c.st) : -1;
  const base = {
    fysio: [['Kennismaking', 'maart', 1], ['Offerte 2026-012', '€ 6.292 · akkoord', 1], ['Website', '72% · oplevering 1 nov', 1], ['Factuur 2026-039', '€ 6.292 · betaald', 1], ['€ 6.292 binnen', '21 oktober', 2]],
    vandijk: [['Belafspraak', '8 oktober', 1], ['Offerte 2026-020', '€ 3.327,50 · 9 dagen', 2], ['Winteractie', 'start na akkoord', 0], ['—', '', 0], ['—', '', 0]],
    zonnetje: [['Kennismaking', 'vandaag 13:30', 2], ['Offerte 2026-021', 'in de maak · € 4.452,80', 0], ['—', '', 0], ['—', '', 0], ['—', '', 0]],
    hendriks: [['Laatste contact', 'juni', 1], ['—', '', 0], ['—', '', 0], ['—', '', 0], ['—', '', 0]],
  }[id];
  const knot = id === 'vandijk' ? 'wait' : null;
  return {
    line: base.map(([t, s, st], k) => ({ st: STATIONS[k].id, t, s, done: st === 1, now: st === 2, knot: st === 2 ? knot : null })),
    gerrie: { fysio: 'Maria betaalde de oplevering binnen vijf dagen. Het ticket <b>“Website laadt traag op mobiel”</b> staat nog open; Sanne heeft een antwoord klaar. Goed moment om een <b>onderhoudscontract</b> voor te stellen.', vandijk: 'Peter opende de offerte <b>drie keer</b>, laatst gisteren om 21:14, maar reageerde niet. Je belt hem vanmiddag om <b>16:30</b>; neem de planning van de winteractie mee.', zonnetje: 'Els vroeg om een <b>huisstijl en drukwerk</b> voor twee locaties. De kennismaking is vandaag om <b>13:30</b>; de conceptofferte staat klaar om samen door te nemen.', hendriks: 'Al <b>vier maanden</b> geen contact. Willem gaf in juni aan dat de nieuwe website “na de zomer” zou komen. Zal ik een korte mail klaarzetten?' }[id],
    acts: [['Vraag Gerrie', 'sparkles', 'ai'], ['Mail', 'mail', '']],
    stats: [['Relatiewaarde', eur(c.value, true)], ['Openstaand', '€ 0'], ['Lopend werk', i >= 2 ? '1 project' : '—'], ['Relatiepuls', id === 'hendriks' ? 'Koel' : 'Warm']],
    pulse: id === 'hendriks' ? [6, 5, 4, 3, 2, 1, 1, 1] : [2, 3, 3, 4, 5, 5, 6, 7],
    project: null, money: null,
  };
}
SCREENS.klant = {
  html(app, id) {
    const c = CLIENTS[id]; if (!c) return SCREENS.niet.html(app);
    const x = c360(id);
    const tl = TIMELINE[id];
    const filters = [['alles', 'Alles'], ['mail', 'Mail en chat'], ['geld', 'Geld'], ['agenda', 'Agenda']];
    const pulse = x.pulse; const pm = Math.max(...pulse);
    const spark = `<svg class="k3-spark" viewBox="0 0 80 24" aria-hidden="true"><path d="${pulse.map((v, k) => `${k ? 'L' : 'M'}${(k / (pulse.length - 1) * 78 + 1).toFixed(1)},${(22 - v / pm * 19).toFixed(1)}`).join('')}"/></svg>`;
    return `<div class="k3" style="--c:${c.color}">
      <header class="k3-hero rise" style="--r:0">
        <span class="k3-ini" data-morph>${c.ini}</span>
        <div class="k3-hi"><h1>${esc(c.name)}</h1>
          <p class="k3-meta"><span class="pill ${c.status === 'Actief' ? 'ok' : c.status === 'Prospect' ? 'info' : ''}">${c.status}</span><span>${c.code}</span><span>${esc(c.contact)}, ${esc(c.role)}</span><span>${esc(c.city)}</span>${c.tags.map(t => `<span class="pill">${t}</span>`).join('')}</p></div>
        <div class="k3-acts"><button type="button" class="btn">${ic('phone')}Bellen</button><button type="button" class="btn">${ic('mail')}Mail</button><button type="button" class="btn btn-gold" data-ask="factuur ${id === 'korenaar' ? 'korenaar' : c.short.toLowerCase()} ">${ic('plus')}Nieuw</button></div>
      </header>
      <section class="panel glass k3-line rise" style="--r:1" aria-label="Waar ${esc(c.short)} staat in de stroom">
        <ol class="kl" style="--fill:${(Math.max(0, ...x.line.map((s, k) => s.done || s.now ? k : 0)) / 4 * 80).toFixed(1)}%">${x.line.map((s, k) => `<li class="${s.done ? 'done' : ''}${s.now ? ' now' : ''}${s.knot ? ' knot-' + s.knot : ''}"><span class="kl-d" aria-hidden="true"></span><span class="kl-l">${STATIONS[k].label}</span><b>${esc(s.t)}</b><em>${esc(s.s)}</em></li>`).join('')}</ol>
      </section>
      <div class="k3-stats rise" style="--r:2">${x.stats.map(([a, b], k) => `<div class="k3-stat glass"><span>${a}</span><b class="amt">${b}</b>${k === 3 ? spark : ''}</div>`).join('')}</div>
      <div class="k3-grid">
        <section class="panel glass k3-tl rise" style="--r:3" aria-labelledby="${app.uid}-tl">
          <header class="ph"><div class="ph-t"><h2 id="${app.uid}-tl">Tijdlijn</h2><span class="ph-m">mail, chat, agenda en geld op één lijn</span></div>
            <div class="seg" role="group" aria-label="Filter">${filters.map(([v, t]) => `<button type="button" data-tl="${v}" aria-pressed="${app.state.tl === v}">${t}</button>`).join('')}</div></header>
          ${tl ? `<ol class="tl">${tl.map(g => `<li class="tl-g"><p class="tl-day">${g.day}</p><ol>${g.items.map(it => `<li class="tl-i" data-k="${it.k}"><span class="tl-ic ${it.cls || ''}">${ic(it.ic, 'sm')}</span><span class="tl-x"><span>${it.t}</span><em>${esc(it.s)}</em>${it.q ? `<q>${esc(it.q.replace(/[“”]/g, ''))}</q>` : ''}</span><time>${it.time}</time></li>`).join('')}</ol></li>`).join('')}</ol>` : `<p class="tl-empty">${ic('history', 'sm')}De tijdlijn van ${esc(c.short)} is in dit voorstel niet uitgewerkt; hij volgt de opbouw van De Korenaar.</p>`}
        </section>
        <aside class="k3-side">
          <section class="panel glass k3-ai rise" style="--r:4" aria-labelledby="${app.uid}-ai"><header class="ph"><div class="ph-t"><span class="orb sm"></span><h2 id="${app.uid}-ai">Gerrie over ${esc(c.short)}</h2></div></header>
            <p>${x.gerrie}</p>
            <div class="k3-aa">${x.acts.map(([t, i, k]) => `<button type="button" class="btn btn-sm ${k === 'ai' ? 'btn-ai' : ''}" ${k === 'ai' ? `data-ask="${id === 'bloem' ? 'Wat staat er nog open bij Restaurant Bloem?' : 'Wat speelt er bij ' + esc(c.short) + '?'}"` : ''}>${ic(i, k === 'ai' ? 'i-ai' : '')}${t}</button>`).join('')}</div></section>
          ${x.project ? `<section class="panel glass k3-pj rise" style="--r:5" aria-label="Project"><header class="ph"><div class="ph-t"><i class="k3-dot"></i><h2>${esc(x.project.name)}</h2></div></header>
            <div class="k3-pr"><span class="ring" style="--p:${x.project.pct}"><b>${x.project.pct}%</b></span><span><b>${x.project.hours}</b><em>${x.project.due}</em><span class="avs">${x.project.team.map(t => `<span class="av ${t === 'sb' ? 'av-sb' : t === 'db' ? 'av-db' : ''}" style="--s:24px">${t.toUpperCase()}</span>`).join('')}</span></span></div></section>` : ''}
          ${x.money ? `<section class="panel glass k3-mo rise" style="--r:6" aria-label="Geld"><header class="ph"><div class="ph-t"><h2>Geld</h2></div></header>
            <dl>${x.money.map(([a, b, t, s]) => `<div><dt>${a}</dt><dd><b class="amt">${b}</b>${s ? `<span class="pill ${t}">${s}</span>` : ''}</dd></div>`).join('')}</dl></section>` : ''}
        </aside>
      </div>
    </div>`;
  },
  mount(app) {
    app.root.querySelectorAll('[data-tl]').forEach(b => b.addEventListener('click', () => {
      app.state.tl = b.dataset.tl;
      app.root.querySelectorAll('[data-tl]').forEach(x => x.setAttribute('aria-pressed', x === b));
      app.root.querySelectorAll('.tl-i').forEach(li => { li.hidden = app.state.tl !== 'alles' && li.dataset.k !== app.state.tl; });
      app.root.querySelectorAll('.tl-g').forEach(g => { g.hidden = ![...g.querySelectorAll('.tl-i')].some(li => !li.hidden); });
    }));
  },
};

/* ── Geld: de geldstroom, facturen en het papier ────────────────────────── */
function cashSvg(W, H) {
  const pl = 52, pr = 18, pt = 30, pb = 26;
  const x = d => pl + (d + 30) / 60 * (W - pl - pr);
  const lo = 7000, hi = 19500;
  const y = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const step = pts => pts.map(([d, v], i) => i ? `H${x(d).toFixed(1)}V${y(v).toFixed(1)}` : `M${x(d).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const past = step(CASH.past), fut = step(CASH.future);
  const band = (() => {
    const up = [], dn = [];
    CASH.future.forEach(([d, v], i) => { const w = d / 30 * 1300; if (i) { up.push(`H${x(d).toFixed(1)}V${y(v + w).toFixed(1)}`); dn.unshift(`V${y(CASH.future[i - 1][1] - (CASH.future[i - 1][0] / 30 * 1300)).toFixed(1)}H${x(CASH.future[i - 1][0]).toFixed(1)}`); dn.unshift(`V${y(v - w).toFixed(1)}`); } else up.push(`M${x(d).toFixed(1)},${y(v).toFixed(1)}`); });
    return up.join('') + dn.join('') + 'Z';
  })();
  const grid = [10000, 14000, 18000].map(v => `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 10}" y="${y(v) + 4}" text-anchor="end">€ ${v / 1000}k</text>`).join('');
  const xl = [[-30, '22 sep'], [-15, '7 okt'], [0, 'vandaag'], [15, '6 nov'], [30, '21 nov']].map(([d, t]) => `<text x="${x(d)}" y="${H - 6}" text-anchor="${d === -30 ? 'start' : d === 30 ? 'end' : 'middle'}"${d === 0 ? ' class="now"' : ''}>${t}</text>`).join('');
  const marks = CASH.future.filter(f => f[2]).map(([d, v, t, who]) => { const up = t.startsWith('+'); return `<g class="cs-m ${up ? 'in' : 'out'}"><circle cx="${x(d)}" cy="${y(v)}" r="3.5"/><text x="${x(d)}" y="${y(v) + (up ? -11 : 19)}" text-anchor="middle">${t} <tspan>${who}</tspan></text></g>`; }).join('');
  return `<svg class="cash-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Saldo: 30 dagen terug van € 10.730 naar € 14.380 vandaag; over 30 dagen naar verwachting € 17.990">
    <defs><linearGradient id="cg-${W}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--flow-2)" stop-opacity=".32"/><stop offset="1" stop-color="var(--flow-2)" stop-opacity="0"/></linearGradient></defs>
    <g class="cs-g">${grid}</g>
    <path class="cs-b" d="${band}"/>
    <path class="cs-a" d="${past}V${H - pb}H${x(-30)}Z" fill="url(#cg-${W})"/>
    <path class="cs-p" d="${past}"/>
    <path class="cs-f" d="${fut}"/>
    <line class="cs-n" x1="${x(0)}" x2="${x(0)}" y1="${pt - 8}" y2="${H - pb}"/>
    ${marks}
    <circle class="cs-d" cx="${x(0)}" cy="${y(CASH.now)}" r="5"/>
    <g class="cs-x">${xl}</g>
  </svg>`;
}
function invRow(i, open) {
  const c = CLIENTS[i.c]; const [lab, tone] = INV_ST[i.st];
  const rem = i.n === '2026-040' && i.st === 'late';
  return `<tr class="${i.fresh ? 'fresh' : ''}${open === i.n ? ' is-open' : ''}"${open === i.n ? ' aria-current="true"' : ''}>
    <td><button type="button" class="tb-n" data-go="factuur:${i.n}" data-morph-from><span data-morph-src>${i.n}</span></button></td>
    <td><span class="tb-c"><i style="background:${c.color}"></i>${esc(c.short)}</span></td>
    <td class="tb-d">${esc(i.d)}</td>
    <td class="tb-due">${i.due}</td>
    <td class="r"><b class="amt">${eur(i.amt)}</b></td>
    <td><span class="pill ${tone}">${lab}</span>${rem ? `<span class="pill ai tb-ai">${ic('sparkles', 'xs i-ai')}herinnering klaar</span>` : i.fresh ? `<span class="pill ai tb-ai">${ic('sparkles', 'xs i-ai')}door Gerrie</span>` : ''}</td>
  </tr>`;
}
function quoteRow(q) {
  const c = CLIENTS[q.c]; const [lab, tone] = Q_ST[q.st];
  return `<tr><td><span class="tb-n static">${q.n}</span></td><td><span class="tb-c"><i style="background:${c.color}"></i>${esc(c.short)}</span></td><td class="tb-d">${esc(q.d)}</td><td class="tb-due">${q.date}</td><td class="r"><b class="amt">${eur(q.amt)}</b></td><td><span class="pill ${tone}">${lab}</span>${q.n === '2026-020' ? `<span class="pill ai tb-ai">${ic('sparkles', 'xs i-ai')}opvolgmail klaar</span>` : ''}</td></tr>`;
}
function paperHtml(app, i) {
  const c = CLIENTS[i.c]; const [lab, tone] = INV_ST[i.st];
  const vat = Math.round(i.ex * 21) / 100;
  const tl = i.st === 'concept' ? [['circle-dashed', 'Concept', i.note]] : [['send', 'Verstuurd', i.sent], ...(i.n === '2026-041' ? [['mail-open', 'Twee keer geopend', 'laatst gisteren 16:40']] : []), ...(i.st === 'late' ? [['triangle-alert', 'Vervallen', '12 oktober · 10 dagen geleden'], ['sparkles', 'Herinnering klaar', 'Debiteurenbewaker · 08:30']] : []), ...(i.st === 'paid' ? [['circle-check', 'Betaald', i.note.replace('Betaald ', '')]] : [])];
  return `<aside class="pp rise" style="--r:1" aria-label="Factuur ${i.n}">
    <div class="pp-bar"><b>Factuur ${i.n}</b><span class="pill ${tone}">${lab}</span><span class="pp-sp"></span><button type="button" class="icon-btn" data-go="geld:facturen" aria-label="Sluiten">${ic('x', 'sm')}</button></div>
    <div class="pp-stage"><div class="paper" data-morph>
      <div class="pa-h"><span class="pa-logo">SL</span><div><b>Studio Lopik B.V.</b><span>Kerkstraat 12<br>3411 AB Lopik</span></div><div class="pa-t"><b>Factuur</b><span>${i.n}</span></div></div>
      <div class="pa-to"><div><span>Aan</span><b>${esc(c.name)}</b><em>t.a.v. ${esc(c.contact)}<br>Lopik</em></div><div><span>Factuurdatum</span><b>${i.date === '—' ? '22 okt 2026' : i.date + ' 2026'}</b><span>Vervaldatum</span><b>${i.due === '—' ? '5 nov 2026' : i.due + ' 2026'}</b></div></div>
      <table class="pa-l"><thead><tr><th>Omschrijving</th><th>Aantal</th><th>Prijs</th><th>Btw</th><th>Bedrag</th></tr></thead><tbody><tr><td>${esc(i.d)}</td><td>1</td><td>${eurTxt(i.ex)}</td><td>21%</td><td>${eurTxt(i.ex)}</td></tr></tbody></table>
      <div class="pa-tot"><div><span>Subtotaal</span><span>${eurTxt(i.ex)}</span></div><div><span>Btw 21%</span><span>${eurTxt(vat)}</span></div><div class="pa-sum"><span>Te betalen</span><b>${eurTxt(i.amt)}</b></div></div>
      <p class="pa-pay">Betaal binnen 14 dagen op NL12 ABNA 0123 4567 89 t.n.v. Studio Lopik B.V. o.v.v. ${i.n}, of direct met iDEAL via de link in de mail.</p>
      <p class="pa-f">KvK 12345678 · btw NL123456789B01 · info@studiolopik.nl</p>
      ${i.st === 'paid' ? '<span class="pa-stamp">Betaald</span>' : ''}
    </div></div>
    <div class="pp-acts">${i.st === 'late' && !app.state.paid ? `<button type="button" class="btn btn-ai" data-go="gerrie">${ic('bell-ring', 'i-ai')}Herinnering bekijken</button>` : ''}${i.st !== 'paid' ? `<button type="button" class="btn" data-mark-paid="${i.n}">${ic('circle-check')}Markeer betaald</button>` : ''}<button type="button" class="btn btn-ghost">${ic('download')}Pdf</button><button type="button" class="btn btn-ghost">${ic('link')}Betaallink</button></div>
    <ol class="pp-tl">${tl.map(([ico, t, s]) => `<li><span>${ic(ico, 'xs' + (ico === 'sparkles' ? ' i-ai' : ''))}</span><b>${t}</b><em>${esc(s || '')}</em></li>`).join('')}</ol>
  </aside>`;
}
SCREENS.geld = {
  html(app, lens, nr) {
    lens = lens || 'facturen';
    const inv = app.state.invoices;
    const open = inv.filter(i => i.st === 'open' || i.st === 'late');
    const openSum = open.reduce((a, i) => a + i.amt, 0);
    const late = inv.filter(i => i.st === 'late');
    const counts = { alles: inv.length, open: open.length, late: late.length, concept: inv.filter(i => i.st === 'concept').length, paid: inv.filter(i => i.st === 'paid').length };
    const f = app.state.filter;
    const rows = inv.filter(i => f === 'alles' || (f === 'open' ? (i.st === 'open' || i.st === 'late') : i.st === f));
    const paper = nr ? inv.find(i => i.n === nr) : null;
    const chip = (v, t) => counts[v] || v === 'alles' ? `<button type="button" class="chipf" data-f="${v}" aria-pressed="${f === v}">${t}<span>${counts[v]}</span></button>` : '';
    return `<div class="gd${paper ? ' has-paper' : ''}">
      <header class="sh rise" style="--r:0"><div><p class="eyebrow">${ic('wallet', 'xs')}Geld · oktober</p><h1><span class="amt">${eur(openSum)}</span> onderweg</h1><p class="sh-s">${open.length} ${open.length === 1 ? 'factuur' : 'facturen'} open${late.length ? `, waarvan <b class="t-danger">${eur(late[0].amt)}</b> te laat` : ''}. Saldo <b>€ 14.380</b>; over 30 dagen naar verwachting <b>€ 17.990</b>.</p></div>
        <div class="sh-r"><button type="button" class="btn btn-gold" data-ask="factuur ">${ic('plus')}Nieuwe factuur</button></div></header>
      <nav class="lens rise" style="--r:1" aria-label="Geld"><button type="button" data-go="geld:offertes"${lens === 'offertes' ? ' aria-current="page"' : ''}>Offertes<span>${QUOTES.length}</span></button><button type="button" data-go="geld:facturen"${lens === 'facturen' ? ' aria-current="page"' : ''}>Facturen<span>${inv.length}</span></button><button type="button" aria-disabled="true">Inkoop<span>2</span></button><button type="button" aria-disabled="true">Bank</button><button type="button" aria-disabled="true">Boekhouding</button><button type="button" aria-disabled="true">Rapportage</button></nav>
      <div class="gd-main">
        <section class="panel glass gd-cash rise" style="--r:2" aria-labelledby="${app.uid}-cs">
          <header class="ph"><div class="ph-t"><h2 id="${app.uid}-cs">Geldstroom</h2><span class="ph-m">ABN AMRO zakelijk · bijgewerkt 09:30</span></div><span class="gd-leg"><i class="p"></i>Saldo<i class="f"></i>Verwacht</span></header>
          <div class="cash-host"></div>
        </section>
        <section class="panel glass gd-list rise" style="--r:3" aria-labelledby="${app.uid}-ls">
          ${lens === 'offertes' ? `<header class="ph"><div class="ph-t"><h2 id="${app.uid}-ls">Offertes</h2><span class="ph-m">${eur(QUOTES.filter(q => q.st === 'sent' || q.st === 'concept').reduce((a, q) => a + q.amt, 0), true)} in de pijplijn</span></div></header>
            <div class="tb-wrap"><table class="tb"><thead><tr><th>Nummer</th><th>Klant</th><th>Omschrijving</th><th>Datum</th><th class="r">Bedrag</th><th>Status</th></tr></thead><tbody>${QUOTES.map(quoteRow).join('')}</tbody></table></div>`
          : `<header class="ph"><div class="ph-t"><h2 id="${app.uid}-ls">Facturen</h2></div><div class="chips" role="group" aria-label="Filter">${chip('alles', 'Alles')}${chip('open', 'Openstaand')}${chip('late', 'Te laat')}${chip('concept', 'Concept')}${chip('paid', 'Betaald')}</div></header>
            <div class="tb-wrap"><table class="tb"><thead><tr><th>Nummer</th><th>Klant</th><th>Omschrijving</th><th>Vervalt</th><th class="r">Bedrag</th><th>Status</th></tr></thead><tbody>${rows.map(i => invRow(i, nr)).join('')}</tbody></table></div>
            <p class="tb-sum">${rows.length === inv.length ? `${inv.length} facturen` : `${rows.length} van ${inv.length} facturen`} · samen <b class="amt">${eur(rows.reduce((a, i) => a + i.amt, 0))}</b></p>`}
        </section>
      </div>
      ${paper ? paperHtml(app, paper) : ''}
    </div>`;
  },
  mount(app, lens) {
    const host = app.root.querySelector('.cash-host');
    const draw = () => { if (!host.isConnected) return; const w = Math.max(280, host.clientWidth); host.innerHTML = cashSvg(Math.round(w), app.phone() ? 170 : 196); };
    draw();
    app.redrawCash = draw;
    if (window.ResizeObserver) { const ro = new ResizeObserver(draw); ro.observe(host); }
    app.root.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { app.state.filter = b.dataset.f; app.render({}); }));
    const mp = app.root.querySelector('[data-mark-paid]');
    if (mp) mp.addEventListener('click', () => {
      const i = app.state.invoices.find(x => x.n === mp.dataset.markPaid);
      if (i.n === '2026-040') { app.pay(); return; }
      i.st = 'paid'; i.note = 'Betaald 22 okt'; app.render({});
      app.resonate(null, 1);
      app.island.note({ icon: 'hand-coins', tone: 'gold', text: `${eurTxt(i.amt)} binnen`, sub: `Factuur ${i.n} staat op betaald`, ms: 3600 });
    });
    // Het papier kantelt een fractie mee met je cursor; het licht glijdt erover
    const pa = app.root.querySelector('.paper');
    if (pa && !reducedMotion()) {
      const stage = pa.parentElement;
      stage.addEventListener('pointermove', e => { const r = stage.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5; pa.style.setProperty('--rx', (-py * 4).toFixed(2) + 'deg'); pa.style.setProperty('--ry', (px * 5).toFixed(2) + 'deg'); pa.style.setProperty('--gx', ((px + .5) * 100).toFixed(1) + '%'); });
      stage.addEventListener('pointerleave', () => { pa.style.setProperty('--rx', '0deg'); pa.style.setProperty('--ry', '0deg'); });
    }
  },
};
SCREENS.factuur = { html: (app, nr) => SCREENS.geld.html(app, 'facturen', nr), mount: app => SCREENS.geld.mount(app, 'facturen') };

/* ── Niet in dit voorstel ───────────────────────────────────────────────── */
const LATER = {
  berichten: ['inbox', 'Berichten', 'Klantmail, teamchat en marketing krijgen dezelfde opbouw als Vandaag: één regel per gesprek met de kleur van de klant ervoor, Gerrie die een antwoord klaarzet, en de tien seconden om terug te halen.'],
  inzicht: ['bar-chart-3', 'Inzicht', 'Statistieken, inhoud, notities en documenten lezen als de stroom: eerst een zin over wat er speelt, de cijfers erachter, en elk getal klikbaar tot de factuur of de uren waar het vandaan komt.'],
};
SCREENS.niet = {
  html(app) {
    const id = app.state.route.split(':')[0];
    const [i, t, s] = LATER[id] || ['compass', 'Niet gevonden', 'Dit scherm bestaat niet in het voorstel.'];
    return `<div class="nx"><div class="nx-c glass rise" style="--r:0"><span class="nx-i">${ic(i, 'lg')}</span><p class="eyebrow">In dit voorstel nog niet uitgewerkt</p><h1>${t}</h1><p>${s}</p><button type="button" class="btn" data-go="vandaag">${ic('arrow-left')}Terug naar Vandaag</button></div></div>`;
  },
};
SCREENS.berichten = SCREENS.niet;
SCREENS.inzicht = SCREENS.niet;

/* ── Inloggen: het eerste wat je ziet ───────────────────────────────────── */
SCREENS.login = {
  html(app) {
    return `<div class="lgn"><div class="lgn-stream rise" style="--r:3"></div>
      <section class="lgn-story">
        <div class="lgn-brand rise" style="--r:0"><span class="lg-r">R</span><b>ResoFly</b></div>
        <h1 class="rise" style="--r:1">Van eerste mail<br><span>tot betaalde factuur.</span></h1>
        <p class="rise" style="--r:2">Klanten, projecten, agenda, uren, offertes en facturen in één werkruimte. Met Gerrie, die meedenkt en klaarzet.</p>
      </section>
      <form class="lgn-card glass glass-3 rise" style="--r:2" novalidate>
        <h2>Welkom terug</h2>
        <p>Log in met je e-mailadres. Je krijgt een link; een wachtwoord is niet nodig.</p>
        <label for="${app.uid}-mail">E-mailadres</label>
        <input id="${app.uid}-mail" type="email" value="gerjan@studiolopik.nl" autocomplete="email">
        <button type="submit" class="btn btn-gold btn-lg">${ic('send')}Stuur magic link</button>
        <div class="lgn-sent" hidden><span>${ic('mail-check', 'lg')}</span><b>Kijk in je mail</b><p>We stuurden een link naar gerjan@studiolopik.nl. Open hem in deze browser.</p><button type="button" class="btn" data-open-link>${ic('mouse-pointer-click')}Open de link (demo)</button></div>
      </form>
    </div>`;
  },
  mount(app) {
    app.stream = createStream(app.root.querySelector('.lgn-stream'), { mode: 'hero', label: 'De stroom: van gesprek tot betaald' });
    const form = app.root.querySelector('.lgn-card');
    form.addEventListener('submit', e => { e.preventDefault(); form.classList.add('sent'); form.querySelector('.lgn-sent').hidden = false; form.querySelector('[data-open-link]').focus(); });
    form.querySelector('[data-open-link]').addEventListener('click', () => app.wake());
  },
};
