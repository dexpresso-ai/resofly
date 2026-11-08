import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * Transcriptie telt mee in het AI-budget (transcriptionUsage.ts): de duur die
 * we rekenen, de kosten, de rij in ai_usage, en dat geen route audio naar
 * ElevenLabs stuurt zonder eerst het budget te controleren.
 */

const env = new Map<string, string>();
(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (name: string) => env.get(name) } };

const {
  billableSeconds, DEFAULT_SCRIBE_USD_PER_HOUR, recordTranscriptionUsage, scribeUsageModel, scribeUsdPerHour,
  transcriptionCostUsd, transcriptionRefusal,
} = await import('./transcriptionUsage.ts');

const seg = (start: number, end: number) => ({ speaker: 'Spreker 1', text: 'x', start, end });

test('uurtarief: leeg of ongeldig = $0,40, "0" = gratis', () => {
  assert.equal(scribeUsdPerHour(undefined), DEFAULT_SCRIBE_USD_PER_HOUR);
  assert.equal(scribeUsdPerHour(''), 0.40);
  assert.equal(scribeUsdPerHour('abc'), 0.40);
  assert.equal(scribeUsdPerHour('-1'), 0.40);
  assert.equal(scribeUsdPerHour('0'), 0);
  assert.equal(scribeUsdPerHour('0.22'), 0.22);
});

test('de duur: de langste van browser en transcript, naar boven afgerond', () => {
  // De browser stuurde 0 mee (de oude fout); het transcript loopt tot 43,76 s.
  assert.equal(billableSeconds(0, [seg(0, 12), seg(12, 43.759)]), 44);
  // Een opname die eindigt met stilte: de browser weet het beter.
  assert.equal(billableSeconds(60, [seg(0, 43.759)]), 60);
  // Een te lage of onzinnige waarde van de browser verlaagt de kosten niet.
  assert.equal(billableSeconds(-5, [seg(0, 10)]), 10);
  assert.equal(billableSeconds(Number.NaN, [seg(0, 10)]), 10);
  assert.equal(billableSeconds(null, []), 0);
});

test('kosten: per uur, op vier decimalen', () => {
  assert.equal(transcriptionCostUsd(3600, 0.40), 0.40);
  assert.equal(transcriptionCostUsd(44, 0.40), 0.0049);
  assert.equal(transcriptionCostUsd(0, 0.40), 0);
  assert.equal(transcriptionCostUsd(3600, 0), 0);
});

test('model in ai_usage: elevenlabs/<model>', () => {
  assert.equal(scribeUsageModel(undefined), 'elevenlabs/scribe_v1');
  assert.equal(scribeUsageModel('scribe_v2'), 'elevenlabs/scribe_v2');
});

test('weigering zegt dat de opname bewaard is', () => {
  const zin = transcriptionRefusal({ allowed: false, usedEur: 25, limitEur: 25, scope: 'user' });
  assert.match(zin, /AI-tegoed/);
  assert.match(zin, /De opname is bewaard/);
});

type Call = { table: string; op: string; values: Record<string, unknown>; filters: Array<[string, unknown]> };

function fakeAdmin(insertError: { code?: string; message: string } | null = null) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      return {
        async insert(values: Record<string, unknown>) {
          calls.push({ table, op: 'insert', values, filters: [] });
          return { error: insertError };
        },
        update(values: Record<string, unknown>) {
          const call: Call = { table, op: 'update', values, filters: [] };
          calls.push(call);
          const q = {
            eq(column: string, value: unknown) { call.filters.push([column, value]); return q; },
            then(resolve: (r: { error: null }) => void) { resolve({ error: null }); },
          };
          return q;
        },
      };
    },
  };
}

const REC = { id: 'rec-1', organization_id: 'org-1', created_by: 'user-1', duration_seconds: 0 };

