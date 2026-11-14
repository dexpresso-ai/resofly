/**
 * Houdt het scherm aan zolang er iets loopt dat niet onderbroken mag worden,
 * zoals het uploaden van een album. Geeft een functie terug die het weer
 * loslaat.
 *
 * Waarom: een album van vijftig foto's uploaden duurt op een telefoon een paar
 * minuten. Ging het scherm in die tijd uit, dan zette Android het netwerk van
 * de browser stil en mislukte de rest van de wachtrij met "Failed to fetch"
 * (14 november). Uploads die toch onderbroken worden, wachten tot je terug bent
 * (zie withRetry in networkRetry.ts); dit voorkomt de onderbreking zelf.
 *
 * De browser laat het scherm weer los zodra je naar een andere app of ander
 * tabblad gaat. Kom je terug, dan vragen we het opnieuw aan. Kan de browser dit
 * niet (Firefox, oudere Safari) of weigert hij het (batterijbesparing), dan gaat
 * de upload gewoon door zonder.
 */
export function keepScreenOn(): () => void {
  if (typeof navigator === 'undefined' || typeof document === 'undefined' || !('wakeLock' in navigator)) {
    return () => undefined;
  }
  let sentinel: WakeLockSentinel | null = null;
  let requesting = false;
  let stopped = false;

  const acquire = async () => {
    if (stopped || requesting || sentinel || document.visibilityState !== 'visible') return;
    requesting = true;
    try {
      const next = await navigator.wakeLock.request('screen');
      if (stopped) {
        void next.release().catch(() => undefined);
        return;
      }
      sentinel = next;
      next.addEventListener('release', () => {
        if (sentinel === next) sentinel = null;
      });
    } catch {
      /* geweigerd of niet mogelijk: dan maar zonder */
    } finally {
      requesting = false;
    }
  };

  const onVisibility = () => { void acquire(); };
  document.addEventListener('visibilitychange', onVisibility);
  void acquire();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    const current = sentinel;
    sentinel = null;
    void current?.release().catch(() => undefined);
  };
}
