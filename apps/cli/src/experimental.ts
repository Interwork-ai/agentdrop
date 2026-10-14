/**
 * The one switch for every experimental CLI feature (today: hidden autorun). Off unless explicitly turned on.
 *
 * - Installable package: `bundle.mjs` replaces `__AGENTDROP_EXPERIMENTAL__` with `false` at build time, so a released
 *   CLI cannot be switched on by any environment variable or config file. `AGENTDROP_BUILD_EXPERIMENTAL=1` at build
 *   time produces an internal build with it on.
 * - Running from source (tsx, tests): off unless `AGENTDROP_EXPERIMENTAL=1`.
 *
 * Every experimental entry point must ask this function; a feature that forgets stays reachable in the package.
 */
declare const __AGENTDROP_EXPERIMENTAL__: boolean | undefined;

export function experimentalEnabled(): boolean {
  if (typeof __AGENTDROP_EXPERIMENTAL__ === 'boolean') return __AGENTDROP_EXPERIMENTAL__;
  return process.env.AGENTDROP_EXPERIMENTAL === '1';
}
