import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProbe } from '../src/api';
import { handle } from '../src/app';
import { type Db, plainPostgresUrl } from '../src/store';
import { sqliteDb } from '../src/store-bun';

async function board(probeStatus = 200, database?: Db) {
  let t = Date.parse('2026-11-13T10:00:00Z');
  const probed: string[] = [];
  const ctx = { db: database ?? await sqliteDb(':memory:'), now: () => t, probe: async (u: string) => (probed.push(u), probeStatus) };
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const res = await handle(
      new Request(`http://jobs.test${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }),
      ctx,
      'http://jobs.test',
    );
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  const register = async (name: string) => (await call('POST', '/api/agents', { name })).body.key as string;
  return { call, register, probed, advance: (h: number) => (t += h * 3600e3) };
}

test('upgrading an existing SQLite database preserves historical agent records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-migration-'));
  const path = join(dir, 'jobs.sqlite');
  try {
    const old = new Database(path);
    old.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, note TEXT)');
    old.exec("INSERT INTO events (job_id, at, kind, actor, note) VALUES ('j', 1, 'rejected', 'poster', 'worker-1234: retry'), ('j', 2, 'claim_expired', 'board', 'worker-1234 did not submit within 24 hours')");
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = await sqliteDb(path);
      const rows = await db.all<{ subject: string }>('SELECT subject FROM events ORDER BY id');
      expect(rows.map((r) => r.subject)).toEqual(['worker-1234', 'worker-1234']);
      await db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D1 migration backfills old event subjects', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, actor TEXT NOT NULL, note TEXT)');
    db.exec("INSERT INTO events VALUES (1, 'rejected', 'poster', 'worker-1234: retry'), (2, 'claim_expired', 'board', 'worker-1234 did not submit within 24 hours')");
    db.exec(readFileSync(join(import.meta.dir, '../migrations/0002_event_subject.sql'), 'utf8'));
    expect(db.query('SELECT subject FROM events ORDER BY id').all()).toEqual([{ subject: 'worker-1234' }, { subject: 'worker-1234' }]);
  } finally {
    db.close();
  }
});

test('listing agents uses a fixed query count and matches single-agent records', async () => {
  const raw = await sqliteDb(':memory:');
  let queries = 0;
  const db: Db = {
    get: async <T>(sql, ...args) => { queries++; return raw.get<T>(sql, ...args); },
    all: async <T>(sql, ...args) => { queries++; return raw.all<T>(sql, ...args); },
    run: async (sql, ...args) => { queries++; return raw.run(sql, ...args); },
    close: raw.close,
  };
  const b = await board(200, db);
  const poster = (await b.call('POST', '/api/agents', { name: 'poster' })).body as { key: string };
  const workers: { id: string; key: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const r = (await b.call('POST', '/api/agents', { name: `worker-${i}` })).body as { key: string; agent: { id: string } };
    workers.push({ id: r.agent.id, key: r.key });
  }

  for (let i = 0; i < workers.length; i++) {
    const posted = await b.call('POST', '/api/jobs', { title: `Job ${i}`, body: 'Do it', doneWhen: 'A result' }, poster.key);
    const id = (posted.body as { job: { id: string } }).job.id;
    await b.call('POST', `/api/jobs/${id}/claim`, {}, workers[i].key);
    if (i % 3 === 2) continue;
    await b.call('POST', `/api/jobs/${id}/submit`, { resultUrl: `https://example.com/result-${i}` }, workers[i].key);
    await b.call('POST', `/api/jobs/${id}/${i % 3 === 1 ? 'reject' : 'accept'}`, i % 3 === 1 ? { note: 'try again' } : {}, poster.key);
  }
  b.advance(25);
  await b.call('GET', '/api/jobs');

  queries = 0;
  const listed = await b.call('GET', '/api/agents');
  expect(listed.status).toBe(200);
  expect(queries).toBeLessThanOrEqual(4);
  const byId = new Map((listed.body as { agents: { agent: { id: string }; record: unknown }[] }).agents.map((a) => [a.agent.id, a.record]));
  expect(byId.get(workers[0].id)).toMatchObject({ claimed: 1, submitted: 1, accepted: 1, rejected: 0, expired: 0 });
  expect(byId.get(workers[1].id)).toMatchObject({ claimed: 1, submitted: 1, accepted: 0, rejected: 1, expired: 0 });
  expect(byId.get(workers[2].id)).toMatchObject({ claimed: 1, submitted: 0, accepted: 0, rejected: 0, expired: 1 });

  const single = await b.call('GET', `/api/agents/${workers[1].id}`);
  expect(single.body).toMatchObject({ agent: { id: workers[1].id }, record: byId.get(workers[1].id) });
  for (let i = 0; i < 189; i++) await b.register(`extra-${i}`);
  queries = 0;
  const full = await b.call('GET', '/api/agents');
  expect(full.body.agents).toHaveLength(200);
  expect(queries).toBeLessThanOrEqual(4);
});

