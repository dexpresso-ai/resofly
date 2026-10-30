/* ══ De stroom ══════════════════════════════════════════════════════════════
   Van eerste mail tot betaalde factuur als één lichtband: links koel maanlicht
   (een gesprek), rechts zongoud (betaald). De dikte is het bedrag per halte,
   de strepen zijn de richting, de poel rechts is wat er binnen is.

   Het canvas tekent alleen licht. De haltes en de kralen zijn echte knoppen
   erboven: met de muis, het toetsenbord en een schermlezer te gebruiken.

   mode 'app'  — Vandaag: haltes met bedrag, kralen per ding dat onderweg is
   mode 'hero' — de voorstelpagina: kralen stromen de hele band door
   mode 'mini' — telefoon: smal, korte bedragen */

function createStream(host, opts = {}) {
  const mode = opts.mode || 'app';
  const root = document.createElement('div');
  root.className = `st st-${mode}`;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', opts.label || 'De stroom: van gesprek tot betaald');
  root.innerHTML = `<canvas class="st-cv" aria-hidden="true"></canvas><ol class="st-stns"></ol><div class="st-beads"></div><div class="st-tip glass glass-3" role="tooltip" hidden></div>`;
  host.appendChild(root);
  const cv = root.querySelector('.st-cv');
  const ctx = cv.getContext('2d');
  const stnsEl = root.querySelector('.st-stns');
  const beadsEl = root.querySelector('.st-beads');
  const tip = root.querySelector('.st-tip');

  const stations = opts.stations || STATIONS;
  // Met opts.flow deelt de stroom zijn staat met de app (een losgemaakte knoop blijft los)
  let flow = opts.flow || FLOW.map(f => ({ ...f }));
  let totals = stations.map(s => flow.filter(f => f.st === s.id).reduce((a, f) => a + f.amt, 0));
  const shown = totals.slice();             // getoonde bedragen (tellen mee bij een verandering)
  let W = 0, H = 0, dpr = 1, col = {}, t0 = performance.now(), raf = 0, visible = true;
  const S = { trails: [], flash: 0, hl: null };

  const readCol = () => {
    const cs = getComputedStyle(root);
    const g = k => cs.getPropertyValue(k).trim();
    col = { f1: hexRgb(g('--flow-1')), f2: hexRgb(g('--flow-2')), body: parseFloat(g('--flow-body')) || .16, edge: parseFloat(g('--flow-edge')) || .5, add: g('--flow-add') || 'lighter', day: cs.colorScheme === 'light' };
  };
  readCol();

  // ── Geometrie ──
  const pad = () => mode === 'hero' ? .1 : (W < 560 ? .1 : .085);
  const stX = i => { const p = pad() * W; return p + i * (W - 2 * p) / (stations.length - 1); };
  const yMid = () => H * (mode === 'hero' ? .42 : .7);
  const tMax = () => mode === 'hero' ? Math.min(140, H * .34) : mode === 'mini' ? Math.min(30, H * .36) : Math.min(64, H * .3);
  const tMin = () => mode === 'mini' ? 5 : 9;
  const vMax = () => Math.max(...totals, 1);
  const thickAt = i => { const v = mode === 'hero' ? [4452.8, 3327.5, 4840, 3690.5, 6292][i] : totals[i]; return tMin() + (tMax() - tMin()) * Math.sqrt(Math.max(0, v) / (mode === 'hero' ? 6292 : vMax())); };
  function thick(x) {
    const n = stations.length;
    const x0 = stX(0), xn = stX(n - 1);
    if (x <= x0) { const k = Math.max(0, x / x0); return lerp(tMin() * .5, thickAt(0), k * k * (3 - 2 * k)); }
    if (x >= xn) { const k = Math.min(1, (x - xn) / (W - xn)); return lerp(thickAt(n - 1), thickAt(n - 1) * 1.25, k); }
    const seg = (x - x0) / ((xn - x0) / (n - 1));
    const i = Math.floor(seg), k = seg - i;
    const s = k * k * (3 - 2 * k);
    return lerp(thickAt(i), thickAt(Math.min(n - 1, i + 1)), s);
  }
  const wave = (x, t) => Math.sin(x / W * Math.PI * 2.1 + t * .45) * H * .018 + Math.sin(x / W * Math.PI * 5.3 - t * .3) * H * .006;
  const yAt = (x, t) => yMid() + wave(x, t);
  const colAt = x => { const k = Math.max(0, Math.min(1, (x - stX(0) * .4) / (W - stX(0) * .4))); return lerp3(col.f1, col.f2, k * k * (3 - 2 * k) * .92 + k * .08); };
  const rgba = (c, a) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

  // ── Strepen: de stroming ──
  const N = mode === 'hero' ? 120 : mode === 'mini' ? 34 : 78;
  const streaks = Array.from({ length: N }, () => ({ x: Math.random(), l: (Math.random() - .5) * 1.7, v: .035 + Math.random() * .05, len: .02 + Math.random() * .05, a: .35 + Math.random() * .65 }));
  // Hero: kralen die de hele band door reizen, in de kleuren van de klanten
  const travellers = mode === 'hero' ? Array.from({ length: 16 }, (_, i) => ({ x: i / 16, l: (Math.random() - .5) * .9, v: .018 + Math.random() * .02, c: hexRgb(Object.values(CLIENTS)[i % 6].color), r: 3 + Math.random() * 2.5 })) : [];
  const dust = Array.from({ length: mode === 'mini' ? 10 : 26 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random(), v: .1 + Math.random() * .25, s: .6 + Math.random() * 1.4 }));

  function size() {
    W = Math.max(10, root.clientWidth); H = Math.max(10, root.clientHeight);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    layout();
  }

  function frame(now) {
    const t = (now - t0) / 1000;
    const still = reducedMotion();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const step = Math.max(3, W / 260);
    const top = [], bot = [];
    for (let x = 0; x <= W + step; x += step) { const y = yAt(x, still ? 0 : t), h = thick(x) / 2; top.push([x, y - h]); bot.push([x, y + h]); }
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, rgba(col.f1, 1)); grad.addColorStop(.45, rgba(lerp3(col.f1, col.f2, .45), 1)); grad.addColorStop(1, rgba(col.f2, 1));
    const ribbon = (k) => {
      ctx.beginPath();
      top.forEach(([x, y], i) => { const c = yAt(x, still ? 0 : t); const yy = c + (y - c) * k; i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); });
      for (let i = bot.length - 1; i >= 0; i--) { const [x, y] = bot[i]; const c = yAt(x, still ? 0 : t); ctx.lineTo(x, c + (y - c) * k); }
      ctx.closePath();
    };
    // Lichaam: drie lagen, van breed en zacht naar smal en helder
    ctx.globalCompositeOperation = col.day ? 'source-over' : 'lighter';
    ctx.fillStyle = grad;
    [[1, col.body * .8], [.62, col.body * .9], [.26, col.body * 1.3]].forEach(([k, a]) => { ctx.globalAlpha = a; ribbon(k); ctx.fill(); });
    // Randen
    ctx.globalAlpha = col.edge * .55; ctx.strokeStyle = grad; ctx.lineWidth = 1;
    ctx.beginPath(); top.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
    ctx.globalAlpha = col.edge * .3;
    ctx.beginPath(); bot.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
    // Kern: een dunne lichtlijn door het midden
    ctx.globalAlpha = col.day ? .5 : .55; ctx.lineWidth = col.day ? 1.4 : 1.2;
    ctx.beginPath(); top.forEach(([x], i) => { const y = yAt(x, still ? 0 : t); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();

    // Strepen
    ctx.globalCompositeOperation = col.add;
    ctx.lineCap = 'round';
    streaks.forEach(s => {
      if (!still) { s.x += s.v * (1 / 60) * (mode === 'hero' ? 1 : .8); if (s.x > 1.08) { s.x = -.08; s.l = (Math.random() - .5) * 1.7; } }
      const x1 = s.x * W, x0 = x1 - s.len * W;
      const h1 = thick(Math.max(0, x1)) / 2 * s.l * .82, h0 = thick(Math.max(0, x0)) / 2 * s.l * .82;
      const y1 = yAt(x1, still ? 0 : t) + h1, y0 = yAt(x0, still ? 0 : t) + h0;
      const c = colAt(x1);
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, rgba(c, 0)); g.addColorStop(1, rgba(c, (col.day ? .75 : .9) * s.a));
      ctx.globalAlpha = 1; ctx.strokeStyle = g; ctx.lineWidth = col.day ? 1.4 : 1.3;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    });

    // Knooppunten: een zachte gloed op elke halte
    stations.forEach((s, i) => {
      const x = stX(i), y = yAt(x, still ? 0 : t), r = thick(x) * .9 + 10;
      const c = colAt(x);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(c, col.day ? .22 : .28)); g.addColorStop(1, rgba(c, 0));
      ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    });

    // De poel: wat binnen is, ademt goud
    const px = stX(stations.length - 1), py = yAt(px, still ? 0 : t);
    const breathe = still ? .5 : .5 + .5 * Math.sin(t * 1.3);
    const pr = thickAt(stations.length - 1) * 1.6 + 26 + S.flash * 60;
    const pg = ctx.createRadialGradient(px, py, 0, px, py, pr);
    pg.addColorStop(0, rgba(col.f2, (col.day ? .28 : .32) + breathe * .06 + S.flash * .35)); pg.addColorStop(1, rgba(col.f2, 0));
    ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
    dust.forEach(d => {
      if (!still) d.a += d.v * (1 / 60);
      const rr = (thickAt(stations.length - 1) * .45 + 8) * (.4 + d.r * .8);
      const x = px + Math.cos(d.a) * rr * 1.5, y = py + Math.sin(d.a) * rr * .55;
      ctx.fillStyle = rgba(col.f2, col.day ? .7 : .85); ctx.globalAlpha = .4 + .6 * Math.abs(Math.sin(d.a * 2 + d.r * 6));
      ctx.beginPath(); ctx.arc(x, y, d.s * (mode === 'mini' ? .7 : 1), 0, Math.PI * 2); ctx.fill();
    });
    if (S.flash > 0) S.flash = Math.max(0, S.flash - 1 / 70);

    // Hero: reizende kralen
    travellers.forEach(b => {
      if (!still) { b.x += b.v / 60; if (b.x > 1.06) { b.x = -.06; b.l = (Math.random() - .5) * .9; } }
      const x = b.x * W, y = yAt(x, still ? 0 : t) + thick(Math.max(0, x)) / 2 * b.l;
      const near = Math.min(...stations.map((_, i) => Math.abs(x - stX(i)))) < 24;
      const r = b.r * (near ? 1.35 : 1);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = col.day ? 'source-over' : 'lighter';
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
      g.addColorStop(0, rgba(b.c, .5)); g.addColorStop(1, rgba(b.c, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 5, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = rgba(b.c, 1); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.beginPath(); ctx.arc(x - r * .3, y - r * .35, r * .35, 0, Math.PI * 2); ctx.fill();
    });

    // Sporen van een kraal die verhuist (een betaling, een verstuurde offerte)
    S.trails = S.trails.filter(tr => {
      const k = Math.min(1, (now - tr.start) / tr.dur);
      const e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const x = lerp(tr.x0, tr.x1, e);
      const y = yAt(x, still ? 0 : t) + tr.l;
      tr.pts.push([x, y]); if (tr.pts.length > 26) tr.pts.shift();
      ctx.globalCompositeOperation = col.day ? 'source-over' : 'lighter';
      tr.pts.forEach(([px2, py2], i) => {
        const a = i / tr.pts.length;
        ctx.globalAlpha = a * .9; ctx.fillStyle = rgba(col.f2, 1);
        ctx.beginPath(); ctx.arc(px2, py2, 1 + a * 4.5, 0, Math.PI * 2); ctx.fill();
      });
      tr.bead.style.setProperty('--x', x + 'px'); tr.bead.style.setProperty('--y', y + 'px');
      if (k >= 1) { tr.done && tr.done(); return false; }
      return true;
    });
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!visible || document.hidden) return;
    if (reducedMotion() && !S.trails.length && S.drewStill) return;
    S.drewStill = reducedMotion();
    frame(now);
  }

  // ── Haltes en kralen (HTML) ──
  const short = n => `€ ${NL0.format(Math.floor(n))}`;
  function stnHtml(s, i) {
    const items = flow.filter(f => f.st === s.id);
    const n = items.length;
    const late = items.filter(f => f.knot === 'late').length, wait = items.filter(f => f.knot === 'wait').length;
    const noun = { gesprek: 'in gesprek', offerte: 'bij de klant', werk: n === 1 ? 'project' : 'projecten', factuur: 'open', betaald: 'betaald' }[s.id] || '';
    const sent = items.filter(f => f.knot === 'sent').length;
    const knot = late ? ` · <b class="late">${late} te laat</b>` : wait ? ` · <b class="wait">${wait} wacht</b>` : sent ? ` · <b class="ok">${sent} opgevolgd</b>` : '';
    const meta = mode === 'hero' ? '' : s.id === 'betaald' ? 'in oktober' : n ? `${n} ${noun}${knot}` : 'niets onderweg';
    const amt = mode === 'mini' ? short(shown[i]) : eur(shown[i]);
    const label = `${s.label}: ${eurTxt(shown[i])}, ${items.length} ${items.length === 1 ? 'ding' : 'dingen'} ${s.sub}`;
    return `<li class="st-stn-li" style="--i:${i}"><button type="button" class="st-stn${i === stations.length - 1 ? ' is-end' : ''}" data-st="${s.id}" aria-label="${esc(label)}">
      <span class="st-l"><i class="st-d"></i>${s.label}</span>${mode === 'hero' ? '' : `<span class="st-a amt" data-amt="${i}">${amt}</span><span class="st-m">${meta}</span>`}</button></li>`;
  }
  function render() {
    stnsEl.innerHTML = stations.map(stnHtml).join('');
    if (mode === 'hero') { beadsEl.innerHTML = ''; layout(); return; }
    beadsEl.innerHTML = flow.map((f, bi) => {
      const c = CLIENTS[f.c];
      const knot = f.knot ? ` knot ${f.knot}` : '';
      const lab = `${f.t} — ${f.s}${f.amt ? ', ' + eurTxt(f.amt) : ''}${f.dec && f.knot !== 'sent' ? '. Gerrie heeft iets klaar.' : ''}`;
      return `<button type="button" class="st-bead${knot}" data-id="${f.id}" style="--c:${c.color};--i:${bi}" aria-label="${esc(lab)}">${f.dec && f.knot !== 'sent' ? '<i class="st-spark orb"></i>' : ''}</button>`;
    }).join('');
    layout();
  }
  function layout() {
    if (!W) return;
    stnsEl.querySelectorAll('.st-stn-li').forEach((li, i) => li.style.setProperty('--x', stX(i) + 'px'));
    const spacing = (W - 2 * pad() * W) / (stations.length - 1);
    stations.forEach((s, i) => {
      const items = flow.filter(f => f.st === s.id);
      const n = items.length;
      const gap = Math.min(mode === 'mini' ? 13 : 30, spacing * .5 / Math.max(1, n));
      items.forEach((f, k) => {
        const el = beadsEl.querySelector(`[data-id="${f.id}"]`); if (!el || el.classList.contains('moving')) return;
        const x = stX(i) + (k - (n - 1) / 2) * gap;
        const lane = (k % 2 ? 1 : -1) * Math.min(thick(x) * .16, mode === 'mini' ? 3 : 7) * (n > 1 ? 1 : 0);
        el.style.setProperty('--x', x + 'px'); el.style.setProperty('--y', (yAt(x, 0) + lane) + 'px');
        el.style.setProperty('--d', (k * .7 + i * .37).toFixed(2) + 's');
      });
    });
  }

  // Tooltip
  function showTip(el) {
    const f = flow.find(x => x.id === el.dataset.id); if (!f) return;
    const c = CLIENTS[f.c];
    tip.innerHTML = `<div class="st-tip-h"><i style="background:${c.color}"></i>${esc(c.name)}</div><b>${esc(f.t)}</b><span>${esc(f.s)}</span>${f.amt ? `<span class="st-tip-a amt">${eur(f.amt)}</span>` : ''}${f.dec && f.knot !== 'sent' ? `<span class="st-tip-ai">${ic('sparkles', 'xs i-ai')}Gerrie heeft iets klaar</span>` : f.knot === 'sent' ? `<span class="st-tip-ok">${ic('check', 'xs')}${esc(f.sentNote || 'Verstuurd')}</span>` : ''}`;
    tip.hidden = false;
    const x = parseFloat(el.style.getPropertyValue('--x')), y = parseFloat(el.style.getPropertyValue('--y'));
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(6, Math.min(W - tw - 6, x - tw / 2)) + 'px';
    tip.style.top = Math.max(4, y - tip.offsetHeight - 16) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  beadsEl.addEventListener('pointerover', e => { const b = e.target.closest('.st-bead'); if (b) { showTip(b); opts.onHover && opts.onHover(b.dataset.id); } });
  beadsEl.addEventListener('pointerout', e => { const b = e.target.closest('.st-bead'); if (b) { hideTip(); opts.onHover && opts.onHover(null); } });
  beadsEl.addEventListener('focusin', e => { const b = e.target.closest('.st-bead'); if (b) showTip(b); });
  beadsEl.addEventListener('focusout', hideTip);
  beadsEl.addEventListener('click', e => { const b = e.target.closest('.st-bead'); if (b && opts.onPick) opts.onPick(flow.find(x => x.id === b.dataset.id)); });
  stnsEl.addEventListener('click', e => { const b = e.target.closest('.st-stn'); if (b && opts.onStation) opts.onStation(stations.find(s => s.id === b.dataset.st)); });

  // Bedragen die meetellen
  function countTo(i, to) {
    const el = stnsEl.querySelector(`[data-amt="${i}"]`);
    const from = shown[i]; const start = performance.now(); const dur = reducedMotion() ? 0 : 1100;
    const tick = now => {
      const k = dur ? Math.min(1, (now - start) / dur) : 1;
      shown[i] = from + (to - from) * (1 - Math.pow(1 - k, 3));
      if (el) el.innerHTML = mode === 'mini' ? short(shown[i]) : eur(shown[i]);
      if (k < 1) requestAnimationFrame(tick); else { shown[i] = to; render(); }
    };
    requestAnimationFrame(tick);
  }

  size(); render();
  const ro = window.ResizeObserver ? new ResizeObserver(() => { size(); }) : null;
  if (ro) ro.observe(root);
  const io = window.IntersectionObserver ? new IntersectionObserver(es => { visible = es[0].isIntersecting; S.drewStill = false; }) : null;
  if (io) io.observe(root);
  raf = requestAnimationFrame(loop);

  return {
    el: root,
    retheme() { readCol(); S.drewStill = false; },
    highlight(id) {
      beadsEl.querySelectorAll('.st-bead.hl').forEach(b => b.classList.remove('hl'));
      if (id) { const b = beadsEl.querySelector(`[data-id="${id}"]`); if (b) b.classList.add('hl'); }
    },
    // Een knoop wordt los: de herinnering of opvolgmail is de deur uit
    // (revert: ongedaan gemaakt, de knoop zit er weer)
    calm(id, note, revert) { const f = flow.find(x => x.id === id); if (!f) return; if (revert) { const o = FLOW.find(x => x.id === id); f.knot = o ? o.knot : null; f.sentNote = null; } else { f.knot = 'sent'; f.sentNote = note; } render(); },
    // Een kraal verhuist naar een volgende halte, met een spoor van goud
    travel(id, toSt, done) {
      const f = flow.find(x => x.id === id); if (!f) return;
      const from = stations.findIndex(s => s.id === f.st), to = stations.findIndex(s => s.id === toSt);
      const el = beadsEl.querySelector(`[data-id="${id}"]`); if (!el) return;
      el.classList.add('moving'); el.classList.remove('knot', 'late', 'wait', 'sent');
      const sp = el.querySelector('.st-spark'); if (sp) sp.remove();
      const x0 = parseFloat(el.style.getPropertyValue('--x')), x1 = stX(to) + 10;
      S.trails.push({ bead: el, x0, x1, l: 0, start: performance.now(), dur: reducedMotion() ? 1 : 1700, pts: [], done: () => {
        f.st = toSt; f.knot = null; f.dec = null;   // verhuisd: er is niets meer los te maken
        totals = stations.map(s => flow.filter(q => q.st === s.id).reduce((a, q) => a + q.amt, 0));
        S.flash = 1; el.classList.remove('moving');
        countTo(from, totals[from]); countTo(to, totals[to]);
        done && done();
      } });
    },
    totals: () => totals.slice(),
    destroy() { cancelAnimationFrame(raf); if (ro) ro.disconnect(); if (io) io.disconnect(); root.remove(); },
  };
}

// De stroomlijn: waar één klant of één ding staat, in dezelfde vijf haltes
function streamLine(at, color, opts = {}) {
  const i = STATIONS.findIndex(s => s.id === at);
  return `<span class="sl${opts.knot ? ' knot-' + opts.knot : ''}" style="--c:${color}" role="img" aria-label="${at ? `Staat bij ${STATIONS[i].label.toLowerCase()} (${i + 1} van 5)` : 'Niet in de stroom'}">${STATIONS.map((s, k) => `<i class="${k < i ? 'past' : k === i ? 'now' : ''}"></i>`).join('')}</span>`;
}
