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

/** Bound an event wait without leaving its timeout alive after the event arrives. */
async function within<T>(event: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      event,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('upload event did not arrive')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function signal() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeDb('attachment upload failure paths', () => {
  let t: TestApp;
  let h: PairedEndpoint;
  let putEntered = signal();

  beforeAll(async () => {
    t = await createTestApp({
      wrapStorage: (storage) =>
        Object.assign(Object.create(storage), {
          put: (...args: Parameters<typeof storage.put>) => {
            putEntered.resolve();
            return storage.put(...args);
          },
        }),
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    putEntered = signal();
    await t.reset();
    h = await pair(t, await signUp(t, 'uploader'), { harness: 'codex' });
  });

  it('an aborted upload fails the staged attachment instead of hanging', async () => {
    const source = new Readable({ read() {} });
    // The server still sees the error through its pipe. This listener only keeps the test's own stream from
    // raising an unhandled 'error' when the request has already detached from it — a timing-dependent CI failure.
    source.on('error', () => {});
    source.push(Buffer.alloc(1024, 1));
    const request = t.app
      .inject({
        method: 'POST',
        url: '/v1/h/attachments',
        headers: {
          ...hHeaders(h.credential),
          'content-type': 'application/octet-stream',
          'x-agentdrop-filename': 'partial.bin',
        },
        payload: source,
      })
      .catch((err: unknown) => err);
    try {
      // A committed staging row does not mean the route resumed and attached its stream observer yet.
      // light-my-request does not retain a native stream's abort error for a late observer; storage entry
      // proves this is an in-flight upload with the route's observer already installed.
      await within(putEntered.promise, 5000);
    } finally {
      source.destroy(new Error('client went away'));
      await within(request, 5000);
    }
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
  let storageReady = signal();
  let putEntered = signal();
  let sourceClosed = signal();

  beforeAll(async () => {
    t = await createTestApp({
      wrapStorage: (storage) =>
        Object.assign(Object.create(storage), {
          put: async (...args: Parameters<typeof storage.put>) => {
            // Observe closure without swallowing errors: an unhandled stream error must still fail this test.
            args[1].once('close', () => sourceClosed.resolve());
            putEntered.resolve();
            await storageReady.promise;
            return storage.put(...args);
          },
        }),
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    putEntered = signal();
    sourceClosed = signal();
    storageReady = signal();
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
    try {
      // The route observes the request, but storage has not attached its consumer. Wait for both exact
      // events so no database polling or fixed delay can race the disconnect and the storage release.
      await within(putEntered.promise, 5000);
      source.destroy(new Error('client went away early'));
      await within(sourceClosed.promise, 5000);
    } finally {
      source.destroy(new Error('client went away early'));
      storageReady.resolve();
      await within(request, 5000);
    }
    let rows = await t.db.drizzle.select().from(attachments);
    for (let i = 0; i < 100 && rows[0]?.status === 'staging'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      rows = await t.db.drizzle.select().from(attachments);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
  });
});
