// Stroom — tokens. Eén bron, twee lichten: [Nacht, Dag].
// De build schrijft hier drie blokken van: :root + .tn (Nacht, de standaard),
// @media (prefers-color-scheme: light) en [data-theme="light"] + .td (Dag).
// .tn / .td zetten een thema lokaal vast (de telefoons in het voorstel tonen
// één vast licht).
//
// Merk, tekst en status zijn die van Belicht en Zenit (AA nagerekend). Nieuw in
// Stroom zijn het glas, het lichtveld en de stroom zelf.
export const themed = {
  // ── Grond en lichtveld ────────────────────────────────────────────────────
  // Het lichtveld wordt in WebGL getekend uit deze kleuren (licht.js leest ze
  // uit de stijl), met een CSS-terugval voor wie geen WebGL heeft.
  'ground':      ['#07070A', '#ECEAE4'],
  'lf-base':     ['#07070A', '#EDEAE3'],
  'lf-top':      ['#100F1C', '#F8F5EE'],
  'lf-sun':      ['#F7C548', '#FFD670'],
  'lf-a1':       ['#4B3BC4', '#D9CFFF'],
  'lf-a2':       ['#14609F', '#CBE4FF'],
  'grain':       ['.055', '.045'],

  // ── Glas: kaart, verhoogd, eiland ─────────────────────────────────────────
  // Dekkend genoeg dat elke tekstkleur AA haalt boven het felste licht dat
  // onder een kaart mag komen (30% zon in Nacht, 30% klantkleur in Dag).
  'glass':       ['rgba(18,18,24,.72)', 'rgba(255,255,255,.64)'],
  'glass-2':     ['rgba(25,25,33,.82)', 'rgba(255,255,255,.80)'],
  'glass-3':     ['rgba(12,12,17,.88)', 'rgba(251,250,247,.90)'],
  'glass-solid': ['#131318', '#FFFFFF'],
  'glass-blur':  ['blur(26px) saturate(150%)', 'blur(26px) saturate(185%)'],
  'well':        ['rgba(255,255,255,.035)', 'rgba(28,27,24,.035)'],
  'well-2':      ['rgba(255,255,255,.065)', 'rgba(28,27,24,.06)'],
  'hover':       ['rgba(255,255,255,.055)', 'rgba(28,27,24,.045)'],
  'press':       ['rgba(255,255,255,.085)', 'rgba(28,27,24,.075)'],
  'field':       ['rgba(0,0,0,.28)', 'rgba(255,255,255,.85)'],

  // ── Lijnen en randen van het glas ─────────────────────────────────────────
  'line':        ['rgba(255,255,255,.075)', 'rgba(28,27,24,.08)'],
  'line-2':      ['rgba(255,255,255,.12)', 'rgba(28,27,24,.13)'],
  'line-3':      ['rgba(255,255,255,.2)', 'rgba(28,27,24,.22)'],
  'edge-hi':     ['rgba(255,255,255,.13)', 'rgba(255,255,255,1)'],
  'edge-lo':     ['rgba(255,255,255,.025)', 'rgba(255,255,255,.4)'],
  'sheen':       ['rgba(255,255,255,.06)', 'rgba(255,206,92,.16)'],
  // Focus: in Dag goud-als-tekst, zodat de ring 3:1 haalt op glas en papier
  'focus':       ['#F7C548', '#855800'],

  // ── Inkt (AA ≥ 4,5:1 op glas boven het felste toegestane licht) ───────────
  'ink':         ['#F4F3F0', '#1C1B18'],
  'ink-2':       ['#BAB8B2', '#4E4B44'],
  'ink-3':       ['#97958F', '#615D55'],
  'ink-4':       ['#5F5E5A', '#A8A49B'],

  // ── Zongoud: vulling, tekst, tekst-op-goud ────────────────────────────────
  'gold':        ['#F7C548', '#F4BC2E'],
  'gold-hover':  ['#FFD467', '#F7C94F'],
  'gold-ink':    ['#F7C548', '#855800'],
  'on-gold':     ['#1A1405', '#1C1405'],
  'gold-soft':   ['rgba(247,197,72,.13)', 'rgba(244,188,46,.17)'],
  'gold-line':   ['rgba(247,197,72,.42)', 'rgba(133,88,0,.32)'],
  'gold-glow':   ['rgba(247,197,72,.46)', 'rgba(244,188,46,.55)'],

  // ── Betekenis ─────────────────────────────────────────────────────────────
  'ok':          ['#4CD9A0', '#0B6B4E'],
  'warn':        ['#FFA24C', '#A3470A'],
  'danger':      ['#FF6B72', '#BD1F31'],
  'info':        ['#6CB6FF', '#1A5FBA'],
  'ok-soft':     ['rgba(76,217,160,.13)', 'rgba(11,107,78,.09)'],
  'warn-soft':   ['rgba(255,162,76,.14)', 'rgba(163,71,10,.09)'],
  'danger-soft': ['rgba(255,107,114,.14)', 'rgba(189,31,49,.08)'],
  'info-soft':   ['rgba(108,182,255,.14)', 'rgba(26,95,186,.08)'],

  // ── Poollicht: alles wat Gerrie doet ──────────────────────────────────────
  'ai-1':        ['#A392FF', '#6E5AE6'],
  'ai-2':        ['#6CC4FF', '#1F9BE0'],
  'ai-3':        ['#F7C548', '#E0A11B'],
  'ai-ink':      ['#B8AAFF', '#5E48D6'],
  'ai-soft':     ['rgba(163,146,255,.10)', 'rgba(110,90,230,.07)'],
  'ai-line':     ['rgba(163,146,255,.38)', 'rgba(110,90,230,.32)'],
  'on-ai':       ['#0B0A14', '#FFFFFF'],
  // Tekst die los op het lichtveld staat (groet, koppen) krijgt in Nacht een donkere gloed
  'field-shadow':['0 1px 18px rgba(7,7,10,.6), 0 0 2px rgba(7,7,10,.35)', 'none'],
  // De naam in de groet: in Nacht een gouden verloop, in Dag effen goud-als-tekst (AA)
  'hello-fill':  ['linear-gradient(170deg,#FFE79E 0%,#F7C548 48%,#E8A626 100%)', 'linear-gradient(#855800,#855800)'],

  // ── De stroom: maanlicht wordt zongoud ────────────────────────────────────
  // Links (een gesprek) koel en zilver, rechts (betaald) goud. Het poollicht
  // blijft van Gerrie; de stroom zelf heeft het merklicht.
  'flow-1':      ['#AEB6D0', '#7E859C'],
  'flow-2':      ['#F7C548', '#D99A12'],
  'flow-body':   ['.16', '.20'],
  'flow-edge':   ['.55', '.55'],
  'flow-add':    ['lighter', 'source-over'],

  // ── Diepte ────────────────────────────────────────────────────────────────
  'shadow-1':    ['inset 0 1px 0 rgba(255,255,255,.05), 0 1px 2px rgba(0,0,0,.4)', 'inset 0 1px 0 rgba(255,255,255,.9), 0 1px 2px rgba(40,34,20,.06)'],
  'shadow-glass':['inset 0 1px 0 rgba(255,255,255,.06), 0 28px 56px -32px rgba(0,0,0,.92)', 'inset 0 1px 0 rgba(255,255,255,.95), 0 1px 2px rgba(40,34,20,.04), 0 26px 50px -30px rgba(70,56,28,.30)'],
  'shadow-pop':  ['0 0 0 1px rgba(255,255,255,.07), 0 44px 100px -28px rgba(0,0,0,.95), 0 12px 30px -12px rgba(0,0,0,.6)', '0 0 0 1px rgba(28,27,24,.06), 0 44px 90px -30px rgba(70,56,28,.42), 0 10px 26px -14px rgba(70,56,28,.25)'],
  'scrim':       ['rgba(5,5,8,.55)', 'rgba(236,234,228,.5)'],

  // ── Papier: een factuur is altijd papier ──────────────────────────────────
  'paper':       ['#FFFFFF', '#FFFFFF'],
  'paper-ink':   ['#1C1B18', '#1C1B18'],
  'paper-ink-2': ['#5A574F', '#5A574F'],
  'paper-line':  ['#E8E5DE', '#E8E5DE'],
  'paper-shadow':['0 1px 0 rgba(255,255,255,.4) inset, 0 50px 100px -30px rgba(0,0,0,.9), 0 20px 40px -20px rgba(0,0,0,.7)', '0 50px 90px -34px rgba(70,56,28,.45), 0 16px 34px -18px rgba(70,56,28,.30)'],
};

