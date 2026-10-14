import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * deploy/pull-deploy.sh against stand-ins for sudo, docker and df: what it pulls, keeps and removes, and which
 * layout (env file, compose files, registry user) it deploys with. Every deploy leaves a ~1.3 GB image behind, and a
 * full disk can stop PostgreSQL in the middle of a deploy.
 */

const script = resolve(import.meta.dirname, '../deploy/pull-deploy.sh');
const IMAGE = 'ghcr.io/example/agent-drop/server';
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const folder = (n: number) => String(n).repeat(12);
const imageId = (n: number) => `sha256:${`i${n}`.repeat(32).slice(0, 64)}`;

const FAKE_DOCKER = `#!/usr/bin/env bash
f="$FAKE"
echo "docker $*" >> "$f/calls"
case "$1" in
  info) echo "$f/docker-root" ;;
  image)
    ref="$3"; d="\${ref##*@}"
    [ -f "$f/ids/$d" ] && cat "$f/ids/$d" || exit 1 ;;
  images) cat "$f/images" ;;
  ps) id="\${5#ancestor=}"; grep -qx "$id" "$f/in-use" 2>/dev/null && echo c0ffee || true ;;
  rmi) : ;;
  pull|login) : ;;
  inspect) echo sha256:running ;;
  exec)
    if [ "$2" = agentdrop-postgres-1 ]; then echo "-- dump"; exit 0; fi
    echo '{"status":"ready"}'; exit "$(cat "$f/ready-exit")" ;;
  compose) : ;;
esac
`;
const FAKE_SUDO = `#!/usr/bin/env bash
[ "$1" = -E ] && shift
exec "$@"
`;
const FAKE_DF = `#!/usr/bin/env bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/fake 60000000 1 $(cat "$FAKE/free-kb") 1% /"
`;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture({ freeGb = 20, ready = true }: { freeGb?: number; ready?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentdrop-pull-deploy-'));
  roots.push(root);
  const base = join(root, 'agent-drop');
  const fake = join(root, 'fake');
  const bin = join(root, 'bin');
  for (const d of [base, join(base, 'releases'), fake, join(fake, 'ids'), bin])
    mkdirSync(d, { recursive: true });
  for (const [name, body] of [
    ['docker', FAKE_DOCKER],
    ['sudo', FAKE_SUDO],
    ['df', FAKE_DF],
  ] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(base, '.env.production'), 'PUBLIC_BASE_URL=https://example.test\n', { mode: 0o600 });
  for (const file of ['compose.yaml', 'compose.production.yaml'])
    writeFileSync(join(base, file), 'services: {}\n');
  writeFileSync(join(fake, 'free-kb'), String(freeGb * 1048576));
  writeFileSync(join(fake, 'ready-exit'), ready ? '0' : '1');
  // five deployed images, newest first as `docker images` lists them; 3 is running, 2 was before it
  writeFileSync(join(fake, 'images'), `${[5, 4, 3, 2, 1].map(imageId).join('\n')}\n`);
  for (const n of [1, 2, 3, 4, 5]) writeFileSync(join(fake, 'ids', digest(n)), imageId(n));
  writeFileSync(
    join(base, 'releases', 'deployed.json'),
    `{"digest":"${digest(3)}","previous_digest":"${digest(2)}","deployed_at":"2026-01-01T00:00:00Z"}\n`,
  );
  // release folders, 5 the newest; plus one named by hand
  const now = Date.now() / 1000;
  for (const n of [1, 2, 3, 4, 5]) {
    const dir = join(base, 'releases', folder(n));
    mkdirSync(dir);
    writeFileSync(join(dir, 'database-before.sql'), '-- dump');
    utimesSync(dir, now - (10 - n) * 60, now - (10 - n) * 60);
  }
  mkdirSync(join(base, 'releases', 'server-v0.4.1'));
  const runWith = (extraEnv: Record<string, string>, ...args: string[]) =>
    spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        ...withoutDeployVars(process.env),
        PATH: `${bin}:${process.env.PATH}`,
        FAKE: fake,
        AGENTDROP_BASE: base,
        AGENTDROP_IMAGE: IMAGE,
        AGENTDROP_GHCR_TOKEN_FILE: join(root, 'no-token'),
        CONTENT_KEYS_HOST_FILE: join(root, 'no-keys'),
        AGENTDROP_READY_TRIES: '1',
        ...extraEnv,
      },
    });
  const run = (...args: string[]) => runWith({}, ...args);
  const calls = () => (existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8') : '');
  const removed = () =>
    calls()
      .split('\n')
      .filter((l) => l.startsWith('docker rmi'))
      .map((l) => l.split(' ').at(-1));
  const folders = () =>
    ['1', '2', '3', '4', '5', '6', '7', 'server-v0.4.1']
      .map((n) => (n.length === 1 ? folder(Number(n)) : n))
      .filter((n) => existsSync(join(base, 'releases', n)));
  return { root, base, fake, run, runWith, calls, removed, folders };
}

