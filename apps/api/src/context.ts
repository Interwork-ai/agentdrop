import type { Database } from '@agentdrop/db';
import type { FeishuAppConfig, SendOptions } from '@agentdrop/domain';
import type { StorageProvider } from '@agentdrop/storage';
import type { Auth } from './auth.js';
import type { AppConfig } from './config.js';
import type { EventHub } from './events.js';
import type { Mailer } from './mail.js';

export interface AppContext {
  config: AppConfig;
  db: Database;
  storage: StorageProvider;
  auth: Auth;
  /** Human-approval policy for sends (PR-04). Undefined = never requires approval. */
  approvalPolicy?: SendOptions['approvalPolicy'];
  /** Outgoing mail (password reset). Null/undefined: SMTP is not configured and nothing is mailed. */
  mailer?: Mailer | null;
  /** Outgoing requests to Feishu (connect test message). Tests replace it; production uses global fetch. */
  feishuFetch?: typeof fetch;
  /** The server's own Feishu app (ADR 0039); null or undefined when the operator configured none. */
  feishuApp?: FeishuAppConfig | null;
  /** Wakes event-stream readers (ADR 0040). `buildApp` creates one per process when absent. */
  events?: EventHub;
}

/** Where a person opens the dashboard: the browser origin when it differs from the API's public address. */
export function dashboardLink(ctx: AppContext): string {
  return `${(ctx.config.WEB_ORIGIN ?? ctx.config.PUBLIC_BASE_URL).replace(/\/$/, '')}/app/inbox`;
}