test('any agent registers with one call and gets a key shown once', async () => {
  const b = await board();
  const r = await b.call('POST', '/api/agents', { name: 'Research Bot', homepage: 'https://example.com', about: 'reads things' });
  expect(r.status).toBe(201);
  expect(r.body.key).toMatch(/^fj_[a-z0-9]{32}$/);
  expect(r.body.agent.id).toMatch(/^research-bot-[a-z0-9]{4}$/);
  const me = await b.call('GET', '/api/me', undefined, r.body.key);
  expect(me.body.agent.name).toBe('Research Bot');
  expect(JSON.stringify((await b.call('GET', '/api/agents')).body)).not.toContain('fj_');
  expect((await b.call('POST', '/api/agents', { name: 'x', homepage: 'http://insecure' })).status).toBe(400);
});

test('a free-text job goes open, claimed, submitted, accepted, with an event for each step', async () => {
  const b = await board();
  const poster = await b.register('poster');
  const worker = await b.register('worker');
  const posted = await b.call('POST', '/api/jobs', { title: 'Translate a page', body: 'To Dutch', doneWhen: 'A link to the Dutch page', priceUsd: 20 }, poster);
  expect(posted.status).toBe(201);
  const id = posted.body.job.id;
  expect(posted.body.job.payment).toBe('not_live');
  expect((await b.call('POST', `/api/jobs/${id}/claim`, {}, poster)).status).toBe(409); // not your own job
  expect((await b.call('POST', `/api/jobs/${id}/claim`, {}, worker)).body.job.status).toBe('claimed');
  expect((await b.call('POST', `/api/jobs/${id}/claim`, {}, worker)).status).toBe(200); // a retry is fine
  expect((await b.call('POST', `/api/jobs/${id}/submit`, { resultUrl: 'https://example.com/nl' }, worker)).body.job.status).toBe('submitted');
  expect((await b.call('POST', `/api/jobs/${id}/accept`, {}, worker)).status).toBe(403); // only the poster decides
  const done = await b.call('POST', `/api/jobs/${id}/accept`, { note: 'thanks' }, poster);
  expect(done.body.job.status).toBe('accepted');
  expect(done.body.events.map((e: { kind: string }) => e.kind)).toEqual(['posted', 'claimed', 'submitted', 'accepted']);
  expect(b.probed).toEqual([]); // free text is checked by the poster, not the board
});

test('a rejection reopens the job and lands on the agent record', async () => {
  const b = await board();
  const poster = await b.register('poster');
  const worker = await b.register('worker');
  const id = (await b.call('POST', '/api/jobs', { title: 'T', body: 'B', doneWhen: 'D' }, poster)).body.job.id;
  await b.call('POST', `/api/jobs/${id}/claim`, {}, worker);
  await b.call('POST', `/api/jobs/${id}/submit`, { resultUrl: 'https://example.com/x' }, worker);
  expect((await b.call('POST', `/api/jobs/${id}/reject`, {}, poster)).status).toBe(400); // a reason is required
  const r = await b.call('POST', `/api/jobs/${id}/reject`, { note: 'wrong language' }, poster);
  expect(r.body.job.status).toBe('open');
  expect(r.body.job.result).toBeNull();
  const workerId = (await b.call('GET', '/api/me', undefined, worker)).body.agent.id;
  expect((await b.call('GET', `/api/agents/${workerId}`)).body.record).toMatchObject({ rejected: 1, accepted: 0, claimed: 1 });
});

test('a claim runs out after 24 hours and the job opens again', async () => {
  const b = await board();
  const poster = await b.register('poster');
  const worker = await b.register('worker');
  const id = (await b.call('POST', '/api/jobs', { title: 'T', body: 'B', doneWhen: 'D' }, poster)).body.job.id;
  await b.call('POST', `/api/jobs/${id}/claim`, {}, worker);
  b.advance(25);
  const d = await b.call('GET', `/api/jobs/${id}`);
  expect(d.body.job.status).toBe('open');
  expect(d.body.events.at(-1).kind).toBe('claim_expired');
});

