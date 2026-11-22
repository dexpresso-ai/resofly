/**
 * Een kleine DOMParser voor de tests van de CAMT-lezer (camt053.test.ts).
 * Node heeft geen DOMParser, en de lezer gebruikt er maar een paar dingen van:
 * getElementsByTagNameNS('*', naam), textContent, getAttribute en
 * querySelector('parsererror'). Niet voor de app: daar is de DOMParser van de
 * browser.
 */

class TestElement {
  readonly children: TestElement[] = [];
  readonly tagName: string;
  private readonly parts: Array<string | TestElement> = [];
  private readonly attrs: Record<string, string>;
  // Geen parameter properties: Node haalt alleen de types weg en kent die niet.
  constructor(tagName: string, attrs: Record<string, string>) {
    this.tagName = tagName;
    this.attrs = attrs;
  }

  get localName(): string { return this.tagName.includes(':') ? this.tagName.split(':').pop() as string : this.tagName; }
  get textContent(): string { return this.parts.map(p => (typeof p === 'string' ? p : p.textContent)).join(''); }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  append(part: string | TestElement): void {
    this.parts.push(part);
    if (typeof part !== 'string') this.children.push(part);
  }
  getElementsByTagNameNS(_ns: string, local: string): TestElement[] {
    const out: TestElement[] = [];
    const walk = (el: TestElement) => {
      for (const child of el.children) {
        if (local === '*' || child.localName === local) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

function parse(xml: string): { root: TestElement; error: boolean } {
  const root = new TestElement('#document', {});
  const stack: TestElement[] = [root];
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  let error = false;
  while ((m = token.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[7]) { error = true; break; }
    if (m[1] !== undefined) { top.append(m[1]); continue; }
    if (m[6] !== undefined) { top.append(decode(m[6])); continue; }
    if (!m[3]) continue; // commentaar of <?xml ?>
    if (m[2] === '/') {
      if (top.tagName !== m[3] || stack.length < 2) { error = true; break; }
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
    const el = new TestElement(m[3], attrs);
    top.append(el);
    if (m[5] !== '/') stack.push(el);
  }
  if (stack.length !== 1 || root.children.length !== 1) error = true;
  return { root, error };
}

export class TestDomParser {
  parseFromString(xml: string, _type: string) {
    const { root, error } = parse(xml);
    return {
      getElementsByTagNameNS: (ns: string, local: string) => root.getElementsByTagNameNS(ns, local),
      querySelector: (selector: string) => (selector === 'parsererror' && error ? new TestElement('parsererror', {}) : null),
    };
  }
}

/** Zet de test-DOMParser klaar als er geen echte is. */
export function installTestDomParser(): void {
  const g = globalThis as unknown as { DOMParser?: unknown };
  if (typeof g.DOMParser === 'undefined') g.DOMParser = TestDomParser;
}
