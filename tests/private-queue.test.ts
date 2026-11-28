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

  test('expired lease re-queues job with exponential backoff', () => {
    const db = setupDb();
    enqueuePrivateJob(db, { business: 'acme', cycle: 12, action: 'build', now: 1000 });
    const claimed = claimPrivateJob(db, { workerId: 'w1', leaseMs: 5000, now: 1000 });
    expect(claimed?.status).toBe('leased');

    // Lease expired at 6000; claim at 6500 triggers re-queue with 1000ms backoff (next_run_at = 7500).
    const noneYet = claimPrivateJob(db, { workerId: 'w2', leaseMs: 5000, now: 6500 });
    expect(noneYet).toBeNull();

    const reclaimed = claimPrivateJob(db, { workerId: 'w2', leaseMs: 5000, now: 7500 });
    expect(reclaimed?.worker_id).toBe('w2');
    expect(reclaimed?.attempts).toBe(1);
  });

  test('moves job to dead_letter and alerts owner after 5 failures', () => {
    const db = setupDb();
    const { id } = enqueuePrivateJob(db, { business: 'acme', cycle: 12, action: 'build', now: 1000 });

    let row;
    for (let i = 0; i < 5; i++) {
      row = failPrivateJob(db, { id, now: 1000 + i * 100, baseBackoffMs: 100 });
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
