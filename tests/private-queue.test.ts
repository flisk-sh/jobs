import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  claimPrivateJob,
  enqueuePrivateJob,
  failPrivateJob,
  initPrivateQueueSchema,
} from '../src/private-queue.ts';

function setupDb() {
  const db = new Database(':memory:');
  initPrivateQueueSchema(db);
  db.exec('CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);');
  return db;
}

describe('private queue (FND-06)', () => {
  test('duplicate (business, cycle, action) does not create a second run', () => {
    const db = setupDb();
    const first = enqueuePrivateJob(db, { business: 'acme', cycle: 12, action: 'build', now: 1000 });
    const second = enqueuePrivateJob(db, { business: 'acme', cycle: 12, action: 'build', now: 2000 });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  test('only one worker can claim a queued job', () => {
    const db = setupDb();
    enqueuePrivateJob(db, { business: 'acme', cycle: 12, action: 'build', now: 1000 });
    const c1 = claimPrivateJob(db, { workerId: 'w1', leaseMs: 5000, now: 1000 });
    const c2 = claimPrivateJob(db, { workerId: 'w2', leaseMs: 5000, now: 1000 });

    expect(c1?.worker_id).toBe('w1');
    expect(c2).toBeNull();
  });

  test('expired leases are all recovered with exponential backoff', () => {
    const db = setupDb();
    enqueuePrivateJob(db, { business: 'acme', cycle: 12, action: 'build', now: 1000 });
    enqueuePrivateJob(db, { business: 'acme', cycle: 13, action: 'build', now: 1000 });
    claimPrivateJob(db, { workerId: 'w1', leaseMs: 5000, now: 1000 });
    claimPrivateJob(db, { workerId: 'w1', leaseMs: 5000, now: 1000 });

    // Both leases expired at 6000; claim at 6500 recovers both with 1000ms backoff (next_run_at = 7500).
    expect(claimPrivateJob(db, { workerId: 'w2', leaseMs: 5000, now: 6500 })).toBeNull();

    const r1 = claimPrivateJob(db, { workerId: 'w2', leaseMs: 5000, now: 7500 });
    const r2 = claimPrivateJob(db, { workerId: 'w2', leaseMs: 5000, now: 7500 });
    expect(r1?.attempts).toBe(1);
    expect(r2?.attempts).toBe(1);
  });

  test('stale worker cannot fail a job now leased to another worker', () => {
    const db = setupDb();
    const { id } = enqueuePrivateJob(db, { business: 'acme', cycle: 12, action: 'build', now: 1000 });
    claimPrivateJob(db, { workerId: 'w1', leaseMs: 5000, now: 1000 });
    claimPrivateJob(db, { workerId: 'w2', leaseMs: 5000, now: 7500 });

    expect(failPrivateJob(db, { id, workerId: 'w1', now: 7600 })).toBeNull();
  });

  test('moves job to dead_letter and alerts owner after 5 failures', () => {
    const db = setupDb();
    const { id } = enqueuePrivateJob(db, { business: 'acme', cycle: 12, action: 'build', now: 1000 });

    let row = null;
    let t = 1000;
    for (let i = 0; i < 5; i++) {
      claimPrivateJob(db, { workerId: 'w1', leaseMs: 5000, now: t });
      row = failPrivateJob(db, { id, workerId: 'w1', now: t, baseBackoffMs: 100 });
      t = (row?.next_run_at ?? t) + 1;
    }
    expect(row?.status).toBe('dead_letter');
    expect(row?.attempts).toBe(5);
    expect(row?.alert_owner).toBe(1);
  });

  test('private jobs do not appear in public jobs table', () => {
    const db = setupDb();
    enqueuePrivateJob(db, { business: 'acme', cycle: 12, action: 'build', now: 1000 });
    const publicRows = db.query('SELECT * FROM jobs').all();
    expect(publicRows).toEqual([]);
  });
});
