import { Readable } from 'node:stream';
import { attachments } from '@agentdrop/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  hHeaders,
  type PairedEndpoint,
  pair,
  signUp,
  TEST_DATABASE_URL,
  type TestApp,
} from './testing/harness.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[attachments.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

describeDb('attachment upload failure paths', () => {
  let t: TestApp;
  let h: PairedEndpoint;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    h = await pair(t, await signUp(t, 'uploader'), { harness: 'codex' });
  });

  it('an aborted upload fails the staged attachment instead of hanging', async () => {
    const source = new Readable({ read() {} });
    // The server still sees the error through its pipe. This listener only keeps the test's own stream from
    // raising an unhandled 'error' when the request has already detached from it — a timing-dependent CI failure.
    source.on('error', () => {});
    source.push(Buffer.alloc(1024, 1));
    // Disconnect only once the server has staged the attachment: a fixed delay races the handler on a slow
    // runner, and an abort before staging never reserves anything, so it would test nothing.
    const disconnect = (async () => {
      for (let i = 0; i < 250; i++) {
        if ((await t.db.drizzle.select().from(attachments)).length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      source.destroy(new Error('client went away'));
    })();
    const res = await Promise.race([
      t.app.inject({
        method: 'POST',
        url: '/v1/h/attachments',
        headers: {
          ...hHeaders(h.credential),
          'content-type': 'application/octet-stream',
          'x-agentdrop-filename': 'partial.bin',
        },
        payload: source,
      }),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5000)),
    ]).catch((err: unknown) => err);
    expect(res).not.toBe('hung');
    // Never let the disconnect outlive this test and fire into the next one.
    await disconnect;
    // inject settles as soon as the request stream errors; the handler's cleanup commits just after (on a busy CI
    // runner this has taken over 2 s, so allow 5).
    let rows = await t.db.drizzle.select().from(attachments);
    for (let i = 0; i < 250 && rows[0]?.status === 'staging'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      rows = await t.db.drizzle.select().from(attachments);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.byteSize).toBe(0);
  });

  it('a malformed percent-encoded filename is a validation error, not a 500', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(h.credential),
        'content-type': 'application/octet-stream',
        'x-agentdrop-filename': 'bad%E0%A4%A.txt',
      },
      payload: Buffer.from('hello'),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
    expect(await t.db.drizzle.select().from(attachments)).toHaveLength(0);
  });
});

describeDb('attachment upload abort before storage is ready', () => {
  let t: TestApp;
  let h: PairedEndpoint;
  // Holds each storage write until the test says go, reproducing a slow storage backend (mkdir, S3 client setup)
  // that has not attached to the upload stream yet when the client disconnects.
  let release: () => void = () => {};

  beforeAll(async () => {
    t = await createTestApp({
      wrapStorage: (storage) =>
        Object.assign(Object.create(storage), {
          put: async (...args: Parameters<typeof storage.put>) => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return storage.put(...args);
          },
        }),
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    h = await pair(t, await signUp(t, 'uploader'), { harness: 'codex' });
  });

  it('a disconnect while storage is still setting up fails the upload instead of crashing the process', async () => {
    const source = new Readable({ read() {} });
    source.on('error', () => {});
    source.push(Buffer.alloc(1024, 1));
    const request = t.app
      .inject({
        method: 'POST',
        url: '/v1/h/attachments',
        headers: {
          ...hHeaders(h.credential),
          'content-type': 'application/octet-stream',
          'x-agentdrop-filename': 'early.bin',
        },
        payload: source,
      })
      .catch((err: unknown) => err);
    for (let i = 0; i < 250 && (await t.db.drizzle.select().from(attachments)).length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    // The client goes away while storage has not touched the stream yet; before the fix this raised an uncaught
    // 'error' on the upload pipe and took the whole API process down.
    source.destroy(new Error('client went away early'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await request;
    let rows = await t.db.drizzle.select().from(attachments);
    for (let i = 0; i < 100 && rows[0]?.status === 'staging'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      rows = await t.db.drizzle.select().from(attachments);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
  });
});
