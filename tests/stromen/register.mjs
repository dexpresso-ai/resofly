// node --import ./tests/stromen/register.mjs …
// Zet de Deno-global klaar en registreert de loader voor de remote imports.
import { register } from 'node:module';

globalThis.Deno = {
  env: {
    get: (key) => process.env[key],
    set: (key, value) => { process.env[key] = String(value); },
    toObject: () => ({ ...process.env }),
  },
  serve: (...args) => {
    const handler = args.find((arg) => typeof arg === 'function');
    globalThis.__stromenServe?.(handler);
    return { finished: Promise.resolve(), shutdown: async () => {} };
  },
  resolveDns: async () => { throw new Error('tests/stromen: geen DNS in de test'); },
};

register('./loader.mjs', import.meta.url);
