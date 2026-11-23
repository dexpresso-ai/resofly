import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeekable, type SeekableAudio } from './audioSeek.ts';

/**
 * Een nagebootste <audio>. `meetsAt` is wat de echte browser doet: zodra er ver
 * voorbij het einde gezocht wordt, meet hij het bestand door en verandert de
 * duur in `lengthSeconds`. `null` is een browser waar dat niet werkt.
 */
function fakeAudio(opts: { duration: number; lengthSeconds: number | null; paused?: boolean; currentTime?: number }) {
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  let currentTime = opts.currentTime ?? 0;
  const audio: SeekableAudio & { calls: string[] } = {
    duration: opts.duration,
    paused: opts.paused ?? true,
    calls,
    get currentTime() { return currentTime; },
    set currentTime(value: number) {
      calls.push(`currentTime=${value}`);
      currentTime = value;
      if (value > 1e100 && opts.lengthSeconds !== null) {
        audio.duration = opts.lengthSeconds;
        queueMicrotask(() => listeners.forEach((fn) => fn()));
      }
    },
    addEventListener: (_type, fn) => { listeners.add(fn); },
    removeEventListener: (_type, fn) => { listeners.delete(fn); },
    play: async () => { calls.push('play'); },
  };
  return audio;
}

test('een opname met oneindige duur wordt gemeten, en de plek blijft waar hij was', async () => {
  const audio = fakeAudio({ duration: Infinity, lengthSeconds: 3600, currentTime: 0 });
  assert.equal(await makeSeekable(audio), true);
  assert.equal(audio.duration, 3600);
  assert.equal(audio.currentTime, 0, 'terug aan het begin, niet aan het einde');
});

test('een opname waar al een duur in zit blijft ongemoeid', async () => {
  const audio = fakeAudio({ duration: 1800, lengthSeconds: 1800 });
  assert.equal(await makeSeekable(audio), true);
  assert.deepEqual(audio.calls, [], 'geen zoekactie, dus niets om te herstellen');
});

test('wie al luistert gaat na de meting verder waar hij was', async () => {
  const audio = fakeAudio({ duration: Infinity, lengthSeconds: 600, paused: false, currentTime: 42 });
  assert.equal(await makeSeekable(audio), true);
  assert.equal(audio.currentTime, 42);
  assert.deepEqual(audio.calls, ['currentTime=1e+101', 'currentTime=42', 'play']);
});

test('lukt het meten niet, dan blijft het niet hangen en weet de speler dat', async () => {
  const audio = fakeAudio({ duration: Infinity, lengthSeconds: null, currentTime: 5 });
  assert.equal(await makeSeekable(audio, 20), false);
  assert.equal(audio.currentTime, 5);
});