function withoutDeployVars(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('AGENTDROP_')));
}

describe('deploy/pull-deploy.sh', () => {
  it('--prune keeps the running, the previous and the newest other image and release folder', () => {
    const f = fixture();
    writeFileSync(join(f.fake, 'in-use'), `${imageId(1)}\n`);
    const r = f.run('--prune');
    expect(r.status, r.stderr).toBe(0);
    // kept 3 (running), 2 (rollback), 5 (newest other); 1 is used by a container, so only 4 goes
    expect(f.removed()).toEqual([imageId(4)]);
    // only this server's repository is ever listed
    expect(f.calls()).toContain(`docker images --no-trunc --format {{.ID}} ${IMAGE}`);
    expect(f.folders()).toEqual([folder(2), folder(3), folder(5), 'server-v0.4.1']);
    expect(r.stdout).toContain('removed 1 image(s) and 2 release folder(s), keeping 3 of each');
    expect(r.stdout).toContain('1 image(s) still in use left alone');
  });

  it('refuses to deploy with too little free space, before pulling or dumping anything', () => {
    const f = fixture({ freeGb: 1 });
    const r = f.run(digest(6));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('only 1 GB free');
    expect(f.calls()).not.toContain('docker pull');
    expect(f.calls()).not.toContain('pg_dump');
    expect(existsSync(join(f.base, 'releases', folder(6)))).toBe(false);
  });

  it('removes nothing when the new version does not become ready', () => {
    const f = fixture({ ready: false });
    const r = f.run(digest(6));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('roll back with');
    expect(f.removed()).toEqual([]);
    expect(readFileSync(join(f.base, 'releases', 'deployed.json'), 'utf8')).toContain(digest(3));
    expect(f.folders()).toContain(folder(1));
  });

  it('after a deploy that became ready, records it, keeps a private dump and prunes', () => {
    const f = fixture();
    writeFileSync(join(f.fake, 'ids', digest(6)), imageId(6));
    writeFileSync(join(f.fake, 'images'), `${[6, 5, 4, 3, 2, 1].map(imageId).join('\n')}\n`);
    const r = f.run(digest(6));
    expect(r.status, r.stderr).toBe(0);
    const state = readFileSync(join(f.base, 'releases', 'deployed.json'), 'utf8');
    expect(state).toContain(`"digest":"${digest(6)}"`);
    expect(state).toContain(`"previous_digest":"${digest(3)}"`);
    // kept 6 (running now), 3 (rollback), 5 (newest other)
    expect(f.removed().sort()).toEqual([imageId(1), imageId(2), imageId(4)].sort());
    expect(f.folders()).toEqual([folder(3), folder(5), folder(6), 'server-v0.4.1']);
    const dump = join(f.base, 'releases', folder(6), 'database-before.sql');
    expect(statSync(dump).mode & 0o077).toBe(0);
    expect(statSync(join(f.base, 'releases', folder(6), 'env.production.before')).mode & 0o077).toBe(0);
  });

  it('recovers the last healthy digest after readiness fails, keeping the earlier rollback target', () => {
    const f = fixture({ ready: false });
    expect(f.run(digest(6)).status).not.toBe(0);
    writeFileSync(join(f.fake, 'ready-exit'), '0');
    const recovered = f.run('--rollback');
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain(`rolling back to ${digest(3)}`);
    const state = JSON.parse(readFileSync(join(f.base, 'releases', 'deployed.json'), 'utf8'));
    expect(state.digest).toBe(digest(3));
    expect(state.previous_digest).toBe(digest(2));
  });

  it('rolls back a successful deployment to the last healthy digest', () => {
    const f = fixture();
    expect(f.run(digest(6)).status).toBe(0);
    const recovered = f.run('--rollback');
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain(`rolling back to ${digest(3)}`);
  });

  it('keeps the rollback target when deploying the same digest again', () => {
    const f = fixture();
    expect(f.run(digest(3)).status).toBe(0);
    const state = JSON.parse(readFileSync(join(f.base, 'releases', 'deployed.json'), 'utf8'));
    expect(state.previous_digest).toBe(digest(2));
  });

  it('deploys the production stack from docs/DEPLOY.md by default', () => {
    const f = fixture();
    const r = f.run(digest(6));
    expect(r.status, r.stderr).toBe(0);
    expect(f.calls()).toContain('docker compose -f compose.yaml -f compose.production.yaml -f ');
    expect(f.calls()).not.toContain('compose.local.yaml');
  });

  it('names the missing env file and the variable that sets it, before pulling anything', () => {
    const f = fixture();
    rmSync(join(f.base, '.env.production'));
    const r = f.run(digest(6));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('.env.production');
    expect(r.stderr).toContain('AGENTDROP_ENV_FILE');
    expect(f.calls()).not.toContain('docker pull');
  });

  it('takes a host layout from deploy/site.env, with the environment winning over it', () => {
    const f = fixture();
    mkdirSync(join(f.base, 'deploy'));
    writeFileSync(join(f.base, '.env.trial'), 'AGENTDROP_PORT=3300\n');
    writeFileSync(join(f.base, 'compose.local.yaml'), 'services: {}\n');
    writeFileSync(join(f.root, 'token'), 'fixture-token\n', { mode: 0o600 });
    writeFileSync(
      join(f.base, 'deploy', 'site.env'),
      [
        'AGENTDROP_ENV_FILE=.env.trial',
        'AGENTDROP_COMPOSE_FILES="compose.local.yaml"',
        'AGENTDROP_GHCR_USER=site-user',
        'AGENTDROP_KEEP=9',
        '',
      ].join('\n'),
    );
    const r = f.runWith({ AGENTDROP_GHCR_TOKEN_FILE: join(f.root, 'token'), AGENTDROP_KEEP: '3' }, digest(6));
    expect(r.status, r.stderr).toBe(0);
    expect(f.calls()).toContain('docker login ghcr.io -u site-user --password-stdin');
    expect(f.calls()).toContain('docker compose -f compose.local.yaml -f ');
    expect(f.calls()).not.toContain('compose.production.yaml');
    expect(existsSync(join(f.base, 'releases', folder(6), 'env.trial.before'))).toBe(true);
    expect(r.stdout).toContain('keeping 3 of each');
  });

  it('refuses a registry token without AGENTDROP_GHCR_USER instead of assuming a user', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'token'), 'fixture-token\n', { mode: 0o600 });
    const r = f.runWith({ AGENTDROP_GHCR_TOKEN_FILE: join(f.root, 'token') }, digest(6));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('AGENTDROP_GHCR_USER');
    expect(f.calls()).not.toContain('docker login');
    expect(f.calls()).not.toContain('docker pull');
  });
});
