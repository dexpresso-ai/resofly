import { supabaseAuth } from './supabase';
import { ConnectionError, isConnectionError, SIGNED_OUT_MESSAGE } from './networkRetry';

const workerUrl = import.meta.env.VITE_R2_WORKER_URL as string | undefined;

export function getWorkerBase(): string {
  if (!workerUrl) throw new Error('VITE_R2_WORKER_URL is niet geconfigureerd. Stel deze in als environment variable in Cloudflare Pages (of .env.local voor lokale ontwikkeling).');
  return workerUrl.replace(/\/$/, '');
}

export async function getAccessToken(): Promise<string> {
  const { data, error } = await supabaseAuth.getSession();
  const accessToken = data.session?.access_token;
  if (accessToken) return accessToken;
  // Een verlopen token wordt hier ververst, en dat gaat over het netwerk.
  // Lukte dat niet door een haperende verbinding, dan ben je niet uitgelogd:
  // dan is opnieuw proberen genoeg (zie withRetry).
  if (isConnectionError(error)) throw new ConnectionError();
  throw new Error(SIGNED_OUT_MESSAGE);
}

export async function deleteR2Object(key: string): Promise<void> {
  const base = getWorkerBase();
  const accessToken = await getAccessToken();
  const response = await fetch(`${base}/file/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await response.text());
}
