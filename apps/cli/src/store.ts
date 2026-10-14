import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { harnessKeySchema } from '@agentdrop/contracts';
import { z } from 'zod';
import { configDir, devicePath, profilePath, profilesDir } from './paths.js';

export const deviceFileSchema = z.object({
  installation_id: z.uuid(),
  label: z.string().min(1),
  server_url: z.string().url().optional(),
  /** Set by `login --allow-http`: the user accepted cleartext for this server. */
  allow_http: z.boolean().optional(),
  created_at: z.string(),
  rebound_at: z.string().optional(),
});
export type DeviceFile = z.infer<typeof deviceFileSchema>;

export const profileFileSchema = z.object({
  profile: z.string(),
  server_url: z.string().url(),
  h_id: z.uuid(),
  harness: harnessKeySchema,
  profile_key: z.string(),
  user_id: z.uuid(),
  handle: z.string(),
  agent_name: z.string(),
  credential_ref: z.object({ store: z.enum(['keychain', 'file']), account: z.string() }),
  credential_expires_at: z.string(),
  paired_at: z.string(),
  allowed_dirs: z.array(z.string()).default([]),
  toolset: z.enum(['core', 'standard']).default('standard'),
});
export type ProfileFile = z.infer<typeof profileFileSchema>;

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* windows or unsupported fs */
  }
}

/** Atomic private write: temp file + rename, mode 0600. */
export function writePrivateFile(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readDevice(): DeviceFile | null {
  if (!existsSync(devicePath())) return null;
  return deviceFileSchema.parse(JSON.parse(readFileSync(devicePath(), 'utf8')));
}

export function ensureDevice(label?: string): DeviceFile {
  const existing = readDevice();
  if (existing) return existing;
  const device: DeviceFile = {
    installation_id: randomUUID(),
    label: label ?? hostname(),
    created_at: new Date().toISOString(),
  };
  writeDevice(device);
  return device;
}

export function writeDevice(device: DeviceFile): void {
  ensureDir(configDir());
  writePrivateFile(devicePath(), `${JSON.stringify(device, null, 2)}\n`);
}

export function readProfile(name: string): ProfileFile | null {
  const p = profilePath(name);
  if (!existsSync(p)) return null;
  return profileFileSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
}

export function writeProfile(profile: ProfileFile): void {
  ensureDir(profilesDir());
  writePrivateFile(profilePath(profile.profile), `${JSON.stringify(profile, null, 2)}\n`);
}

export function deleteProfile(name: string): void {
  const p = profilePath(name);
  if (existsSync(p)) unlinkSync(p);
}

export function listProfiles(): ProfileFile[] {
  if (!existsSync(profilesDir())) return [];
  return readdirSync(profilesDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return profileFileSchema.parse(JSON.parse(readFileSync(join(profilesDir(), f), 'utf8')));
      } catch {
        return null;
      }
    })
    .filter((p): p is ProfileFile => p !== null);
}
