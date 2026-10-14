import { homedir } from 'node:os';
import { join } from 'node:path';

/** XDG-style layout. Every path can be relocated with AGENTDROP_* variables (used by tests). */
export function configDir(): string {
  return (
    process.env.AGENTDROP_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'agentdrop')
  );
}
export function dataDir(): string {
  return (
    process.env.AGENTDROP_DATA_DIR ??
    join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'agentdrop')
  );
}
export function stateDir(): string {
  return (
    process.env.AGENTDROP_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'agentdrop')
  );
}
export function devicePath(): string {
  return join(configDir(), 'device.json');
}
export function profilesDir(): string {
  return join(configDir(), 'profiles');
}
export function profilePath(name: string): string {
  return join(profilesDir(), `${name}.json`);
}
export function downloadsDir(): string {
  return join(dataDir(), 'downloads');
}
export function logsDir(): string {
  return join(stateDir(), 'logs');
}
export function credentialsDir(): string {
  return join(configDir(), 'credentials');
}
