import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';

// Realtime-kanalen voor presence en broadcast zijn standaard publiek: iedereen
// met de anon-sleutel (die in de frontendbundel staat) kan ze openen, ook
// zonder in te loggen. Daarom moet elk kanaal dat presence of broadcast
// gebruikt `private: true` hebben, met een regel op realtime.messages die
// zegt wie erin mag (zie migratie 20261101170000). Kanalen die alleen
// databasewijzigingen volgen (postgres_changes) vallen onder de RLS van de
// tabellen en mogen publiek blijven.

function sourceFiles(dir: URL, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = new URL(name, dir);
    if (statSync(full).isDirectory()) {
      sourceFiles(new URL(`${name}/`, dir), out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full.pathname);
    }
  }
  return out;
}

/**
 * Elke `.channel(`-aanroep, met het gebruik ervan: de code tot en met de regel
 * van de eerste `.subscribe(` en nog een stukje daarna (daar staat meestal de
 * `.track(` of `.send(`), en nooit voorbij het volgende kanaal.
 */
function channelSegments(source: string): Array<{ call: string; usage: string; line: number }> {
  const segments: Array<{ call: string; usage: string; line: number }> = [];
  const pattern = /\.channel\(/g;
  const starts: number[] = [];
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) starts.push(match.index);
  starts.forEach((start, index) => {
    const next = index + 1 < starts.length ? starts[index + 1] : source.length;
    const subscribe = source.indexOf('.subscribe(', start);
    let end = Math.min(next, start + 2500);
    if (subscribe !== -1 && subscribe < next) {
      const subscribeLineEnd = source.indexOf('\n', subscribe);
      end = Math.min(next, (subscribeLineEnd === -1 ? source.length : subscribeLineEnd) + 300);
    }
    const lineEnd = source.indexOf('\n', start);
    segments.push({
      call: source.slice(start, lineEnd === -1 ? next : Math.min(lineEnd, next)),
      usage: source.slice(start, end),
      line: source.slice(0, start).split('\n').length,
    });
  });
  return segments;
}

test('elk presence- en broadcastkanaal is privé', () => {
  const files = sourceFiles(new URL('../', import.meta.url));
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('.channel(')) continue;
    for (const segment of channelSegments(source)) {
      const usesBroadcastOrPresence =
        /['"]presence['"]|['"]broadcast['"]|\bpresence\s*:|\bbroadcast\s*:|\.track\(/.test(segment.usage);
      if (usesBroadcastOrPresence && !/private:\s*true/.test(segment.call)) {
        offenders.push(`${file.split('/src/')[1] ?? file}:${segment.line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Publiek Realtime-kanaal met presence of broadcast: ${offenders.join(', ')}`);
});

test('de teamchat-kanalen staan in de regels van de migratie', () => {
  const migration = readFileSync(
    new URL('../../supabase/migrations/20261101170000_realtime_private_chat_channels.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /\^chat:presence:/);
  assert.match(migration, /\^chat:typing:/);
  const chat = readFileSync(new URL('../components/teamchat/useTeamChat.ts', import.meta.url), 'utf8');
  const typing = readFileSync(new URL('../components/teamchat/ConversationView.tsx', import.meta.url), 'utf8');
  assert.match(chat, /channel\(`chat:presence:\$\{organizationId\}`, \{ config: \{ private: true/);
  assert.match(typing, /channel\(`chat:typing:\$\{conversationId\}`, \{ config: \{ private: true/);
});
