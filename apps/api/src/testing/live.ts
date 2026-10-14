/**
 * Starts the real API on an ephemeral TCP port for black-box tests (MCP bridge over stdio → HTTPS client → API).
 */
import { createTestApp, type TestApp } from './harness.js';

export interface LiveApp extends TestApp {
  baseUrl: string;
}

export async function startLiveApp(): Promise<LiveApp> {
  const t = await createTestApp();
  const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
  return { ...t, baseUrl: address };
}
