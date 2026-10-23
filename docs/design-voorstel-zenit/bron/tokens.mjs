// Zenit — tokens. Eén bron, twee lichten: [Nacht, Dag].
// De build schrijft hier drie blokken van: :root + .tn (Nacht, de standaard),
// @media (prefers-color-scheme: light) en [data-theme="light"] + .td (Dag).
// .tn / .td zetten een thema lokaal vast (de rail is altijd Nacht, telefoons
// in het voorstel tonen één vast licht).
export const themed = {
  // Vlakken: grond → werkvlak → kaart → verhoogd → ingedrukt
  'ground':      ['#08080A', '#EDEBE5'],
  'canvas':      ['#0F0F12', '#FAF9F6'],
  'surface':     ['#15151A', '#FFFFFF'],
  'surface-2':   ['#1B1B21', '#F6F5F1'],
  'surface-3':   ['#23232A', '#EEEDE8'],
  'field':       ['#0C0C0F', '#FFFFFF'],
  'raised':      ['#26262D', '#FFFFFF'],
  // Lijnen
  'line':        ['rgba(255,255,255,.075)', '#E7E5E0'],
  'line-2':      ['rgba(255,255,255,.115)', '#DAD7D0'],
  'line-3':      ['rgba(255,255,255,.18)', '#C7C3BA'],
  // Inkt (AA ≥ 4,5:1 op kaart, werkvlak én grond)
  'ink':         ['#F4F3F0', '#1C1B18'],
  'ink-2':       ['#B5B3AD', '#55524B'],
  'ink-3':       ['#908E88', '#67635B'],
  'ink-4':       ['#5E5D59', '#A8A49B'],
  // Zongoud: vulling, tekst, tekst-op-goud
  'gold':        ['#F7C548', '#F4BC2E'],
  'gold-hover':  ['#FFD467', '#F7C94F'],
  'gold-ink':    ['#F7C548', '#855800'],
  'on-gold':     ['#1A1405', '#1C1405'],
  'gold-soft':   ['rgba(247,197,72,.12)', 'rgba(244,188,46,.16)'],
  'gold-line':   ['rgba(247,197,72,.38)', 'rgba(133,88,0,.30)'],
  'gold-glow':   ['rgba(247,197,72,.42)', 'rgba(244,188,46,.50)'],
  // Betekenis
  'ok':          ['#4CD9A0', '#0B6B4E'],
  'warn':        ['#FFA24C', '#A3470A'],
  'danger':      ['#FF6B72', '#BD1F31'],
  'info':        ['#6CB6FF', '#1A5FBA'],
  'ok-soft':     ['rgba(76,217,160,.12)', 'rgba(11,107,78,.09)'],
  'warn-soft':   ['rgba(255,162,76,.13)', 'rgba(163,71,10,.09)'],
  'danger-soft': ['rgba(255,107,114,.13)', 'rgba(189,31,49,.08)'],
  'info-soft':   ['rgba(108,182,255,.13)', 'rgba(26,95,186,.08)'],
  // Poollicht: de laag van Gerrie
  'ai-1':        ['#A392FF', '#6E5AE6'],
  'ai-2':        ['#6CC4FF', '#1F9BE0'],
  'ai-3':        ['#F7C548', '#E0A11B'],
  'ai-ink':      ['#B8AAFF', '#5E48D6'],
  'ai-soft':     ['rgba(163,146,255,.09)', 'rgba(110,90,230,.06)'],
  'ai-line':     ['rgba(163,146,255,.36)', 'rgba(110,90,230,.30)'],
  // Lucht van de Dagboog
  'sky-1':       ['#16131F', '#FFF4D6'],
  'sky-2':       ['#0F0F12', '#FFFDF8'],
  'sky-haze':    ['rgba(163,146,255,.14)', 'rgba(244,188,46,.20)'],
  'star':        ['rgba(255,255,255,.75)', 'rgba(28,27,24,0)'],
  // Diepte
  'hi':          ['rgba(255,255,255,.045)', 'rgba(255,255,255,.9)'],
  'shadow-1':    ['inset 0 1px 0 rgba(255,255,255,.04), 0 1px 2px rgba(0,0,0,.35)', '0 1px 2px rgba(28,27,24,.05), 0 1px 1px rgba(28,27,24,.03)'],
  'shadow-2':    ['inset 0 1px 0 rgba(255,255,255,.045), 0 18px 40px -22px rgba(0,0,0,.85)', '0 1px 2px rgba(28,27,24,.05), 0 16px 36px -20px rgba(28,27,24,.22)'],
  'shadow-pop':  ['0 0 0 1px rgba(255,255,255,.08), 0 30px 80px -20px rgba(0,0,0,.9)', '0 0 0 1px rgba(28,27,24,.07), 0 30px 70px -24px rgba(28,27,24,.35)'],
  'shadow-canvas':['0 0 0 1px rgba(255,255,255,.065), 0 30px 60px -30px rgba(0,0,0,.9)', '0 0 0 1px rgba(28,27,24,.055), 0 1px 2px rgba(28,27,24,.04), 0 24px 60px -30px rgba(28,27,24,.28)'],
  'scrim':       ['rgba(4,4,6,.62)', 'rgba(28,27,24,.26)'],
  'grid':        ['rgba(255,255,255,.06)', '#ECEAE5'],
  'paper':       ['#FFFFFF', '#FFFFFF'],
  'paper-ink':   ['#1C1B18', '#1C1B18'],
};

// Gelijk in beide thema's
export const shared = {
  'font': "'Poppins', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  'r-xs': '6px', 'r-sm': '8px', 'r-md': '10px', 'r-lg': '14px', 'r-xl': '16px', 'r-2xl': '20px', 'r-pill': '999px',
  'ease': 'cubic-bezier(.2,.8,.2,1)',
  'ease-out': 'cubic-bezier(.16,1,.3,1)',
  'spring': 'cubic-bezier(.34,1.45,.64,1)',
  't-1': '120ms', 't-2': '200ms', 't-3': '320ms', 't-4': '700ms',
  'aurora': 'linear-gradient(115deg, var(--ai-1), var(--ai-2) 52%, var(--ai-3))',
  'gold-face': 'linear-gradient(150deg, #FFE08A 0%, #F6C143 48%, #E4A11C 100%)',
};
