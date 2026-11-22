import { expect, test } from 'bun:test';
import { withSecurityHeaders } from '../src/security-headers';

test('adds the baseline headers and frame-ancestors to a bare response', () => {
  const r = withSecurityHeaders(new Response('x', { status: 404 }));
  expect(r.status).toBe(404);
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(r.headers.get('strict-transport-security')).toContain('includeSubDomains');
  expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'self' https://analytics.flisk.si; base-uri 'none'; form-action 'none'");
});

test('keeps an existing CSP and appends frame-ancestors; works on immutable redirects', () => {
  const a = withSecurityHeaders(new Response('x', { headers: { 'content-security-policy': "default-src 'self'" } }));
  expect(a.headers.get('content-security-policy')).toBe("default-src 'self'; frame-ancestors 'self' https://analytics.flisk.si");
  const b = withSecurityHeaders(Response.redirect('https://jobs.flisk.si/', 301));
  expect(b.headers.get('x-frame-options')).toBe('SAMEORIGIN');
});
