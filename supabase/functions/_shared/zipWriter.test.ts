import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as nodeCrc32, inflateRawSync } from 'node:zlib';
import { crc32, safeZipPath, ZipBuilder } from './zipWriter.ts';

/**
 * De zip van "Alles exporteren". Een eigen, kleine lezer pakt hem weer uit en
 * controleert elke CRC met die van Node; de ZIP64-velden worden gelezen zoals
 * een gewone uitpakker dat doet.
 */

interface ReadEntry { name: string; data: Buffer; method: number; flags: number }

function readZip(buffer: Buffer): ReadEntry[] {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'geen einde van de centrale map');
  let count = buffer.readUInt16LE(eocd + 10);
  let centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    const locator = eocd - 20;
    assert.equal(buffer.readUInt32LE(locator), 0x07064b50, 'ZIP64-locator ontbreekt');
    const zip64End = Number(buffer.readBigUInt64LE(locator + 8));
    assert.equal(buffer.readUInt32LE(zip64End), 0x06064b50, 'ZIP64-einde ontbreekt');
    count = Number(buffer.readBigUInt64LE(zip64End + 32));
    centralOffset = Number(buffer.readBigUInt64LE(zip64End + 48));
  }
  const entries: ReadEntry[] = [];
  let pos = centralOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(pos), 0x02014b50, 'kop in de centrale map klopt niet');
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    let compressedSize = buffer.readUInt32LE(pos + 20);
    let size = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    let offset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    let extra = pos + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra < extraEnd) {
      const id = buffer.readUInt16LE(extra);
      const length = buffer.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (size === 0xffffffff) { size = Number(buffer.readBigUInt64LE(field)); field += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(buffer.readBigUInt64LE(field)); field += 8; }
        if (offset === 0xffffffff) { offset = Number(buffer.readBigUInt64LE(field)); field += 8; }
      }
      extra += 4 + length;
    }
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50, `lokale kop van ${name} niet gevonden`);
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const stored = buffer.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(stored) : Buffer.from(stored);
    assert.equal(data.length, size, `${name}: grootte klopt niet`);
    assert.equal(nodeCrc32(data), crc, `${name}: CRC klopt niet`);
    entries.push({ name, data, method, flags });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('crc32 is dezelfde als die van zlib', () => {
  const data = new TextEncoder().encode('ResoFly — gegevens meenemen');
  assert.equal(crc32(data), nodeCrc32(Buffer.from(data)));
  assert.equal(crc32(new Uint8Array()), 0);
});

test('een zip met tekst, een binair bestand, een leeg bestand en een naam buiten ASCII', async () => {
  const zip = new ZipBuilder();
  const json = JSON.stringify({ name: 'Bakkerij Jansen' }) + '\n';
  const big = 'id;naam\n' + Array.from({ length: 500 }, (_, i) => `${i};Klant ${i}`).join('\n');
  const binary = new Uint8Array(1024).map((_, i) => (i * 37) % 256);
  await zip.add('data/clients.jsonl', json, { compress: true });
  await zip.add('lijsten/klanten.csv', big, { compress: true });
  await zip.add('bestanden/klanten/abc/Offerte Café.pdf', new Blob([binary]));
  await zip.add('leeg.txt', '');
  const entries = readZip(Buffer.from(await zip.finish().arrayBuffer()));

  assert.deepEqual(entries.map(e => e.name), ['data/clients.jsonl', 'lijsten/klanten.csv', 'bestanden/klanten/abc/Offerte Café.pdf', 'leeg.txt']);
  assert.equal(entries[0].data.toString('utf8'), json);
  assert.equal(entries[1].data.toString('utf8'), big);
  assert.equal(entries[1].method, 8, 'een lange CSV hoort gecomprimeerd te zijn');
  assert.deepEqual(new Uint8Array(entries[2].data), binary);
  assert.equal(entries[2].method, 0, 'een bestand gaat zoals het is');
  assert.equal(entries[3].data.length, 0);
  for (const entry of entries) assert.ok(entry.flags & 0x0800, `${entry.name}: UTF-8-vlag ontbreekt`);
});

test('ZIP64-velden worden goed geschreven en gelezen', async () => {
  const zip = new ZipBuilder({ forceZip64: true });
  await zip.add('a.txt', 'eerste bestand');
  await zip.add('b/c.json', JSON.stringify({ x: 1 }).repeat(40), { compress: true });
  const entries = readZip(Buffer.from(await zip.finish().arrayBuffer()));
  assert.deepEqual(entries.map(e => [e.name, e.data.toString('utf8').slice(0, 14)]), [['a.txt', 'eerste bestand'], ['b/c.json', '{"x":1}{"x":1}']]);
});

test('addStream: in stukken, gecomprimeerd, en bij een fout niets in de zip', async () => {
  const zip = new ZipBuilder();
  const lines = Array.from({ length: 3000 }, (_, i) => `${JSON.stringify({ id: i, naam: `Klant ${i}`, plaats: 'Utrecht' })}\n`);
  await zip.addStream('data/clients.jsonl', async write => {
    for (let i = 0; i < lines.length; i += 1000) await write(lines.slice(i, i + 1000).join(''));
  }, { compress: true });
  await assert.rejects(() => zip.addStream('data/kapot.jsonl', async write => {
    await write('{"id":1}\n');
    throw new Error('verbinding weg');
  }, { compress: true }), /verbinding weg/);
  assert.ok(!zip.has('data/kapot.jsonl'), 'een afgebroken bestand hoort niet in de zip');
  await zip.addStream('data/leeg.jsonl', async () => undefined, { compress: true });
  await zip.addStream('data/zonder-compressie.jsonl', async write => { await write(new TextEncoder().encode('{"a":1}\n')); });

  const entries = readZip(Buffer.from(await zip.finish().arrayBuffer()));
  assert.deepEqual(entries.map(e => e.name), ['data/clients.jsonl', 'data/leeg.jsonl', 'data/zonder-compressie.jsonl']);
  assert.equal(entries[0].data.toString('utf8'), lines.join(''));
  assert.equal(entries[0].method, 8);
  assert.equal(entries[1].data.length, 0);
  assert.equal(entries[2].data.toString('utf8'), '{"a":1}\n');
});

test('een pad gaat nooit buiten de zip, en dubbel kan niet', async () => {
  assert.equal(safeZipPath('/bestanden/../klanten/./a.pdf'), 'bestanden/klanten/a.pdf');
  assert.equal(safeZipPath('map\\sub\\b.txt'), 'map/sub/b.txt');
  assert.throws(() => safeZipPath('../..'));
  const zip = new ZipBuilder();
  await zip.add('a.txt', 'x');
  await assert.rejects(() => zip.add('/a.txt', 'y'), /Dubbel pad/);
  assert.ok(zip.has('a.txt'));
});