test('een transcriptie wordt één rij in ai_usage, op naam van de maker, en de opname krijgt duur en kosten', async () => {
  env.clear();
  const admin = fakeAdmin();
  const uit = await recordTranscriptionUsage(admin as never, REC, [seg(0, 43.759)]);
  assert.deepEqual(uit, { seconds: 44, costUsd: 0.0049, recorded: true });
  const [insert, update] = admin.calls;
  assert.equal(insert.table, 'ai_usage');
  assert.deepEqual(insert.values, {
    organization_id: 'org-1', user_id: 'user-1', model: 'elevenlabs/scribe_v1',
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    cost_usd: 0.0049, transcribed_recording_id: 'rec-1',
  });
  assert.equal(update.table, 'meeting_recordings');
  assert.deepEqual(update.values, { duration_seconds: 44, transcription_cost_usd: 0.0049 });
  // Ook hier de organisatie als filter (service-role, dus geen RLS).
  assert.deepEqual(update.filters, [['id', 'rec-1'], ['organization_id', 'org-1']]);
});

test('het tarief uit ELEVENLABS_USD_PER_HOUR telt', async () => {
  env.clear();
  env.set('ELEVENLABS_USD_PER_HOUR', '0.80');
  const admin = fakeAdmin();
  const uit = await recordTranscriptionUsage(admin as never, { ...REC, duration_seconds: 3600 }, []);
  assert.equal(uit.costUsd, 0.8);
  env.clear();
});

test('een tweede keer voor dezelfde opname (unieke index) is geen fout en telt niet nog eens', async () => {
  const admin = fakeAdmin({ code: '23505', message: 'duplicate key value violates unique constraint' });
  const fouten: unknown[] = [];
  const origineel = console.error;
  console.error = (...args: unknown[]) => { fouten.push(args); };
  try {
    const uit = await recordTranscriptionUsage(admin as never, REC, [seg(0, 10)]);
    assert.equal(uit.recorded, false);
  } finally {
    console.error = origineel;
  }
  assert.deepEqual(fouten, []);
});

// ── Bronregels: geen route naar ElevenLabs zonder budget, en de kosten tellen mee ──

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('elke route die audio naar ElevenLabs stuurt, controleert eerst het AI-budget', () => {
  const files: string[] = [];
  for (const dir of readdirSync(root)) {
    const full = new URL(`${dir}/`, root);
    if (!statSync(full).isDirectory()) continue;
    for (const name of readdirSync(full)) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(`${dir}/${name}`);
    }
  }
  const callers = files.filter((file) => file !== '_shared/elevenlabs.ts' && /\brequestTranscription\(/.test(read(file)));
  assert.ok(callers.length > 0, 'requestTranscription wordt nergens aangeroepen?');
  for (const file of callers) {
    const source = read(file);
    const budget = source.indexOf('await transcriptionBudget(');
    const call = source.indexOf('requestTranscription(bytes');
    assert.ok(budget > -1 && call > -1 && budget < call, `${file}: roep transcriptionBudget aan vóór requestTranscription`);
  }
});

test('een binnengekomen transcript wordt afgerekend vóór de notulen (die het budget opnieuw wegen)', () => {
  const pipeline = read('_shared/meetingPipeline.ts');
  const complete = pipeline.slice(pipeline.indexOf('export async function completeTranscription'));
  const usage = complete.indexOf('await recordTranscriptionUsage(');
  const summary = complete.indexOf('runSummaryForRecording(');
  assert.ok(usage > -1 && summary > -1 && usage < summary, 'recordTranscriptionUsage moet vóór runSummaryForRecording');
  // De synchrone route en de webhook gaan allebei langs completeTranscription.
  assert.match(read('meeting-transcribe/index.ts'), /await completeTranscription\(admin, recordingId, transcript!\)/);
  assert.match(read('meeting-transcribe-webhook/index.ts'), /await completeTranscription\(admin, String\(rec\.id\), normalizeTranscript\(payload\)\)/);
});