// Gelijk in beide thema's
export const shared = {
  'font': "'Poppins', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  'r-xs': '6px', 'r-sm': '9px', 'r-md': '12px', 'r-lg': '16px', 'r-xl': '20px', 'r-2xl': '26px', 'r-3xl': '32px', 'r-pill': '999px',
  'ease': 'cubic-bezier(.2,.8,.2,1)',
  'ease-out': 'cubic-bezier(.16,1,.3,1)',
  // Een echte veer (CSS linear()), met een terugval voor oudere browsers in base.css
  'spring': 'linear(0, .009, .035 2.1%, .141, .281 6.7%, .723 12.9%, .938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, .991, .977 51%, .974 53.8%, .975 57.1%, .997 69.8%, 1.003 76.9%, 1)',
  'spring-soft': 'linear(0, .016, .063 3.3%, .25 7.3%, .5 12.2%, .708 17.3%, .844 22.2%, .931 27.4%, .978 33%, 1.004 39.6%, 1.012 47%, 1.008 58%, 1)',
  't-1': '120ms', 't-2': '220ms', 't-3': '380ms', 't-4': '900ms',
  'aurora': 'linear-gradient(115deg, var(--ai-1), var(--ai-2) 52%, var(--ai-3))',
  'aurora-conic': 'conic-gradient(from var(--spin, 0deg), var(--ai-1), var(--ai-2), var(--ai-3), var(--ai-1))',
  'gold-face': 'linear-gradient(160deg, #FFE38F 0%, #F7C548 46%, #E5A11F 100%)',
  'flow': 'linear-gradient(90deg, var(--flow-1), var(--flow-2))',
};
