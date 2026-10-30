/* ══ Het prototype: de schil ════════════════════════════════════════════════
   Eén werkruimte als instantie: createApp(host, opts). De pagina zet er één
   groot neer en drie op telefoonformaat, elk met een eigen staat en thema.

   Opbouw: het lichtveld als grond, een rail van glas met de zeven modules van
   Zenit (op de telefoon een dock), het eiland bovenin, en het werkvlak met het
   scherm. Een ander scherm komt binnen met een View Transition; wat je opent
   (een factuur, een klant) groeit uit waar je op klikte. */

const MODULES = [
  { id: 'vandaag', label: 'Vandaag', ic: 'sunrise', key: 'V' },
  { id: 'gerrie', label: 'Gerrie', ic: 'sparkles', key: 'G', ai: true },
  { id: 'agenda', label: 'Agenda', ic: 'calendar', key: 'A' },
  { id: 'werk', label: 'Werk', ic: 'folder-kanban', key: 'W' },
  { id: 'geld', label: 'Geld', ic: 'wallet', key: 'F' },
  { id: 'berichten', label: 'Berichten', ic: 'inbox', key: 'B' },
  { id: 'inzicht', label: 'Inzicht', ic: 'bar-chart-3', key: 'I' },
];
// Wat er in een module zit. Zonder route: in dit voorstel niet uitgewerkt.
const MENU = {
  vandaag: [{ items: [['Overzicht', 'vandaag', 'layout-dashboard'], ['Te beslissen', 'gerrie', 'sparkles'], ['Mijn week', 'agenda', 'calendar-range']] }],
  gerrie: [{ items: [['Te beslissen', 'gerrie', 'sparkles'], ['Gesprekken', null, 'messages-square'], ['Agents', 'gerrie', 'bot'], ['Logboek', null, 'history']] }],
  agenda: [{ items: [['Week', 'agenda', 'calendar-range'], ['Boekingslinks', null, 'calendar-clock'], ['Uren', null, 'timer']] }],
  werk: [{ items: [['Klanten', 'werk', 'users'], ['Projecten', null, 'folder-open'], ['Planningstimeline', null, 'gantt-chart'], ['Tickets', null, 'ticket'], ['Archief', null, 'archive']] }],
  geld: [
    { label: 'Verkoop', items: [['Overzicht', 'geld', 'waves'], ['Offertes', 'geld:offertes', 'file-text'], ['Facturen', 'geld:facturen', 'receipt'], ['Contracten', null, 'file-pen-line']] },
    { label: 'Inkoop', items: [['Leveranciers', null, 'truck'], ['Inkoopfacturen', null, 'inbox']] },
    { label: 'Boekhouding', items: [['Grootboek', null, 'book-open'], ['Bank', null, 'landmark'], ['Activa', null, 'boxes']] },
    { label: 'Rapportage', items: [['Winst en verlies', null, 'trending-up'], ['Btw-aangifte', null, 'percent'], ['Vennootschapsbelasting', null, 'scale'], ['Jaarrekening', null, 'library']] },
  ],
  berichten: [{ items: [['Klantmail', null, 'mail'], ['Teamchat', null, 'message-square'], ['Marketing', null, 'megaphone']] }],
  inzicht: [{ items: [['Statistieken', null, 'bar-chart-3'], ['Inhoud', null, 'image'], ['Notities', null, 'sticky-note'], ['Documenten', null, 'file-text']] }],
};
const moduleOf = r => { const b = (r || '').split(':')[0]; return b === 'klant' ? 'werk' : b === 'factuur' ? 'geld' : b === 'login' ? null : b; };

