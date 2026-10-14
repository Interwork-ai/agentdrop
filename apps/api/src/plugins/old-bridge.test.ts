import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { trimNewerFieldsForOldBridges, withoutNewerFields } from './old-bridge.js';

describe('old bridge capacity field compatibility', () => {
  it('trims the new capacity field for strict old bridges while preserving extension data', async () => {
    const app = Fastify();
    trimNewerFieldsForOldBridges(app);
    const payload = {
      groups: [{ endpoint_total: 201, endpoint_limit: 200, endpoints_over_limit: true }],
      extensions: { endpoints_over_limit: 'user data' },
    };
    app.get('/pending', async () => payload);
    try {
      const old = await app.inject({ url: '/pending', headers: { 'user-agent': 'agentdrop-bridge/0.4.10' } });
      expect(old.json()).toEqual({
        groups: [{ endpoint_total: 201, endpoint_limit: 200 }],
        extensions: payload.extensions,
      });
      for (const ua of ['agentdrop-bridge/0.4.11', 'agentdrop-cli/0.4.10']) {
        const current = await app.inject({ url: '/pending', headers: { 'user-agent': ua } });
        expect(current.json()).toEqual(payload);
      }
    } finally {
      await app.close();
    }
  });

  it('trims reply references for strict old bridges (ADR 0016)', async () => {
    const app = Fastify();
    trimNewerFieldsForOldBridges(app);
    const payload = {
      drops: [
        { drop_id: 'd', reply_to: { drop_id: 'o', title: 'T' }, replies: { count: 1, latest_at: null } },
      ],
    };
    app.get('/drops', async () => payload);
    try {
      const old = await app.inject({ url: '/drops', headers: { 'user-agent': 'agentdrop-bridge/0.4.10' } });
      expect(old.json()).toEqual({ drops: [{ drop_id: 'd' }] });
      const current = await app.inject({
        url: '/drops',
        headers: { 'user-agent': 'agentdrop-bridge/0.5.7' },
      });
      expect(current.json()).toEqual(payload);
    } finally {
      await app.close();
    }
  });

  it('shows clients before 0.5.9 an omp agent as other, outside extension data', async () => {
    const app = Fastify();
    trimNewerFieldsForOldBridges(app);
    const payload = {
      drops: [
        {
          origin_agent: { h_id: 'h', agent_name: 'Pi', harness_key: 'omp' },
          extensions: { harness_key: 'omp' },
        },
      ],
      harness_key: 'codex',
    };
    app.get('/drops', async () => payload);
    try {
      for (const ua of ['agentdrop-bridge/0.5.8', 'agentdrop-cli/0.5.8']) {
        const old = await app.inject({ url: '/drops', headers: { 'user-agent': ua } });
        expect(old.json()).toEqual({
          drops: [
            {
              origin_agent: { h_id: 'h', agent_name: 'Pi', harness_key: 'other' },
              extensions: { harness_key: 'omp' },
            },
          ],
          harness_key: 'codex',
        });
      }
      for (const ua of ['agentdrop-bridge/0.5.9', 'Mozilla/5.0']) {
        const current = await app.inject({ url: '/drops', headers: { 'user-agent': ua } });
        expect(current.json()).toEqual(payload);
      }
    } finally {
      await app.close();
    }
  });

  it('trims group storage and removed files (ADR 0029/0030) but keeps other uses of the name `removed`', () => {
    const file = { attachment_id: 'a', byte_size: 0, removed: true };
    expect(
      withoutNewerFields({
        drop: { attachments: [file], extensions: { removed: 'user data' } },
        storage: { used_bytes: 1, limit_bytes: 2 },
        removed: true,
      }),
    ).toEqual({
      drop: { attachments: [{ attachment_id: 'a', byte_size: 0 }], extensions: { removed: 'user data' } },
      removed: true,
    });
  });
});
