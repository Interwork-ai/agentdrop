import { z } from 'zod';

const maxInterval = 30 * 24 * 60 * 60 * 1000;
const versionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const releaseSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9.+_-]+$/);

export const clientSettingsSchema = z
  .object({
    notifications: z
      .object({
        enabled: z.boolean(),
        interval_ms: z.number().int().min(0).max(maxInterval),
        detail: z.enum(['counts', 'names']),
      })
      .strict(),
    updates: z
      .object({
        mode: z.enum(['off', 'notify', 'auto']),
        interval_ms: z.number().int().min(60_000).max(maxInterval),
      })
      .strict(),
  })
  .strict();
export type ClientSettings = z.infer<typeof clientSettingsSchema>;

/**
 * What the person has already been told about in an end-of-turn notice, shared by every agent of the account
 * (ADR 0007): a notice shown in one agent is not repeated in another. Only 16-hex-digit hashes of ids and the
 * approval count are stored, never names or titles.
 */
const noticeKey = z.string().regex(/^[0-9a-f]{16}$/);
export const noticeStateSchema = z
  .object({
    drops: z.array(noticeKey).max(500),
    contacts: z.array(noticeKey).max(200),
    invitations: z.array(noticeKey).max(200),
    join_requests: z.array(noticeKey).max(200),
    approvals: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export type NoticeState = z.infer<typeof noticeStateSchema>;
export const noticeStateResponseSchema = z.object({ state: noticeStateSchema.nullable() }).strict();
/** The record as it was before this claim; whatever is not in it is new and is now counted as shown. */
export const noticeClaimResponseSchema = z.object({ previous: noticeStateSchema.nullable() }).strict();

/**
 * The one merge rule for "already shown", used by the server's atomic claim and by the local fallback. Drops
 * accumulate (bounded); requests, invitations and join requests are replaced by what is pending now, so one that
 * was resolved and sent again counts as new; approvals are the current count.
 */
export function mergeNoticeState(
  previous: NoticeState | null | undefined,
  current: NoticeState,
): NoticeState {
  return {
    drops: [...new Set([...(previous?.drops ?? []), ...current.drops])].slice(-500),
    contacts: current.contacts,
    invitations: current.invitations,
    join_requests: current.join_requests,
    approvals: current.approvals,
  };
}

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  // Every turn end may check: notices only announce what is new (once per account), so no interval is needed to
  // keep them quiet. A person who wants fewer can still set one.
  notifications: { enabled: true, interval_ms: 0, detail: 'counts' },
  // a new CLI installs itself in the background (and with it the skill and the Claude Code mod); a person who wants
  // only a reminder, or nothing, says so per device
  updates: { mode: 'auto', interval_ms: 86_400_000 },
};

export const clientSettingsAppliedInputSchema = z
  .object({
    version: versionSchema,
    cli_version: releaseSchema,
    installed_cli_version: releaseSchema.optional(),
    skill_version: releaseSchema.nullable(),
    error: z.enum(['SKILL_SYNC_FAILED', 'LOCAL_OVERRIDE']).nullable(),
  })
  .strict();
export type ClientSettingsAppliedInput = z.infer<typeof clientSettingsAppliedInputSchema>;

export const deviceClientSettingsSchema = z
  .object({
    device_id: z.uuid(),
    version: versionSchema,
    settings: clientSettingsSchema,
    updated_at: z.iso.datetime().nullable(),
    applied: clientSettingsAppliedInputSchema.extend({ synced_at: z.iso.datetime() }).nullable(),
  })
  .strict();
export type DeviceClientSettings = z.infer<typeof deviceClientSettingsSchema>;

export const clientSettingsUpdateInputSchema = z
  .object({
    expected_version: versionSchema,
    settings: clientSettingsSchema,
  })
  .strict();
export type ClientSettingsUpdateInput = z.infer<typeof clientSettingsUpdateInputSchema>;