let APP_N = 0;
function createApp(host, opts = {}) {
  const uid = 'a' + (++APP_N);
  const root = document.createElement('div');
  root.className = 'app';
  if (opts.cls) root.classList.add(...opts.cls.split(' '));
  root.style.setProperty('--vt-scr', `scr-${uid}`);
  root.innerHTML = `<div class="app-in">
    <nav class="rail glass" aria-label="Modules">
      <button type="button" class="rail-logo" data-go="vandaag" aria-label="ResoFly, naar Vandaag"><span>R</span></button>
      <div class="rail-mods">${MODULES.map(m => `<button type="button" class="rail-mod${m.ai ? ' ai' : ''}" data-mod="${m.id}" aria-label="${m.label}">${ic(m.ic, 'lg')}<span class="rail-b" hidden></span></button>`).join('')}</div>
      <div class="rail-end">
        <button type="button" class="rail-mod rail-look" aria-label="Weergave" aria-haspopup="menu">${ic('sun-moon', 'lg')}</button>
        <button type="button" class="rail-me" aria-label="Gerjan van Lopik, accountmenu" aria-haspopup="menu"><span class="av">GL</span><i class="rail-on"></i></button>
      </div>
    </nav>
    <header class="top">
      <div class="top-l"></div>
      <div class="isl-slot"></div>
      <div class="top-r">
        <button type="button" class="icon-btn top-bell" aria-label="Meldingen: 3 nieuw">${ic('bell')}<i class="top-dot"></i></button>
      </div>
    </header>
    <main class="scr" tabindex="-1"></main>
    <nav class="dock glass" aria-label="Modules">
      ${['vandaag', 'agenda', 'gerrie', 'werk', 'geld'].map(id => { const m = MODULES.find(x => x.id === id); return id === 'gerrie' ? `<button type="button" class="dock-orb" data-mod="gerrie" aria-label="Gerrie: te beslissen"><span class="orb lg live"></span><span class="rail-b" hidden></span></button>` : `<button type="button" class="dock-b" data-mod="${id}" aria-label="${m.label}">${ic(m.ic, 'lg')}<span>${m.label}</span></button>`; }).join('')}
    </nav>
    <div class="scrim" aria-hidden="true"></div>
    <div class="flyout glass glass-2" hidden></div>
    <div class="pop glass glass-3" hidden role="menu"></div>
  </div>`;
  host.appendChild(root);
  const $ = s => root.querySelector(s);
  const $$ = s => [...root.querySelectorAll(s)];
  const scr = $('.scr');
  const t0 = performance.now();

  const app = {
    uid, root, opts,
    state: {
      route: opts.route || 'vandaag',
      decisions: DECISIONS.map(d => ({ ...d })),
      invoices: INVOICES.map(i => ({ ...i })),
      flow: FLOW.map(f => ({ ...f })),
      paid: false, planned: false, mine: true, filter: 'alles', tl: 'alles',
    },
    phone: () => root.clientWidth < 760,
    clock: () => DEMO.now * 60 + 12 + (performance.now() - t0) / 1000,
  };
  app.light = createLight($('.app-in'), { scale: opts.phoneFrame ? .26 : .3, seed: APP_N * 3 });
  placeSun();
  app.island = createIsland(app);
  app.onTimer = (sec, pct) => nuTick(app, sec, pct);
  app.timerStopped = () => { const nu = root.querySelector('.nu'); if (nu) nu.outerHTML = nuHtml(app); };
  // De werkruimte wordt wakker: eerst het licht, dan de rail, het eiland, de groet en de stroom
  app.wake = function wake() {
    root.classList.remove('waking'); void root.offsetWidth;
    root.classList.add('waking');
    app.state.route = 'vandaag';
    render({});
    clearTimeout(app._wk); app._wk = setTimeout(() => root.classList.remove('waking'), 2600);
  };

  // ── Het licht volgt de klok van de demo ──
  function placeSun() {
    const m = app.clock() / 60;
    const p = sunPlace(m, DEMO.rise, DEMO.set);
    app.light.sun(p.x, p.y, p.amt, true);
  }
  setInterval(() => { const m = app.clock() / 60; const p = sunPlace(m, DEMO.rise, DEMO.set); app.light.sun(p.x, p.y, p.amt); }, 30000);

  // ── Routering ──
  app.go = function go(route, o = {}) {
    if (route === app.state.route && !o.force && !o.plan) return;
    const from = app.state.route;
    const swap = () => { app.state.route = route; render(o); };
    if (moduleOf(from) === 'vandaag' && moduleOf(route) !== 'vandaag') flyNuToIsland();
    const vt = document.startViewTransition && !reducedMotion() && !opts.noVT && root.isConnected && root.getBoundingClientRect().bottom > 0;
    if (vt) {
      if (o.morphFrom) o.morphFrom.style.viewTransitionName = `m-${uid}`;
      root.classList.add('vt-go');
      const t = document.startViewTransition(() => { if (o.morphFrom) o.morphFrom.style.viewTransitionName = ''; swap(); const to = root.querySelector('[data-morph]'); if (to && o.morphFrom) to.style.viewTransitionName = `m-${uid}`; });
      t.finished.finally(() => { root.classList.remove('vt-go'); const to = root.querySelector('[data-morph]'); if (to) to.style.viewTransitionName = ''; });
    } else swap();
  };

  function render(o = {}) {
    const r = app.state.route;
    const [base, arg] = r.split(':');
    const mod = moduleOf(r);
    root.dataset.route = base;
    // Rail en dock: waar je bent, gloeit
    $$('[data-mod]').forEach(b => { const on = b.dataset.mod === mod; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    // Klantlicht: elke klant kleurt het veld een beetje
    const client = base === 'klant' ? CLIENTS[arg] : null;
    app.light.tint(client ? client.color : null, client ? (isDay() ? .6 : .4) : 0);
    // Bovenregel
    const m = MODULES.find(x => x.id === mod);
    const crumb = base === 'klant' ? `<button type="button" class="tl-up" data-go="werk">${ic(m.ic, 'sm')}Werk</button><span class="tl-sep">/</span><span>${esc(client.short)}</span>`
      : base === 'factuur' ? `<button type="button" class="tl-up" data-go="geld:facturen">${ic(m.ic, 'sm')}Geld</button><span class="tl-sep">/</span><span>Factuur ${esc(arg)}</span>`
      : m ? `<span class="tl-m">${ic(m.ic, 'sm')}${m.label}</span>` : '';
    $('.top-l').innerHTML = crumb;
    // Het scherm
    const S = SCREENS[base] || SCREENS.niet;
    if (app.stream) { app.stream.destroy(); app.stream = null; }
    scr.innerHTML = S.html(app, arg, o);
    scr.scrollTop = 0;
    if (S.mount) S.mount(app, arg, o);
    app.island.showLive(base !== 'vandaag' && base !== 'login');
    if (opts.onRoute) opts.onRoute(r);
    root.classList.toggle('is-login', base === 'login');
    badges();
  }
  app.render = render;
  // Wat Gerrie klaarzet, komt bovenaan de lijst (als concept, nog niet verstuurd)
  app.addInvoice = inv => { app.state.invoices = [inv, ...app.state.invoices.filter(i => i.n !== inv.n)]; };
  app.refresh = () => render({ keep: true });

  // Tellers op rail en dock
  function badges() {
    const n = app.state.decisions.filter(d => !d.done && !d.dismissed).length;
    $$('[data-mod="gerrie"] .rail-b').forEach(b => { b.hidden = !n; b.textContent = n; });
  }
  app.badges = badges;

  // ── Vliegen: wat je klaarzet, vliegt naar waar het heen gaat ──
  app.fly = function fly(src, targetMod) {
    if (reducedMotion()) return;
    const target = (app.phone() ? root.querySelector(`.dock [data-mod="${targetMod}"]`) : root.querySelector(`.rail [data-mod="${targetMod}"]`)) || root.querySelector('.rail-logo');
    const a = src.getBoundingClientRect(), b = target.getBoundingClientRect();
    const ghost = src.cloneNode(true);
    ghost.classList.add('ghost');
    Object.assign(ghost.style, { position: 'fixed', left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', margin: 0, zIndex: 9999, pointerEvents: 'none', transformOrigin: '0 0' });
    document.body.appendChild(ghost);
    const s = Math.max(.06, 30 / a.width);
    const dx = b.left + b.width / 2 - (a.left + a.width * s / 2), dy = b.top + b.height / 2 - (a.top + a.height * s / 2);
    ghost.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1, filter: 'blur(0)' },
      { transform: `translate(${dx * .35}px,${dy * .2 - 40}px) scale(${.55})`, opacity: 1, offset: .35 },
      { transform: `translate(${dx}px,${dy}px) scale(${s})`, opacity: .2, filter: 'blur(2px)' },
    ], { duration: 820, easing: 'cubic-bezier(.5,0,.2,1)' }).finished.then(() => {
      ghost.remove();
      target.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.22)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      target.classList.add('got'); setTimeout(() => target.classList.remove('got'), 900);
    });
  };
  // Naar een andere plek: de Nu-kaart krimpt tot de timer in het eiland
  function flyNuToIsland() {
    const nu = root.querySelector('.nu');
    if (!nu || reducedMotion() || !app.island.timer.on || app.phone()) return;
    const a = nu.getBoundingClientRect();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const b = app.island.liveRect();
      if (!b.width) return;
      const ghost = document.createElement('div');
      ghost.className = 'nu-ghost';
      Object.assign(ghost.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
      document.body.appendChild(ghost);
      ghost.animate([
        { transform: 'translate(0,0)', width: a.width + 'px', height: a.height + 'px', borderRadius: '26px', opacity: .9 },
        { transform: `translate(${b.left - a.left}px,${b.top - a.top}px)`, width: b.width + 'px', height: b.height + 'px', borderRadius: '999px', opacity: 0 },
      ], { duration: 620, easing: 'cubic-bezier(.6,0,.2,1)' }).finished.then(() => ghost.remove());
    }));
  }

  // Resonantie: ringen uit het merkteken, en een rimpel van goud door het licht
  app.resonate = function resonate(fromEl, amt = 1) {
    const logo = $('.rail-logo'); logo.classList.remove('resonate'); void logo.offsetWidth; logo.classList.add('resonate');
    const box = $('.app-in').getBoundingClientRect();
    let x = .5, y = .5;
    if (fromEl) { const r = fromEl.getBoundingClientRect(); x = (r.left + r.width / 2 - box.left) / box.width; y = 1 - (r.top + r.height / 2 - box.top) / box.height; }
    app.light.ripple(x, y, amt);
  };

  // ── Beslissen ──
  app.openDecision = function (id) {
    const ds = app.state.decisions;
    const i = ds.findIndex(d => d.id === id);
    if (i > 0) { const [d] = ds.splice(i, 1); ds.unshift(d); }
    const base = app.state.route.split(':')[0];
    if (base === 'vandaag' || base === 'gerrie') { renderDeck(); const top = root.querySelector('.dk-card.k0'); if (top) top.animate([{ boxShadow: '0 0 0 0 var(--ai-1)' }, { boxShadow: '0 0 0 6px transparent' }], { duration: 700 }); }
    else app.go('gerrie');
  };
  app.decide = function decide(id, how) {
    const d = app.state.decisions.find(x => x.id === id);
    const card = root.querySelector(`.dk-card[data-id="${id}"]`);
    if (!d || !card || card.classList.contains('leaving')) return;
    card.classList.add('leaving');
    const fx = {
      A: [{ transform: 'translate(0,0) rotate(0)', opacity: 1 }, { transform: 'translate(70%, -14px) rotate(6deg)', opacity: 0 }],
      L: [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: 'translate(-12%, 26px) scale(.9)', opacity: 0 }],
      N: [{ transform: 'translateY(0) scale(1)', opacity: 1, filter: 'blur(0)' }, { transform: 'translateY(30px) scale(.94)', opacity: 0, filter: 'blur(6px)' }],
    }[how];
    const drag = card._drag || 0;
    if (drag) fx[0].transform = `translate(${drag}px,0) rotate(${drag / 22}deg)`;
    if (how === 'A') app.resonate(card, .9);
    const go = () => {
      if (how === 'A') {
        d.done = true;
        const mail = d.id === 'd1' || d.id === 'd3';
        const orig = DECISIONS.find(x => x.id === d.id);
        app.island.note({
          icon: mail ? 'send' : 'circle-check', tone: 'ok', text: d.undo, sub: '',
          undo: {
            secs: mail ? 10 : 6, verb: mail ? 'mail' : 'boek',
            onUndo: () => { d.done = false; renderDeck(); badges(); if (d.flow && app.stream) app.stream.calm(d.flow, null, true); },
            doneText: orig.doneText, doneSub: mail ? 'Gerrie houdt het antwoord in de gaten' : '',
          },
        });
        if (d.flow && app.stream) app.stream.calm(d.flow, d.id === 'd1' ? 'Herinnering verstuurd · 09:42' : 'Opvolgmail verstuurd · 09:42');
      } else if (how === 'L') {
        const ds = app.state.decisions; ds.splice(ds.indexOf(d), 1); ds.push(d);
        app.island.note({ icon: 'clock', tone: 'muted', text: 'Later vandaag', sub: 'Komt om 13:00 terug bovenop je stapel', ms: 2600 });
      } else {
        d.dismissed = true;
        app.island.note({ icon: 'eye-off', tone: 'muted', text: 'Gerrie stelt dit niet meer voor', sub: d.title, action: { label: 'Toch wel', fn: () => { d.dismissed = false; renderDeck(); } }, ms: 4200 });
      }
      renderDeck();
      badges();
    };
    if (reducedMotion()) go();
    else card.animate(fx, { duration: how === 'A' ? 420 : 340, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }).finished.then(go);
  };
  function renderDeck() {
    const host = root.querySelector('.dk');
    if (!host) return;
    host.outerHTML = deckHtml(app, host.dataset.size === 'lg');
    bindDeck();
    const n = app.state.decisions.filter(d => !d.done && !d.dismissed).length;
    root.querySelectorAll('[data-dcount]').forEach(e => { e.textContent = n; e.hidden = !n; });
    const brief = root.querySelector('[data-brief-dec]'); if (brief) brief.innerHTML = briefDec(n);
    const sum = root.querySelector('.vd-sum'); if (sum) sum.innerHTML = streamSum(app);
  }
  app.renderDeck = renderDeck;
  function bindDeck() {
    const top = root.querySelector('.dk-card.k0');
    if (!top) return;
    const d = app.state.decisions.find(x => x.id === top.dataset.id);
    if (d && d.flow) {
      top.addEventListener('pointerenter', () => app.stream && app.stream.highlight(d.flow));
      top.addEventListener('pointerleave', () => app.stream && app.stream.highlight(null));
    }
    // Met je duim (of muis): naar rechts is akkoord, naar links is later
    let sx = 0, dx = 0, on = false;
    top.addEventListener('pointerdown', e => {
      if (e.target.closest('button, a, input')) return;
      on = true; sx = e.clientX; dx = 0; top.setPointerCapture(e.pointerId); top.classList.add('dragging');
    });
    top.addEventListener('pointermove', e => {
      if (!on) return;
      dx = e.clientX - sx;
      top.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
      top.dataset.hint = dx > 60 ? 'A' : dx < -60 ? 'L' : '';
    });
    const up = () => {
      if (!on) return; on = false; top.classList.remove('dragging');
      if (dx > 120) { top._drag = dx; app.decide(top.dataset.id, 'A'); }
      else if (dx < -120) { top._drag = dx; app.decide(top.dataset.id, 'L'); }
      else { top.style.transform = ''; top.dataset.hint = ''; }
    };
    top.addEventListener('pointerup', up);
    top.addEventListener('pointercancel', up);
  }
  app.bindDeck = bindDeck;

  // ── Een betaling: de kraal reist naar Betaald ──
  app.pay = function pay() {
    if (app.state.paid) return;
    const go = () => {
      if (!app.stream) return;
      app.state.paid = true;
      const inv = app.state.invoices.find(i => i.n === '2026-040'); if (inv) { inv.st = 'paid'; inv.note = 'Betaald 22 okt · iDEAL'; }
      const rem = app.state.decisions.find(d => d.id === 'd1');
      const withdrawn = rem && !rem.done && !rem.dismissed;
      if (withdrawn) rem.dismissed = true;
      const bead = root.querySelector('.st-bead[data-id="f-i040"]');
      app.stream.travel('f-i040', 'betaald', () => {
        app.resonate(bead || root.querySelector('.st-stn.is-end'), 1.3);
        app.island.note({ icon: 'hand-coins', tone: 'gold', text: '€ 786,50 binnen van Restaurant Bloem', sub: withdrawn ? 'Factuur 2026-040 betaald via iDEAL · Gerrie haalde de herinnering van je stapel' : 'Factuur 2026-040 betaald via iDEAL, twee dagen na de herinnering', ms: 6000 });
        if (withdrawn) { renderDeck(); badges(); }
        const brief = root.querySelector('.vd-sum'); if (brief) brief.innerHTML = streamSum(app);
      });
    };
    if (app.state.route !== 'vandaag') { app.go('vandaag'); setTimeout(go, 700); } else go();
  };

  // ── Bediening ──
  root.addEventListener('click', e => {
    const g = e.target.closest('[data-go]');
    if (g && root.contains(g)) {
      if (g.getAttribute('aria-disabled') === 'true') return;
      e.preventDefault();
      app.go(g.dataset.go, { morphFrom: g.dataset.morphFrom !== undefined ? (g.querySelector('[data-morph-src]') || g) : null });
      hideFly(); hidePop();
      return;
    }
    const m = e.target.closest('[data-mod]');
    if (m) { const id = m.dataset.mod; app.go(id === 'gerrie' ? 'gerrie' : id); hideFly(); return; }
    const dec = e.target.closest('[data-dec]');
    if (dec) { app.decide(dec.dataset.dec, dec.dataset.how); return; }
    const ask = e.target.closest('[data-ask]');
    if (ask) { app.island.open(ask.dataset.ask); return; }
    if (e.target.closest('.scrim')) { app.island.close(); }
    if (e.target.closest('.rail-look')) { showLook(e.target.closest('.rail-look')); return; }
    if (e.target.closest('.rail-me')) { showMe(e.target.closest('.rail-me')); return; }
    if (e.target.closest('.top-bell')) { app.island.note({ icon: 'bell', tone: 'muted', text: '3 meldingen', sub: 'Joost opende 2026-041 · Sanne noemde je in Lancering Korenaar · 2 inkoopfacturen', ms: 4200 }); return; }
    if (!e.target.closest('.pop')) hidePop();
  });
  // Glans die de cursor volgt
  root.addEventListener('pointermove', e => {
    const g = e.target.closest('.sheen'); if (!g) return;
    const r = g.getBoundingClientRect();
    g.style.setProperty('--mx', (e.clientX - r.left) + 'px'); g.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });

  // ── Rail: wat er in een module zit, verschijnt naast de rail ──
  const fly = $('.flyout');
  let flyT = 0;
  function showFly(btn) {
    if (app.phone()) return;
    clearTimeout(flyT);
    const id = btn.dataset.mod; const m = MODULES.find(x => x.id === id);
    fly.innerHTML = `<p class="fo-t">${m.label}</p>${MENU[id].map(g => `${g.label ? `<p class="fo-g">${g.label}</p>` : ''}${g.items.map(([t, r, i]) => `<button type="button" class="fo-i${r ? '' : ' off'}" ${r ? `data-go="${r}"` : 'aria-disabled="true" title="In dit voorstel niet uitgewerkt"'}>${ic(i, 'sm')}${t}${r ? '' : '<em>later</em>'}</button>`).join('')}`).join('')}`;
    const rb = btn.getBoundingClientRect(), ab = $('.app-in').getBoundingClientRect();
    fly.hidden = false;
    const top = Math.max(10, Math.min(rb.top - ab.top - 8, ab.height - fly.offsetHeight - 10));
    fly.style.top = top + 'px';
    fly.classList.remove('in'); void fly.offsetWidth; fly.classList.add('in');
  }
  function hideFly() { clearTimeout(flyT); fly.hidden = true; }
  $$('.rail-mods .rail-mod').forEach(b => {
    b.addEventListener('pointerenter', () => { flyT = setTimeout(() => showFly(b), 140); });
    b.addEventListener('pointerleave', () => { clearTimeout(flyT); flyT = setTimeout(() => { if (!fly.matches(':hover')) hideFly(); }, 220); });
  });
  fly.addEventListener('pointerleave', () => { flyT = setTimeout(hideFly, 200); });
  fly.addEventListener('pointerenter', () => clearTimeout(flyT));

  // ── Weergave en account ──
  const pop = $('.pop');
  function placePop(btn) {
    const rb = btn.getBoundingClientRect(), ab = $('.app-in').getBoundingClientRect();
    pop.hidden = false;
    pop.style.left = (rb.right - ab.left + 12) + 'px';
    pop.style.top = Math.max(10, rb.bottom - ab.top - pop.offsetHeight) + 'px';
    pop.classList.remove('in'); void pop.offsetWidth; pop.classList.add('in');
  }
  function hidePop() { pop.hidden = true; }
  function showLook(btn) {
    const cur = window.STROOM_THEME ? window.STROOM_THEME() : 'dark';
    const opt = (v, t, i, s) => `<button type="button" role="menuitemradio" aria-checked="${cur === v}" class="pop-i" data-theme-set="${v}">${ic(i, 'sm')}<span><b>${t}</b><em>${s}</em></span>${cur === v ? ic('check', 'sm') : ''}</button>`;
    pop.innerHTML = `<p class="pop-t">Weergave</p>${opt('dark', 'Nacht', 'moon', 'Grafiet en zongoud')}${opt('light', 'Dag', 'sun', 'Daglicht door matglas')}${opt('sun', 'Met de zon mee', 'sunrise', 'Dag na zon op, Nacht na zon onder')}${opt('system', 'Systeem', 'monitor', 'Zoals je apparaat')}`;
    placePop(btn);
    pop.querySelectorAll('[data-theme-set]').forEach(b => b.addEventListener('click', () => { hidePop(); window.STROOM_SET_THEME && window.STROOM_SET_THEME(b.dataset.themeSet, b); }));
  }
  function showMe(btn) {
    pop.innerHTML = `<div class="pop-me"><span class="av" style="--s:34px">GL</span><span><b>Gerjan van Lopik</b><em>Studio Lopik · owner</em></span></div>
      <button type="button" class="pop-i" aria-disabled="true">${ic('settings', 'sm')}<span><b>Instellingen</b><em>In dit voorstel niet uitgewerkt</em></span></button>
      <button type="button" class="pop-i" data-go="login">${ic('log-out', 'sm')}<span><b>Uitloggen</b><em>Zie hoe Stroom je begroet</em></span></button>`;
    placePop(btn);
  }

  // ── Sneltoetsen (alleen in de grote instantie) ──
  let gKey = 0;
  if (opts.keys) {
    document.addEventListener('keydown', e => {
      if (!opts.keys() || e.defaultPrevented) return;
      const typing = e.target.closest && e.target.closest('input, textarea, [contenteditable]');
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); app.island.isOpen() ? app.island.close() : app.island.open(); return; }
      if (typing) return;
      // Eiland open maar de focus elders: de letter hoort in het eiland, niet bij een sneltoets
      if (app.island.isOpen()) { if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { const q = app.island.el.querySelector('input'); if (q) q.focus({ preventScroll: true }); } else if (e.key === 'Escape') app.island.close(); return; }
      if (e.key === '/') { e.preventDefault(); app.island.open(); return; }
      if (e.key === 'Escape') { if (app.island.isOpen()) app.island.close(); hidePop(); hideFly(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toUpperCase();
      if (gKey && performance.now() - gKey < 900) {
        gKey = 0;
        const m = MODULES.find(x => x.key === k);
        if (m) { e.preventDefault(); app.go(m.id); }
        return;
      }
      if (k === 'G') { gKey = performance.now(); return; }
      const base = app.state.route.split(':')[0];
      if ((base === 'vandaag' || base === 'gerrie') && ['A', 'L', 'N'].includes(k)) {
        const top = root.querySelector('.dk-card.k0'); if (top) { e.preventDefault(); app.decide(top.dataset.id, k); }
      }
    });
  }
  app.focusMain = () => { if (opts.keys && opts.keys()) scr.focus({ preventScroll: true }); };

  // Als de vorm verandert (telefoon ↔ groot), het scherm opnieuw opbouwen
  let wasPhone = null;
  if (window.ResizeObserver) new ResizeObserver(() => {
    const p = app.phone();
    if (wasPhone !== null && p !== wasPhone) render({ keep: true });
    wasPhone = p;
    app.island.fit();
  }).observe(root);

  app.retheme = instant => { app.light.retheme(instant); if (app.stream) app.stream.retheme(); if (app.redrawCash) app.redrawCash(); };
  render();
  wasPhone = app.phone();
  return app;
}

