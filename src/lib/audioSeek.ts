/**
 * Maakt een opname uit de browser spoelbaar.
 *
 * `MediaRecorder` schrijft webm zonder duur en zonder index: bij het opnemen
 * is nog niet bekend hoe lang het wordt. Een <audio> meldt dan `Infinity` als
 * duur en heeft geen `seekable`-bereik, dus de tijdlijn in de speler blijft
 * dood. Het gevolg: een vergadering van een uur moest je ook een uur
 * beluisteren, want je kon niet naar het stuk dat je zocht.
 *
 * Zoeken naar een tijdstip ver voorbij het einde dwingt de browser het
 * bestand eenmalig door te meten. Daarna is de duur gewoon een getal en werkt
 * spoelen. Dit staat bewust aan de afspeelkant en niet bij het opnemen: zo
 * profiteren ook de opnames die al bewaard zijn.
 */

/** Het stukje van <audio> dat we nodig hebben; zo kan een test het nabootsen. */
export interface SeekableAudio {
  duration: number;
  currentTime: number;
  readonly paused: boolean;
  addEventListener(type: 'durationchange', listener: () => void): void;
  removeEventListener(type: 'durationchange', listener: () => void): void;
  play(): Promise<void>;
}

/** Ruim voorbij elke denkbare opname; de browser kapt dit af op het einde. */
const FAR_BEYOND_END = 1e101;

/**
 * Zorgt dat `audio.duration` een getal is. Geeft `true` als het spoelen nu kan.
 * Lukt het niet (andere browser, kapot bestand), dan geeft het `false` terug
 * binnen `timeoutMs` in plaats van te blijven hangen: de speler blijft dan
 * werken zoals hij deed, alleen zonder spoelen.
 */
export function makeSeekable(audio: SeekableAudio, timeoutMs = 4000): Promise<boolean> {
  if (Number.isFinite(audio.duration)) return Promise.resolve(true);

  return new Promise((resolve) => {
    // Zoeken naar het einde zet de speler stil en de tijd op de laatste
    // seconde. Wie al afspeelt of verder was, krijgt zijn plek terug.
    const resumeAt = audio.currentTime;
    const wasPlaying = !audio.paused;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function finish() {
      if (finished) return;
      finished = true;
      audio.removeEventListener('durationchange', onDurationChange);
      if (timer) clearTimeout(timer);
      audio.currentTime = resumeAt;
      if (wasPlaying) audio.play().catch(() => { /* de gebruiker drukt zelf opnieuw op afspelen */ });
      resolve(Number.isFinite(audio.duration));
    }

    function onDurationChange() {
      if (Number.isFinite(audio.duration)) finish();
    }

    audio.addEventListener('durationchange', onDurationChange);
    timer = setTimeout(finish, timeoutMs);
    audio.currentTime = FAR_BEYOND_END;
  });
}