test('a structured job is checked by the board and auto-accepted only when the link opens', async () => {
  const b = await board(200);
  const poster = await b.register('poster');
  const bot = await b.register('bot');
  const id = (await b.call('POST', '/api/jobs', { title: 'Score my README', kind: 'readme-score', input: { repo: 'https://github.com/flisk-sh/pages' }, autoAccept: true }, poster)).body.job.id;
  expect((await b.call('GET', `/api/jobs/${id}`)).body.job.input).toEqual({ repo: 'flisk-sh/pages' });
  await b.call('POST', `/api/jobs/${id}/claim`, {}, bot);
  expect((await b.call('POST', `/api/jobs/${id}/submit`, { resultUrl: 'https://evil.example/score' }, bot)).status).toBe(400);
  const r = await b.call('POST', `/api/jobs/${id}/submit`, { resultUrl: 'https://readme.flisk.si/r/flisk-sh/pages' }, bot);
  expect(r.body.job.status).toBe('accepted');
  expect(r.body.events.map((e: { kind: string }) => e.kind)).toEqual(['posted', 'claimed', 'submitted', 'checked', 'accepted']);

  const b2 = await board(404);
  const p2 = await b2.register('poster');
  const w2 = await b2.register('bot');
  const id2 = (await b2.call('POST', '/api/jobs', { title: 'Score', kind: 'readme-score', input: { repo: 'a/b' }, autoAccept: true }, p2)).body.job.id;
  await b2.call('POST', `/api/jobs/${id2}/claim`, {}, w2);
  const r2 = await b2.call('POST', `/api/jobs/${id2}/submit`, { resultUrl: 'https://readme.flisk.si/r/a/b' }, w2);
  expect(r2.body.job.status).toBe('submitted');
  expect(r2.body.events.at(-1).kind).toBe('check_failed');
});

test('the result check follows same-origin redirects only', async () => {
  const hops: Record<string, [number, string?]> = {
    'https://citable.flisk.si/check?url=x': [303, '/pages.flisk.si'],
    'https://citable.flisk.si/pages.flisk.si': [200],
    'https://readme.flisk.si/r/a': [302, 'https://evil.example/a'],
    'https://readme.flisk.si/loop': [302, '/loop'],
  };
  const f = (async (u: string) => {
    const [status, location] = hops[u] ?? [404];
    return new Response(null, { status, headers: location ? { location } : {} });
  }) as typeof fetch;
  const probe = makeProbe(f);
  expect(await probe('https://citable.flisk.si/check?url=x')).toBe(200);
  expect(await probe('https://readme.flisk.si/r/a')).toBe(302); // another host: not followed
  expect(await probe('https://readme.flisk.si/loop')).toBe(310);
});

test("Flisk's Prisma-style ?schema= is taken out of the Postgres URL", () => {
  expect(plainPostgresUrl('postgresql://u:p@db:5432/app?schema=public')).toEqual({ url: 'postgresql://u:p@db:5432/app', schema: 'public' });
  expect(plainPostgresUrl('postgresql://u:p@db:5432/app?sslmode=disable').schema).toBeNull();
  expect(plainPostgresUrl('postgresql://u:p@db/app?schema=x;drop').schema).toBeNull();
});

test('bad input is refused with a reason', async () => {
  const b = await board();
  const k = await b.register('poster');
  expect((await b.call('POST', '/api/jobs', { title: 'x', kind: 'readme-score', input: { repo: 'not a repo' } }, k)).status).toBe(400);
  expect((await b.call('POST', '/api/jobs', { title: 'x', kind: 'nope', input: {} }, k)).status).toBe(400);
  expect((await b.call('POST', '/api/jobs', { title: 'x', body: 'y', doneWhen: 'z', priceUsd: -1 }, k)).status).toBe(400);
  expect((await b.call('POST', '/api/jobs', { title: 'x', body: 'y', doneWhen: 'z' })).status).toBe(401);
  expect((await b.call('POST', '/api/jobs', { title: 'x', body: 'y', doneWhen: 'z' }, 'fj_wrongwrongwrongwrongwrong')).status).toBe(401);
});

test('MCP lists tools and runs the same flow', async () => {
  const b = await board();
  const init = await b.call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  expect(init.body.result.serverInfo.name).toBe('flisk-jobs');
  const tools = await b.call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  expect(tools.body.result.tools.map((t: { name: string }) => t.name)).toContain('claim_job');
  const reg = await b.call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'register_agent', arguments: { name: 'mcp-agent' } } });
  const key = reg.body.result.structuredContent.key;
  const post = await b.call('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'post_job', arguments: { key, title: 'T', body: 'B', doneWhen: 'D' } } });
  expect(post.body.result.structuredContent.job.status).toBe('open');
  const bad = await b.call('POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'claim_job', arguments: { id: 'zzz' } } });
  expect(bad.body.result.isError).toBe(true);
});

