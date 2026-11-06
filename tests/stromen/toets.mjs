// Een kleine testloper: stappen na elkaar, een fout stopt de rest niet (zo
// zie je alles wat misgaat in één ronde), en aan het eind een telling.
export const resultaten = [];
let groepNaam = '';

export function groep(naam) {
  groepNaam = naam;
  console.log(`\n## ${naam}`);
}

export async function stap(naam, fn) {
  try {
    const uitkomst = await fn();
    resultaten.push({ groep: groepNaam, naam, ok: true });
    console.log(`  ok    ${naam}`);
    return uitkomst;
  } catch (error) {
    resultaten.push({ groep: groepNaam, naam, ok: false, fout: error });
    const regels = String(error?.stack || error).split('\n').slice(0, 5).join('\n        ');
    console.log(`  FOUT  ${naam}\n        ${regels}`);
    return undefined;
  }
}

export function verwacht(voorwaarde, melding) {
  if (!voorwaarde) throw new Error(melding);
}

export function gelijk(werkelijk, verwachtWaarde, melding) {
  const a = JSON.stringify(werkelijk);
  const b = JSON.stringify(verwachtWaarde);
  if (a !== b) throw new Error(`${melding}: verwacht ${b}, kreeg ${a}`);
}

function kort(res) {
  return `${res.status} ${String(res.tekst ?? '').slice(0, 400)}`;
}

/** Een functie- of REST-antwoord dat gelukt is. */
export function gelukt(res, melding) {
  if (res.status < 200 || res.status >= 300 || res.json?.ok === false) {
    throw new Error(`${melding}: ${kort(res)}`);
  }
  return res.json;
}

/** Een nette weigering: 4xx, en geen ok:true. Een 5xx is een fout, geen weigering. */
export function geweigerd(res, melding, statussen) {
  const ok = statussen ? statussen.includes(res.status) : res.status >= 400 && res.status < 500;
  if (!ok || res.json?.ok === true) throw new Error(`${melding}: verwacht een weigering, kreeg ${kort(res)}`);
  return res.json;
}

/** Een REST-schrijfpoging die niets mag veranderen: een fout, of 0 rijen geraakt. */
export function nietsVeranderd(res, melding) {
  const rijen = Array.isArray(res.json) ? res.json.length : null;
  if (res.status >= 200 && res.status < 300 && rijen !== 0) {
    throw new Error(`${melding}: verwacht geen wijziging, kreeg ${kort(res)}`);
  }
}

export function samenvatting() {
  const fout = resultaten.filter((r) => !r.ok);
  console.log(`\n${resultaten.length} stappen, ${fout.length} fout.`);
  for (const r of fout) console.log(`  FOUT  [${r.groep}] ${r.naam}`);
  return fout.length;
}
