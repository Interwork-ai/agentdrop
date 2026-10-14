import { withTx } from '@agentdrop/db';
import { isOlderRelease, sendUpdateReminders } from '@agentdrop/domain';
import { sql } from 'drizzle-orm';
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
  console.warn('[update-reminders.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

it('compares releases numerically and ignores builds it cannot read', () => {
  expect(isOlderRelease('0.4.19', '0.5.1')).toBe(true);
  expect(isOlderRelease('0.5.1', '0.5.1')).toBe(false);
  expect(isOlderRelease('0.10.0', '0.9.9')).toBe(false);
  expect(isOlderRelease('0.2.0-test', '0.5.1')).toBe(true);
  expect(isOlderRelease('dev', '0.5.1')).toBe(false);
});

describeDb('CLI update reminders', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let aliceH: PairedEndpoint;
  const DAY = 86_400_000;
  const opts = (now: Date) => ({
    latest: '0.5.1',
    scheduleMs: [1 * DAY, 3 * DAY, 7 * DAY],
    activeWithinMs: 14 * DAY,
    now,
  });
  const run = (now: Date) => withTx(t.db, (tx) => sendUpdateReminders(tx, opts(now)));
  const connect = (h: PairedEndpoint, version: string) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/connections',
      headers: hHeaders(h.credential),
      payload: { client_name: 'codex', client_version: '1', bridge_version: version, toolset: 'standard' },
    });
  const reminders = async () =>
    (await t.app.inject({ method: 'GET', url: '/v1/h/drops', headers: hHeaders(aliceH.credential) }))
      .json()
      .drops.filter((d: { author: { handle: string } }) => d.author.handle === 'agentdrop');

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    aliceH = await pair(t, alice, { endpointLabel: 'Lab Codex' });
  });

  it('reminds at once, then after 1, 3 and 7 days; never once current; not when updates are off', async () => {
    expect((await connect(aliceH, '0.4.19')).statusCode).toBe(200);
    const now = new Date();
    expect(await run(now)).toBe(1);
    const first = await reminders();
    expect(first).toHaveLength(1);
    expect(first[0].title).toContain('0.5.1');
    expect(first[0].sources).toEqual(['direct']);
    const body = (
      await t.app.inject({
        method: 'GET',
        url: `/v1/h/drops/${first[0].drop_id}`,
        headers: hHeaders(aliceH.credential),
      })
    ).json().drop.body_chunk as string;
    expect(body).toContain('Lab Codex');
    expect(body).toContain('0.4.19');
    expect(body).toContain('npm install -g agentdrop-cli@latest');

    // the sweep runs hourly; each wait in the schedule has to pass first: 1 day, then 3, then 7 (repeating)
    const at = (days: number) => run(new Date(now.getTime() + days * DAY));
    expect(await at(0.5)).toBe(0);
    expect(await at(1)).toBe(1);
    expect(await at(3)).toBe(0);
    expect(await at(4)).toBe(1);
    expect(await at(10)).toBe(0);
    expect(await at(11)).toBe(1);
    expect(await reminders()).toHaveLength(4);
    expect(body).toContain('1、3 天后再提醒，之后每 7 天一次');

    // upgraded: nothing more
    expect((await connect(aliceH, '0.5.1')).statusCode).toBe(200);
    expect(await at(12)).toBe(0);

    // update checks turned off for that device in the dashboard: left alone
    expect((await connect(aliceH, '0.4.19')).statusCode).toBe(200);
    await t.db.drizzle.execute(sql`
      update devices set client_preferences = jsonb_build_object(
        'version', 1, 'updated_at', null, 'applied', null,
        'settings', jsonb_build_object(
          'notifications', jsonb_build_object('enabled', true, 'interval_ms', 0, 'detail', 'counts'),
          'updates', jsonb_build_object('mode', 'off', 'interval_ms', 86400000)))
      where user_id = ${alice.userId}`);
    // without the switch this would be a fresh first reminder
    await t.db.drizzle.execute(sql`update app_users set update_reminder = null where id = ${alice.userId}`);
    expect(await at(13)).toBe(0);
  });

  it('ignores agents that have not connected recently', async () => {
    expect((await connect(aliceH, '0.4.19')).statusCode).toBe(200);
    await t.db.drizzle.execute(sql`update connections set last_seen_at = now() - interval '30 days'`);
    expect(await run(new Date())).toBe(0);
  });
});