test('llms.txt and the board page are served, and stats say payment is not live', async () => {
  const b = await board();
  expect((await b.call('GET', '/llms.txt')).body).toContain('Payment is not live');
  expect((await b.call('GET', '/')).body).toContain('<title>Flisk Jobs');
  expect((await b.call('GET', '/job/abc')).status).toBe(404);
  expect((await b.call('GET', '/api/stats')).body.payment).toBe('not_live');
});

test('the board serves the post-a-job form page with the header button', async () => {
  const { call } = await board();
  const r = await call('GET', '/post');
  expect(r.status).toBe(200);
  expect(r.body).toContain('class="postbtn"');
  expect(r.body).toContain('postform');
});

test('a job page carries its own title, description, canonical link and text before any script runs', async () => {
  const b = await board();
  const poster = await b.register('poster');
  const posted = await b.call('POST', '/api/jobs', { title: 'Score the README of acme/<widget>', body: 'Run the README score.', doneWhen: 'A result link' }, poster);
  const id = posted.body.job.id;
  const page = (await b.call('GET', `/job/${id}`)).body as string;
  expect(page).toContain('<title>Score the README of acme/&lt;widget&gt; · Flisk Jobs</title>');
  expect(page).toContain(`<link rel="canonical" href="http://jobs.test/job/${id}">`);
  expect(page).toContain('<meta name="description" content="Open: Run the README score.');
  expect(page).toContain('application/ld+json');
  expect(page).toContain('<h1>Score the README of acme/&lt;widget&gt;</h1>');
  expect(page).not.toContain('<widget>');
  const other = await b.call('POST', '/api/jobs', { title: 'Another job', body: 'Different text', doneWhen: 'x' }, poster);
  expect((await b.call('GET', `/job/${other.body.job.id}`)).body).not.toContain('Score the README');
});

test('a cancelled job is noindex and a missing job is a 404', async () => {
  const b = await board();
  const poster = await b.register('poster');
  const id = (await b.call('POST', '/api/jobs', { title: 'Gone', body: 'b', doneWhen: 'x' }, poster)).body.job.id;
  await b.call('POST', `/api/jobs/${id}/cancel`, {}, poster);
  expect((await b.call('GET', `/job/${id}`)).body).toContain('name="robots" content="noindex"');
  const missing = await b.call('GET', '/job/zzzzzzzz');
  expect(missing.status).toBe(404);
  expect(missing.body).toContain('noindex');
});

test('the home page links every job and sitemap.xml lists them, robots.txt points at it', async () => {
  const b = await board();
  const poster = await b.register('poster');
  const a = (await b.call('POST', '/api/jobs', { title: 'Job A', body: 'b', doneWhen: 'x' }, poster)).body.job.id;
  const c = (await b.call('POST', '/api/jobs', { title: 'Job C', body: 'b', doneWhen: 'x' }, poster)).body.job.id;
  await b.call('POST', `/api/jobs/${c}/cancel`, {}, poster);
  const home = (await b.call('GET', '/')).body as string;
  expect(home).toContain(`href="http://jobs.test/job/${a}"`);
  const sm = (await b.call('GET', '/sitemap.xml')).body as string;
  expect(sm).toContain(`<loc>http://jobs.test/job/${a}</loc>`);
  expect(sm).not.toContain(c);
  expect((await b.call('GET', '/robots.txt')).body).toContain('Sitemap: http://jobs.test/sitemap.xml');
});

test('the sitemap includes jobs beyond the API listing limit', async () => {
  const db = await sqliteDb(':memory:');
  try {
    const { call } = await board(200, db);
    const insert = (id: string, status: string, created: number) => db.run(
      "INSERT INTO jobs (id, poster, title, body, done_when, status, created) VALUES (?, 'poster', 'Job', 'body', 'done', ?, ?)",
      id, status, created,
    );
    const created = Date.parse('2026-11-13T00:00:00Z');
    await insert('oldest', 'accepted', created);
    for (let i = 1; i <= 200; i++) await insert(`job${i}`, 'open', created + i);
    await insert('cancelled', 'cancelled', created + 201);

    expect((await call('GET', '/api/jobs?status=all')).body.jobs).toHaveLength(200);
    const sitemap = await call('GET', '/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.body.includes('<loc>http://jobs.test/job/oldest</loc><lastmod>2026-11-13</lastmod>')).toBe(true);
    expect(sitemap.body).not.toContain('<loc>http://jobs.test/job/cancelled</loc>');
    expect(sitemap.body.match(/<loc>http:\/\/jobs\.test\/job\//g)).toHaveLength(201);
  } finally {
    await db.close();
  }
});

test('HEAD answers like GET with the same status and headers and no body', async () => {
  const { call } = await board();
  const get = await call('GET', '/');
  const head = await call('HEAD', '/');
  expect(get.status).toBe(200);
  expect(head.status).toBe(200);
  expect(head.body).toBe('');
});
