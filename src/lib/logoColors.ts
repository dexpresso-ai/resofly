// Kleuren uit een logo. Twee vragen, één telling:
//
// 1. Welke kleuren zitten erin? Bij Instellingen → Huisstijl staan die als
//    knopjes onder de merkkleur en de kopkleur: niet iedereen kent de hexcodes
//    van zijn eigen merk, maar iedereen herkent zijn logo.
// 2. Hoe licht of donker is het logo als geheel? Dat bepaalt of het op de kop
//    van het portaal op een plaatje moet (zie `logoNeedsPlate()` in branding.ts).
//
// Het rekenwerk staat los van de browser (`summarizeLogoPixels`), zodat het te
// testen is; `analyseLogo` tekent het logo klein op een canvas en telt daar.

export type LogoSummary = {
  /** Gemiddelde kleur van het zichtbare logo; null als er niets zichtbaars in zit. */
  ink: string | null;
  /** De meest voorkomende, onderling verschillende kleuren; hoogstens vier. */
  colors: string[];
};

const MAX_COLORS = 4;
/** Twee kleuren die dichter bij elkaar liggen (RGB-afstand) tellen als één. */
const DISTINCT = 70;

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function distance(a: string, b: string): number {
  const x = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const y = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * Telt RGBA-pixels (zoals `ImageData.data`). Doorzichtige pixels tellen niet
 * mee. Voor de kleurvoorstellen telt wit ook niet mee: dat is bijna altijd de
 * achtergrond van een jpg, niet het merk. Voor de gemiddelde kleur juist wel,
 * want een logo op een wit vlak ís op de kop een wit vlak.
 */
export function summarizeLogoPixels(data: ArrayLike<number>): LogoSummary {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let n = 0;
  let rs = 0;
  let gs = 0;
  let bs = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 160) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    n += 1; rs += r; gs += g; bs += b;
    if (Math.min(r, g, b) > 236) continue;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1; bucket.r += r; bucket.g += g; bucket.b += b;
    buckets.set(key, bucket);
  }
  const ranked = [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .map(bucket => toHex(bucket.r / bucket.n, bucket.g / bucket.n, bucket.b / bucket.n));
  const colors: string[] = [];
  for (const color of ranked) {
    if (colors.every(existing => distance(existing, color) > DISTINCT)) colors.push(color);
    if (colors.length === MAX_COLORS) break;
  }
  return { ink: n ? toHex(rs / n, gs / n, bs / n) : null, colors };
}

/** Tekent het logo op 72 px breed en telt de pixels. Alleen in de browser. */
export async function analyseLogo(src: string): Promise<LogoSummary> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const width = 72;
  const height = Math.max(1, Math.round((width * image.naturalHeight) / Math.max(1, image.naturalWidth)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { ink: null, colors: [] };
  context.drawImage(image, 0, 0, width, height);
  return summarizeLogoPixels(context.getImageData(0, 0, width, height).data);
}
