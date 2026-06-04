import { supabaseAuth } from './supabase';

const workerUrl = import.meta.env.VITE_R2_WORKER_URL as string | undefined;

export function getWorkerBase(): string {
  if (!workerUrl) throw new Error('VITE_R2_WORKER_URL is niet geconfigureerd. Stel deze in als environment variable in Cloudflare Pages (of .env.local voor lokale ontwikkeling).');
  return workerUrl.replace(/\/$/, '');
}

export async function getAccessToken(): Promise<string> {
  const { data } = await supabaseAuth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error('Niet ingelogd. Uploaden vereist een actieve Supabase sessie.');
  return accessToken;
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
