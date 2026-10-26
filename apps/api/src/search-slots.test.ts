import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createSearchSlots } from './routes/mailbox.js';

/*
 * The per-process search cap holds under parallel requests: the per-minute check is a database round trip, so a
 * slot must be taken before it is awaited, or every request that arrives meanwhile passes the cap.
 */
describe('search concurrency cap', () => {
  const req = {} as FastifyRequest;
  /** A per-minute limiter that answers after a turn of the event loop, as a database round trip does. */
  const slowAllow = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  it('lets at most `max` parallel searches of one person run at once', async () => {
    const slot = createSearchSlots(slowAllow, 2);
    let running = 0;
    let peak = 0;
    const search = async () => {
      const release = await slot(req, 'alice');
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      release();
    };
    const results = await Promise.allSettled(Array.from({ length: 8 }, search));
    expect(peak).toBeLessThanOrEqual(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(6);
    for (const r of refused) expect(r.reason).toMatchObject({ code: 'RATE_LIMITED' });
    // every slot came back: a later search runs
    await expect(slot(req, 'alice').then((release) => release())).resolves.toBeUndefined();
  });

  it('keeps people apart and gives the slot back when the per-minute limit refuses', async () => {
    let refuse = true;
    const slot = createSearchSlots(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (refuse) throw Object.assign(new Error('limited'), { code: 'RATE_LIMITED' });
    }, 1);
    for (let i = 0; i < 3; i++)
      await expect(slot(req, 'alice')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    refuse = false;
    const alice = await slot(req, 'alice');
    const bob = await slot(req, 'bob');
    await expect(slot(req, 'alice')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    alice();
    bob();
    (await slot(req, 'alice'))();
  });
});
