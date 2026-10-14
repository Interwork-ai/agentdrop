import { z } from 'zod';
import { displayNameSchema } from './names.js';

const base64UrlSchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be unpadded base64url');

const trustedPushHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return (
    host === 'fcm.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' ||
    host.endsWith('.push.apple.com') ||
    host.endsWith('.notify.windows.com')
  );
};

export const pushEndpointSchema = z
  .url()
  .max(2048)
  .refine((raw) => {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && trustedPushHost(url.hostname);
  }, 'push endpoint must be a trusted browser Web Push service URL');

export const pushSubscriptionInputSchema = z
  .object({
    endpoint: pushEndpointSchema,
    keys: z
      .object({
        p256dh: base64UrlSchema,
        auth: base64UrlSchema,
      })
      .strict(),
    device_label: displayNameSchema,
  })
  .strict();
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

/** Intentionally excludes endpoint and encryption keys. */
export const pushSubscriptionViewSchema = z.object({
  id: z.uuid(),
  device_label: z.string(),
  user_agent: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  last_success_at: z.iso.datetime().nullable(),
  failure_count: z.number().int().nonnegative(),
});
export type PushSubscriptionView = z.infer<typeof pushSubscriptionViewSchema>;

export const pushSettingsSchema = z.object({
  available: z.boolean(),
  vapid_public_key: z.string().nullable(),
  subscriptions: z.array(pushSubscriptionViewSchema),
});
export type PushSettings = z.infer<typeof pushSettingsSchema>;

export const pushSubscriptionDeleteResultSchema = z.object({ ok: z.literal(true) });
