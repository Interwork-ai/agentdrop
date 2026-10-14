import { createHash, randomUUID } from 'node:crypto';
import { drops, withTx } from '@agentdrop/db';
import { planExport, readExportChunk } from '@agentdrop/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BrowserUser,
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
  console.warn('[export.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

const DAY = 86_400_000;
const BASE = Date.parse('2026-06-10T12:00:00.000Z');
const iso = (offsetDays: number) => new Date(BASE + offsetDays * DAY).toISOString();

interface Parsed {
  header: Record<string, unknown>;
  records: Array<Record<string, unknown>>;
  trailer: Record<string, unknown> | null;
  raw: string;
}

function parseNdjson(body: string): Parsed {
  const lines = body.split('\n').filter((l) => l.length > 0);
  const objects = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    header: objects[0] ?? {},
    records: objects.filter((o) => o.record === 'drop'),
    trailer: objects.find((o) => o.record === 'trailer') ?? null,
    raw: body,
  };
}

describeDb('date-ranged export', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let aliceSecond: PairedEndpoint;
  let bobH: PairedEndpoint;
  let bobSecond: PairedEndpoint;
  let carolH: PairedEndpoint;

  const post = (url: string, user: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });

  async function befriend(a: BrowserUser, b: BrowserUser) {
    await post('/v1/me/contacts/invite', a, { handle: b.handle });
    await post(`/v1/me/contacts/${a.userId}/accept`, b);
  }

  /** Sends, then backdates the drop so a range can be exercised without waiting. */
  async function sendAt(ep: PairedEndpoint, targets: unknown[], title: string, dayOffset: number) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(ep.credential),
      payload: {
        request_id: `exp-${randomUUID()}`,
        targets,
        payload: {
          payload_version: 1,
          kind: 'text',
          title,
          body: `body of ${title}`,
          attachment_ids: [],
          extensions: {},
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const dropId = res.json().drop_id as string;
    await t.db.drizzle
      .update(drops)
      .set({ createdAt: new Date(BASE + dayOffset * DAY) })
      .where(eq(drops.id, dropId));
    return dropId;
  }

  const exportAs = (ep: PairedEndpoint, query: Record<string, string>) =>
    t.app.inject({
      method: 'GET',
      url: `/v1/h/export?${new URLSearchParams(query).toString()}`,
      headers: hHeaders(ep.credential),
    });

  const exportWeb = (user: BrowserUser, hId: string, query: Record<string, string>) =>
    t.app.inject({
      method: 'GET',
      url: `/v1/me/endpoints/${hId}/export?${new URLSearchParams(query).toString()}`,
      headers: { cookie: user.cookie },
    });

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', '王同学');
    carol = await signUp(t, 'carol', '李同学');
    aliceH = await pair(t, alice, { harness: 'codex', endpointLabel: '小码' });
    aliceSecond = await pair(t, alice, { harness: 'claude-code', endpointLabel: '第二个' });
    bobH = await pair(t, bob, { harness: 'codex' });
    bobSecond = await pair(t, bob, { harness: 'claude-code' });
    carolH = await pair(t, carol, { harness: 'codex' });
    await befriend(alice, bob);
    await befriend(alice, carol);
  });

  it('carries both directions of direct traffic, in range, with a verifiable trailer', async () => {
    await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'before the window', -5);
    const mine = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'from alice', 1);
    const theirs = await sendAt(bobH, [{ type: 'user', user_id: alice.userId }], 'from bob', 2);
    await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'after the window', 9);

    const res = await exportAs(aliceH, {
      scope: 'peer',
      peer_user_id: bob.userId,
      since: iso(0),
      until: iso(5),
      include_body: 'true',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(String(res.headers['content-disposition'])).toContain('attachment');

    const out = parseNdjson(res.body);
    expect(out.records.map((r) => r.drop_id)).toEqual([mine, theirs]);
    expect(out.records.map((r) => r.direction)).toEqual(['out', 'in']);
    expect(out.records[0]?.body).toBe('body of from alice');
    expect(out.header).toMatchObject({ record: 'header', count: 2, scope: 'peer', peer_handle: 'bob' });

    // The trailer is what makes a truncated download detectable; verify it the way a reader must.
    const dropLines = out.raw
      .split('\n')
      .filter((l) => l.length > 0 && (JSON.parse(l) as { record: string }).record === 'drop')
      .map((l) => `${l}\n`)
      .join('');
    expect(out.trailer).toMatchObject({ count: 2 });
    expect(out.trailer?.sha256).toBe(createHash('sha256').update(dropLines).digest('hex'));
  });

  it('leaves group traffic out of a per-contact export', async () => {
    const created = await post('/v1/me/groups', alice, {
      slug: 'team',
      display_name: '小组',
      binding_h_ids: [aliceH.hId],
      invite_handles: ['bob'],
    });
    const groupId = created.json().group_id as string;
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobH.hId] });
    const direct = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'direct', 1);
    const viaGroup = await sendAt(aliceH, [{ type: 'group', group_id: groupId }], 'via group', 2);

    const peer = parseNdjson(
      (
        await exportAs(aliceH, {
          scope: 'peer',
          peer_user_id: bob.userId,
          since: iso(0),
          until: iso(5),
        })
      ).body,
    );
    // Including it would answer "which members received this group drop", which the group card withholds.
    expect(peer.records.map((r) => r.drop_id)).toEqual([direct]);

    const group = parseNdjson(
      (await exportAs(aliceH, { scope: 'group', group_id: groupId, since: iso(0), until: iso(5) })).body,
    );
    expect(group.records.map((r) => r.drop_id)).toEqual([viaGroup]);
  });

  it('narrows to the credential endpoint when the caller asks, and when the account preference is off', async () => {
    const fromFirst = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'from agent one', 1);
    const fromSecond = await sendAt(
      aliceSecond,
      [{ type: 'user', user_id: bob.userId }],
      'from agent two',
      2,
    );

    const wide = parseNdjson(
      (await exportAs(aliceH, { scope: 'peer', peer_user_id: bob.userId, since: iso(0), until: iso(5) }))
        .body,
    );
    expect(wide.records.map((r) => r.drop_id)).toEqual([fromFirst, fromSecond]);

    const narrow = parseNdjson(
      (
        await exportAs(aliceH, {
          scope: 'peer',
          peer_user_id: bob.userId,
          since: iso(0),
          until: iso(5),
          endpoint_scope: 'current',
        })
      ).body,
    );
    expect(narrow.records.map((r) => r.drop_id)).toEqual([fromFirst]);

    // Turning cross-agent reading off must narrow it too: authorship alone would hand over the whole account.
    await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/mailbox-settings',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { cross_h_mailbox_enabled: false },
    });
    const off = parseNdjson(
      (await exportAs(aliceH, { scope: 'peer', peer_user_id: bob.userId, since: iso(0), until: iso(5) }))
        .body,
    );
    expect(off.records.map((r) => r.drop_id)).toEqual([fromFirst]);
  });

  it('lists a drop once however many of my agents received it', async () => {
    const dropId = await sendAt(bobH, [{ type: 'user', user_id: alice.userId }], 'to alice', 1);
    // A second delivery of the same drop to another of alice's agents must not double the row.
    await sendAt(bobSecond, [{ type: 'user', user_id: alice.userId }], 'another', 2);
    const out = parseNdjson(
      (await exportAs(aliceH, { scope: 'peer', peer_user_id: bob.userId, since: iso(0), until: iso(5) }))
        .body,
    );
    expect(out.records.filter((r) => r.drop_id === dropId)).toHaveLength(1);
    expect(out.header.count).toBe(out.records.length);
  });

  it('omits revoked drops', async () => {
    const kept = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'kept', 1);
    const gone = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'revoked', 2);
    await t.db.drizzle.update(drops).set({ revokedAt: new Date() }).where(eq(drops.id, gone));
    const out = parseNdjson(
      (await exportAs(aliceH, { scope: 'peer', peer_user_id: bob.userId, since: iso(0), until: iso(5) }))
        .body,
    );
    expect(out.records.map((r) => r.drop_id)).toEqual([kept]);
    expect(out.header).toMatchObject({ notes: expect.objectContaining({ excludes_revoked: true }) });
  });

  it('leaves out a drop revoked between the plan and its chunk, and the trailer accounts for it', async () => {
    const kept = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'kept', 1);
    const gone = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'revoked mid-stream', 2);
    const scope = { userId: alice.userId, hId: aliceH.hId, via: 'h_credential' as const };
    const plan = await withTx(t.db, (tx) =>
      planExport(tx, scope, {
        scope: 'peer',
        peer_user_id: bob.userId,
        since: iso(0),
        until: iso(5),
        include_body: true,
      }),
    );
    expect(plan.dropIds).toEqual([kept, gone]);
    await t.db.drizzle.update(drops).set({ revokedAt: new Date() }).where(eq(drops.id, gone));
    const records = await readExportChunk(t.db, scope, plan, plan.dropIds, true);
    expect(records.map((r) => r.drop_id)).toEqual([kept]);

    const full = parseNdjson(
      (await exportAs(aliceH, { scope: 'peer', peer_user_id: bob.userId, since: iso(0), until: iso(5) }))
        .body,
    );
    expect(full.trailer).toMatchObject({ count: 1, omitted: 0 });
  });

  it('omits drops whose retention has run out', async () => {
    const kept = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'kept', 1);
    const stale = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'expired', 2);
    // The header promises expired drops are absent; prove it rather than trusting the claim.
    await t.db.drizzle
      .update(drops)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(drops.id, stale));
    const out = parseNdjson(
      (await exportAs(aliceH, { scope: 'peer', peer_user_id: bob.userId, since: iso(0), until: iso(5) }))
        .body,
    );
    expect(out.records.map((r) => r.drop_id)).toEqual([kept]);
    expect(out.header).toMatchObject({ notes: expect.objectContaining({ excludes_expired: true }) });
  });

  it('reproduces every drop exactly once across two adjacent ranges', async () => {
    const first = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'day one', 1);
    const boundary = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'on the boundary', 3);
    const later = await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'day four', 4);
    const range = (since: number, until: number) =>
      exportAs(aliceH, {
        scope: 'peer',
        peer_user_id: bob.userId,
        since: iso(since),
        until: iso(until),
      }).then((r) => parseNdjson(r.body).records.map((x) => x.drop_id));
    // [since, until): the boundary drop belongs to the later window and to neither twice.
    expect(await range(0, 3)).toEqual([first]);
    expect(await range(3, 6)).toEqual([boundary, later]);
  });

  it('answers the same for a stranger and for a user id that does not exist', async () => {
    await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'private', 1);
    const stranger = await exportAs(aliceH, {
      scope: 'peer',
      peer_user_id: carol.userId,
      since: iso(0),
      until: iso(5),
    });
    const nobody = await exportAs(aliceH, {
      scope: 'peer',
      peer_user_id: '00000000-0000-0000-0000-000000000000',
      since: iso(0),
      until: iso(5),
    });
    expect(stranger.statusCode).toBe(nobody.statusCode);
    const a = parseNdjson(stranger.body);
    const b = parseNdjson(nobody.body);
    expect(a.records).toHaveLength(0);
    expect(b.records).toHaveLength(0);
    expect(a.header.peer_handle).toBe(b.header.peer_handle);
  });

  it('gives a group admin the full history only when asked, and never over an agent credential', async () => {
    const created = await post('/v1/me/groups', alice, {
      slug: 'paper',
      display_name: '论文组',
      binding_h_ids: [aliceH.hId],
    });
    const groupId = created.json().group_id as string;
    const early = await sendAt(aliceH, [{ type: 'group', group_id: groupId }], 'before carol', 1);

    await post(`/v1/me/groups/${groupId}/invite`, alice, { handles: ['carol'] });
    await post(`/v1/me/groups/${groupId}/accept`, carol, { h_ids: [carolH.hId] });
    await t.app.inject({
      method: 'PATCH',
      url: `/v1/me/groups/${groupId}/members/${carol.userId}`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { role: 'admin' },
    });

    const plain = parseNdjson(
      (await exportAs(carolH, { scope: 'group', group_id: groupId, since: iso(0), until: iso(5) })).body,
    );
    expect(plain.records.map((r) => r.drop_id)).not.toContain(early);

    // The agent credential cannot reach pre-membership history at all, asked for or not.
    const viaAgent = await exportAs(carolH, {
      scope: 'group',
      group_id: groupId,
      since: iso(0),
      until: iso(5),
      include_group_history: 'true',
    });
    expect(viaAgent.statusCode).toBe(403);

    const viaWeb = parseNdjson(
      (
        await exportWeb(carol, carolH.hId, {
          scope: 'group',
          group_id: groupId,
          since: iso(0),
          until: iso(5),
          include_group_history: 'true',
        })
      ).body,
    );
    expect(viaWeb.records.map((r) => r.drop_id)).toContain(early);
    expect(viaWeb.header).toMatchObject({ include_group_history: true });
  });

  it('refuses a range longer than the cap instead of truncating', async () => {
    const res = await exportAs(aliceH, {
      scope: 'peer',
      peer_user_id: bob.userId,
      since: iso(0),
      until: iso(400),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('records one audit row that says how much was disclosed', async () => {
    await sendAt(aliceH, [{ type: 'user', user_id: bob.userId }], 'audited', 1);
    await exportAs(aliceH, {
      scope: 'peer',
      peer_user_id: bob.userId,
      since: iso(0),
      until: iso(5),
      include_body: 'true',
    });
    const rows = await t.db.drizzle.execute(
      `select action, meta from audit_events where action like 'drop.export%' order by created_at desc limit 1`,
    );
    const row = rows.rows[0] as { action: string; meta: Record<string, unknown> };
    expect(row.action).toBe('drop.export');
    expect(row.meta).toMatchObject({ scope: 'peer', count: 1, include_body: true });
  });
});
