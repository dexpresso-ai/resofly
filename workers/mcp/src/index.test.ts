import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './index.ts';

/**
 * Wat Miniflare niet kan laten zien (test/worker.mjs): een Supabase die niet
 * antwoordt. Daar maakt Miniflare zelf een 500 van, in de echte runtime gooit
 * fetch een fout.
 */

const ENV = { SUPABASE_URL: 'https://project.supabase.test', APP_URL: 'https://staging.resofly.test', MCP_PROXY_SECRET: 'werker-geheim-mcp-0123456789abcdef' };

test('is Supabase onbereikbaar, dan een 502 en geen 401', async () => {
  const unreachable = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await handle(new Request('https://mcp.resofly.com/mcp', { method: 'POST', body: '{}' }), ENV, unreachable);
    assert.equal(res.status, 502);
    const body = await res.json() as { error: string; error_description: string };
    // Een 401 laat een AI-client opnieuw koppelen; dat lost hier niets op.
    assert.equal(body.error, 'temporarily_unavailable');
    assert.match(body.error_description, /even niet bereikbaar/);
  } finally {
    console.error = originalError;
  }
});

test('een verkeerd ingestelde Worker zegt dat, en vraagt niets aan een vreemd adres', async () => {
  let called = false;
  const fetcher = (async () => { called = true; return new Response('nee'); }) as typeof fetch;
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await handle(new Request('https://mcp.resofly.com/token', { method: 'POST' }), { ...ENV, SUPABASE_URL: 'http://ergens.test/pad' }, fetcher);
    assert.equal(res.status, 500);
    assert.equal(called, false);
  } finally {
    console.error = originalError;
  }
});

test('de Worker vraagt Supabase het vaste adres, met de methode van de client', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => { seen.push({ url, init }); return new Response('{}', { status: 401 }); }) as unknown as typeof fetch;
  const res = await handle(new Request('https://mcp.resofly.com/mcp/', { method: 'POST', body: '{}' }), ENV, fetcher);
  assert.equal(res.status, 401);
  assert.equal(seen[0].url, 'https://project.supabase.test/functions/v1/mcp');
  assert.equal(seen[0].init?.method, 'POST');
  assert.equal(seen[0].init?.redirect, 'manual', 'de 302 van /authorize hoort bij de browser');
});
