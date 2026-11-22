// Baseline security headers for every response jobs.flisk.si sends.
const BASELINE: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

// Adds what is missing and never overwrites a header the route set. A CSP gains frame-ancestors 'self' https://analytics.flisk.si if it has none.
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res); // headers of some Responses are immutable: copy
  for (const [name, value] of Object.entries(BASELINE)) if (!out.headers.has(name)) out.headers.set(name, value);
  const csp = out.headers.get('content-security-policy');
  if (csp === null) out.headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'self' https://analytics.flisk.si; base-uri 'none'; form-action 'none'");
  else if (!/frame-ancestors/i.test(csp)) out.headers.set('content-security-policy', `${csp}; frame-ancestors 'self' https://analytics.flisk.si`);
  return out;
}