const isDay = () => document.documentElement.dataset.theme === 'light' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: light)').matches);

/* ── De beslisstapel ────────────────────────────────────────────────────── */
function briefDec(n) {
  const w = ['geen', 'één', 'twee', 'drie', 'vier'][n] || n;
  return n ? `Gerrie heeft <b>${w} ${n === 1 ? 'ding' : 'dingen'}</b> voor je klaargezet.` : 'Alles is beslist; de volgende ronde van je agents is om 13:00.';
}
function effectHtml(d, lg) {
  const x = DDETAIL[d.id];
  if (x.kind === 'mail') return `<div class="dk-fx dk-mail"><div class="dk-mh"><span>Aan</span><b>${x.to}</b></div><div class="dk-mh"><span>Onderwerp</span><b>${x.subj}</b></div><div class="dk-mb">${(lg ? x.body : x.body.slice(1, 2)).map(p => `<p>${p}</p>`).join('')}</div></div>`;
  if (x.kind === 'hours') return `<div class="dk-fx dk-rows">${x.rows.map(([t, p, w, h]) => `<div><span class="dk-rt"><b>${t}</b><em>${p} · ${w}</em></span><b class="dk-rv">${h}</b></div>`).join('')}</div>`;
  return `<div class="dk-fx dk-rows">${x.rows.map(([t, p, a]) => `<div><span class="dk-rt"><b>${t}</b><em>${p}</em></span><b class="dk-rv amt">${a}</b></div>`).join('')}</div>`;
}
function deckHtml(app, lg) {
  const ds = app.state.decisions.filter(d => !d.done && !d.dismissed);
  if (!ds.length) return `<div class="dk dk-empty" data-size="${lg ? 'lg' : 'sm'}"><span class="dk-ok">${ic('check-check', 'lg')}</span><b>Alles beslist</b><p>Je stroom staat open. De volgende ronde van je agents is om 13:00; wat ze vinden, staat dan hier.</p></div>`;
  const total = ds.length;
  return `<div class="dk" data-size="${lg ? 'lg' : 'sm'}">${ds.slice(0, 3).map((d, k) => {
    const x = DDETAIL[d.id];
    return `<article class="dk-card glass glass-2 k${k}" data-id="${d.id}" aria-label="${esc(d.title)}"${k ? ' aria-hidden="true" inert' : ''}>
      <header class="dk-h"><span class="dk-ic${d.id === 'd1' ? ' gold' : ''}">${ic(d.icon)}</span><div class="dk-ht"><h3>${esc(d.title)}</h3><p>${ic('sparkles', 'xs i-ai')}${esc(d.agent)} · ${d.at}</p></div><span class="dk-n">${k + 1} van ${total}</span></header>
      ${lg ? `<div class="dk-facts">${x.facts.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('')}</div>` : `<p class="dk-why">${esc(d.why)}</p>`}
      ${lg ? `<p class="dk-lbl">Wat er gebeurt als je akkoord geeft</p>` : ''}
      ${effectHtml(d, lg)}
      <footer class="dk-f">
        <button type="button" class="btn btn-gold" data-dec="${d.id}" data-how="A">${ic('check')}${esc(d.cta)}<kbd>A</kbd></button>
        <button type="button" class="btn" aria-disabled="true" title="In dit voorstel niet uitgewerkt">${ic('pencil')}Aanpassen</button>
        <span class="dk-sp"></span>
        <button type="button" class="btn btn-ghost" data-dec="${d.id}" data-how="L">Later<kbd>L</kbd></button>
        <button type="button" class="btn btn-ghost" data-dec="${d.id}" data-how="N">Niet meer<kbd>N</kbd></button>
      </footer>
      <span class="dk-hint dk-hint-a" aria-hidden="true">${ic('check')}Akkoord</span><span class="dk-hint dk-hint-l" aria-hidden="true">${ic('clock')}Later</span>
    </article>`;
  }).join('')}</div>`;
}
