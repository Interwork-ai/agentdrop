import type { DropDetail, ListDrops, Me } from '../../apps/web/src/lib/api.js';

/** Fictional, contract-shaped data for the illustrative recording; never loaded from a real mailbox. */
export const DEMO_H_ID = '11111111-1111-4111-8111-111111111111';
export const DEMO_DROP_ID = '22222222-2222-4222-8222-222222222222';
export const DEMO_BODY =
  'Run 14 beats the baseline on three of four splits. Please check split C before Friday.';
const createdAt = '2026-03-12T09:41:00.000Z';

export const demoMe: Me = {
  user_id: '33333333-3333-4333-8333-333333333333',
  handle: 'alice',
  display_name: 'Alice',
  public_email: null,
  directory_revision: 1,
  is_admin: false,
  cross_h_mailbox_enabled: true,
  notification_webhook_url: null,
  endpoints: [
    {
      h_id: DEMO_H_ID,
      label: 'Claude Code',
      public_name: null,
      name_version: 1,
      harness_key: 'claude-code',
      profile_key: 'default',
      device: {
        device_id: '44444444-4444-4444-8444-444444444444',
        label: 'Research laptop',
        platform: 'darwin',
        revoked: false,
      },
      is_default_receiver: true,
      created_at: createdAt,
      revoked_at: null,
    },
  ],
};

export function demoDrop(read = false, stateVersion = 0): DropDetail {
  return {
    drop_id: DEMO_DROP_ID,
    kind: 'context',
    title: 'Ablation results, run 14',
    preview: DEMO_BODY,
    author: {
      user_id: '55555555-5555-4555-8555-555555555555',
      handle: 'wang',
      display_label: 'Wang',
      public_name: null,
      public_email: null,
    },
    attachment_count: 2,
    received_at: createdAt,
    created_at: createdAt,
    sources: ['direct'],
    group_ids: [],
    group_labels: [],
    read,
    starred: false,
    archived: false,
    state_version: stateVersion,
    origin_agent: null,
    deliveries: [
      {
        h_id: DEMO_H_ID,
        agent_name: 'Claude Code',
        harness_key: 'claude-code',
        received_at: createdAt,
        read,
        starred: false,
        archived: false,
        state_version: stateVersion,
        sources: ['direct'],
        group_ids: [],
        current: true,
      },
    ],
    recipients: [],
    reply_to: null,
    body_chunk: DEMO_BODY,
    body_offset: 0,
    body_total_chars: DEMO_BODY.length,
    next_offset: null,
    attachments: [
      {
        attachment_id: '66666666-6666-4666-8666-666666666666',
        safe_name: 'results.csv',
        content_type: 'text/csv',
        byte_size: 1248,
        sha256: 'a'.repeat(64),
      },
      {
        attachment_id: '77777777-7777-4777-8777-777777777777',
        safe_name: 'notes.md',
        content_type: 'text/markdown',
        byte_size: 684,
        sha256: 'b'.repeat(64),
      },
    ],
    extensions: {},
    expires_at: null,
  };
}

export function demoInbox(read = false, stateVersion = 0): ListDrops {
  return {
    drops: [demoDrop(read, stateVersion)],
    next_cursor: null,
    unread_count: read ? 0 : 1,
    viewer: {
      user_id: demoMe.user_id,
      handle: demoMe.handle,
      display_name: demoMe.display_name,
      public_email: null,
      h_id: DEMO_H_ID,
      agent_name: 'Claude Code',
      directory_revision: 1,
      mailbox_revision: stateVersion,
      pending: {
        unread: read ? 0 : 1,
        contact_requests: 0,
        group_invitations: 0,
        approvals: 0,
      },
    },
  };
}
