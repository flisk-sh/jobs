import { expect, test } from 'bun:test';
import { handle } from '../src/app';
import { boardPage, ICON_SVG } from '../src/page';

const ctx = {} as any;
const call = (path: string, method = 'GET') => handle(new Request(`http://jobs.test${path}`, { method }), ctx, 'http://jobs.test');

test('GET /favicon.ico returns the shared SVG as an image', async () => {
  const res = await call('/favicon.ico');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
  expect(await res.text()).toBe(ICON_SVG);
});

test('the icon response is cacheable for at least a day', async () => {
  const res = await call('/favicon.ico');
  const maxAge = Number(res.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1]);
  expect(maxAge).toBeGreaterThanOrEqual(86400);
});

test('the page link and the route reuse one icon', () => {
  const html = boardPage('', { title: 'Jobs', description: 'Board', canonical: 'http://jobs.test/', view: '' });
  const inline = html.match(/<link rel="icon" href="data:image\/svg\+xml,([^"]+)">/)?.[1];
  expect(inline).toBeTruthy();
  expect(decodeURIComponent(inline!)).toBe(ICON_SVG);
});
