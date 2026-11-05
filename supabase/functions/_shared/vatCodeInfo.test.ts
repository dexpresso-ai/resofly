/**
 * De btw-codes voor de verplichte vermeldingen op de PDF (vatCodeInfo.ts). Stond
 * eerst letterlijk in invoice-workflow én quote-workflow. Draaien met: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadVatCodeInfo } from './vatCodeInfo.ts';

function fakeAdmin(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ table: string; columns: string; filters: Record<string, string> }> = [];
  return {
    calls,
    from(table: string) {
      const call = { table, columns: '', filters: {} as Record<string, string> };
      calls.push(call);
      const chain = {
        select(columns: string) { call.columns = columns; return chain; },
        eq(column: string, value: string) { call.filters[column] = value; return chain; },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
  };
}

test('per code de soort en de rubriek, alleen van de eigen organisatie, ook codes die uit staan', async () => {
  const admin = fakeAdmin({ data: [{ code: 'VL', kind: 'reverse_charge_sales', sales_box: '1e' }, { code: 'EX', kind: 'zero', sales_box: null }], error: null });
  const codes = await loadVatCodeInfo(admin as never, 'org-1');
  assert.deepEqual(codes, { VL: { kind: 'reverse_charge_sales', salesBox: '1e' }, EX: { kind: 'zero', salesBox: null } });
  assert.deepEqual(admin.calls, [{ table: 'vat_codes', columns: 'code,kind,sales_box', filters: { organization_id: 'org-1' } }]);
});

test('een fout houdt de PDF niet tegen: dan zonder vermeldingen', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await loadVatCodeInfo(fakeAdmin({ data: null, error: { message: 'kapot' } }) as never, 'org-1'), {});
  } finally {
    console.warn = warn;
  }
});

test('de workflows hebben geen eigen kopie meer', () => {
  for (const path of ['../invoice-workflow/index.ts', '../quote-workflow/index.ts']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /async function loadVatCodeInfo/, path);
    assert.match(source, /import \{ loadVatCodeInfo \} from '\.\.\/_shared\/vatCodeInfo\.ts';/, path);
  }
});
