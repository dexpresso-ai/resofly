// Waar de agendaserver (workers/caldav) van deze omgeving staat, en de adressen
// die de app daarvan laat zien: voor de telefoon (CalDAV) en voor deellinks.
//
// Tot november 2026 stond hier vast "caldav.resofly.com". Dat adres bestond
// niet: wie de stappen volgde, kreeg op zijn iPhone "Kan account niet
// verifiëren" zonder dat er iets aan te doen was.

export interface CaldavEnv {
  /** Een eigen adres voor de server (heeft voorrang), bijvoorbeeld bij een test. */
  VITE_CALDAV_URL?: string;
  /** 'staging' of 'production', zoals Cloudflare Pages het per omgeving zet. */
  VITE_APP_ENV?: string;
}

// Productie heeft nog geen agendaserver. Komt die er, zet hem dan hier (of
// VITE_CALDAV_URL bij de productievariabelen van Pages); tot dan zegt de app
// eerlijk dat hij er nog niet is, in plaats van een adres dat niet werkt.
const SERVER_BY_ENV: Readonly<Record<string, string>> = {
  staging: 'https://caldav-staging.resofly.com',
};

/** Het adres van de agendaserver, of null als deze omgeving er geen heeft. */
export function caldavServerUrl(env: CaldavEnv): string | null {
  const explicit = String(env.VITE_CALDAV_URL ?? '').trim().replace(/\/+$/, '');
  if (explicit) {
    const ok = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(explicit) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(explicit);
    return ok ? explicit : null;
  }
  return SERVER_BY_ENV[String(env.VITE_APP_ENV ?? '').trim()] ?? null;
}

/** Wat je op een iPhone bij "Server" invult: alleen de naam, zonder https://. */
export function caldavHost(serverUrl: string): string {
  return serverUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Het adres van een deellink. */
export function feedLinkUrl(serverUrl: string, token: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/feed/${encodeURIComponent(token)}.ics`;
}

/** Wat een deellink laat zien, in gewone woorden. */
export function feedDetailLabel(detail: 'busy' | 'details'): string {
  return detail === 'details' ? 'Titel, tijd en plaats' : 'Alleen bezet';
}
