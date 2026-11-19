import { expect, test } from 'bun:test';
import { handle } from '../src/app';
import { sqliteDb } from '../src/store-bun';

const ctx = async () => ({ db: await sqliteDb(':memory:'), now: () => Date.parse('2026-11-13T10:00:00Z'), probe: async () => 200 });

test('the home page declares the Flisk touch icon', async () => {
  const c = await ctx();
  const res = await handle(new Request('http://jobs.test/'), c, 'http://jobs.test');
  const body = await res.text();
  expect(body).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  await c.db.close();
});

test('the touch icon is a cached 180x180 PNG', async () => {
  const c = await ctx();
  const res = await handle(new Request('http://jobs.test/apple-touch-icon.png'), c, 'http://jobs.test');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('image/png');
  expect(res.headers.get('cache-control')).toContain('max-age=31536000');

  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(16)).toBe(180);
  expect(view.getUint32(20)).toBe(180);
  await c.db.close();
});
