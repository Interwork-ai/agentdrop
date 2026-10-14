import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundledSkillDir, bundledSkillVersion, ensureBundledSkills } from './commands/skill.js';
import { CLI_VERSION } from './output.js';

export interface SkillReport {
  cli_version: string;
  installed_cli_version?: string;
  skill_version: string | null;
  error: 'SKILL_SYNC_FAILED' | null;
}

/** Source checkout commands must not silently install development skills into the user's harnesses. */
export function isPackagedCli(): boolean {
  try {
    return (
      JSON.parse(readFileSync(resolve(bundledSkillDir(), '..', '..', 'package.json'), 'utf8')).name ===
      'agentdrop-cli'
    );
  } catch {
    return false;
  }
}

export function synchronizeInstalledSkills(): SkillReport {
  const version = bundledSkillVersion();
  if (!isPackagedCli()) return { cli_version: CLI_VERSION, skill_version: null, error: null };
  const result = ensureBundledSkills();
  const active = result.installed.filter((item) =>
    ['installed', 'updated', 'unchanged'].includes(item.status),
  );
  return {
    cli_version: CLI_VERSION,
    installed_cli_version: version,
    skill_version: result.errors.length === 0 && active.length > 0 ? result.version : null,
    error: result.errors.length ? 'SKILL_SYNC_FAILED' : null,
  };
}
