// Private founder cycle queue (FND-06): unique per (business, cycle, action),
// atomic leased claims with exponential backoff, dead-letter after 5 failures, isolated from public board.

export interface PrivateJobInput {
  business: string;
  cycle: number;
  action: string;
  payload?: string;
  now?: number;
}

export interface PrivateJobRow {
  id: number;
  business: string;
  cycle: number;
  action: string;
  payload: string;
  status: 'queued' | 'leased' | 'done' | 'dead_letter';
  attempts: number;
  worker_id: string | null;
  lease_expires_at: number | null;
  next_run_at: number;
  alert_owner: number;
  created_at: number;
}

type DbLike = {
  exec: (sql: string) => void;
  query: (sql: string) => {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => { changes?: number };
  };
};

export function initPrivateQueueSchema(db: Pick<DbLike, 'exec'>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS private_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business TEXT NOT NULL,
      cycle INTEGER NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      worker_id TEXT,
      lease_expires_at INTEGER,
      next_run_at INTEGER NOT NULL,
      alert_owner INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(business, cycle, action)
    );
  `);
}

export function enqueuePrivateJob(
  db: Pick<DbLike, 'query'>,
  input: PrivateJobInput,
): { created: boolean; id: number } {
  const now = input.now ?? Date.now();
  const info = db
    .query(
      'INSERT OR IGNORE INTO private_jobs (business, cycle, action, payload, status, attempts, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    )
    .run(input.business, input.cycle, input.action, input.payload ?? '{}', 'queued', now, now);

  const row = db
    .query('SELECT id FROM private_jobs WHERE business = ? AND cycle = ? AND action = ?')
    .get(input.business, input.cycle, input.action) as { id: number };
  return { created: (info?.changes ?? 0) > 0, id: row.id };
}

export function claimPrivateJob(
  db: Pick<DbLike, 'query'>,
  opts: { workerId: string; leaseMs?: number; now?: number },
): PrivateJobRow | null {
  const now = opts.now ?? Date.now();
  const leaseMs = opts.leaseMs ?? 60_000;

  // Recover all expired leases with exponential backoff before claiming.
  const expiredRows = db
    .query("SELECT id, attempts FROM private_jobs WHERE status = 'leased' AND lease_expires_at <= ?")
    .all(now) as Array<{ id: number; attempts: number }>;

  for (const expired of expiredRows) {
    const nextAttempts = expired.attempts + 1;
    if (nextAttempts >= 5) {
      db.query(
        "UPDATE private_jobs SET status = 'dead_letter', attempts = ?, worker_id = NULL, lease_expires_at = NULL, alert_owner = 1 WHERE id = ? AND status = 'leased'",
      ).run(nextAttempts, expired.id);
    } else {
      const backoff = 1000 * 2 ** (nextAttempts - 1);
      db.query(
        "UPDATE private_jobs SET status = 'queued', attempts = ?, worker_id = NULL, lease_expires_at = NULL, next_run_at = ? WHERE id = ? AND status = 'leased'",
      ).run(nextAttempts, now + backoff, expired.id);
    }
  }

  const candidate = db
    .query("SELECT id FROM private_jobs WHERE status = 'queued' AND next_run_at <= ? ORDER BY id ASC LIMIT 1")
    .get(now) as { id: number } | null;
  if (!candidate) return null;

  const updated = db
    .query(
      "UPDATE private_jobs SET status = 'leased', worker_id = ?, lease_expires_at = ? WHERE id = ? AND status = 'queued'",
    )
    .run(opts.workerId, now + leaseMs, candidate.id);

  if ((updated?.changes ?? 0) === 0) return null;
  return db.query('SELECT * FROM private_jobs WHERE id = ?').get(candidate.id) as PrivateJobRow;
}

export function failPrivateJob(
  db: Pick<DbLike, 'query'>,
  opts: { id: number; workerId: string; now?: number; baseBackoffMs?: number },
): PrivateJobRow | null {
  const now = opts.now ?? Date.now();
  const baseBackoffMs = opts.baseBackoffMs ?? 1000;
  const row = db
    .query("SELECT * FROM private_jobs WHERE id = ? AND status = 'leased' AND worker_id = ?")
    .get(opts.id, opts.workerId) as PrivateJobRow | null;
  if (!row) return null;

  const nextAttempts = row.attempts + 1;
  if (nextAttempts >= 5) {
    db.query(
      "UPDATE private_jobs SET status = 'dead_letter', attempts = ?, worker_id = NULL, lease_expires_at = NULL, alert_owner = 1 WHERE id = ? AND status = 'leased' AND worker_id = ?",
    ).run(nextAttempts, opts.id, opts.workerId);
  } else {
    const backoff = baseBackoffMs * 2 ** (nextAttempts - 1);
    db.query(
      "UPDATE private_jobs SET status = 'queued', attempts = ?, worker_id = NULL, lease_expires_at = NULL, next_run_at = ? WHERE id = ? AND status = 'leased' AND worker_id = ?",
    ).run(nextAttempts, now + backoff, opts.id, opts.workerId);
  }

  return db.query('SELECT * FROM private_jobs WHERE id = ?').get(opts.id) as PrivateJobRow;
}
