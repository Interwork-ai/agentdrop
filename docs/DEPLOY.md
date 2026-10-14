# Deployment (trial, single Linux host)

How to run the server on one Linux host, implemented as `Dockerfile`, `compose.yaml`, `compose.production.yaml`,
`compose.keys.yaml`, `deploy/Caddyfile` and `deploy/pull-deploy.sh`.

No domain yet or 80/443 taken? See [DEPLOY_TRIAL.md](DEPLOY_TRIAL.md) (plain http on a high port, `--allow-http`).

What a live server runs and every change made to it belongs in its operator's deployment log, outside this
repository (docs/PUBLIC_REPOSITORY.md).

## Prerequisites

- A public DNS name (`AGENTDROP_DOMAIN`) pointing at the host; ports 80/443 reachable (Caddy issues certificates).
- A private S3-compatible bucket (production refuses the filesystem storage provider).
- Docker Compose 2.24 or later (the production override resets the development database port).
- `.env.production` created from `.env.example` with real values. Minimum:

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://drop.example.com
POSTGRES_PASSWORD=<random database password>
DATABASE_URL=postgresql://agentdrop:CHANGE_ME@postgres:5432/agentdrop
AUTH_SECRET=<openssl rand -base64 48>
STORAGE_PROVIDER=s3
S3_REGION=…
S3_BUCKET=…
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
WEB_PUSH_VAPID_PUBLIC_KEY=<web-push public key>
WEB_PUSH_VAPID_PRIVATE_KEY=<web-push private key>
WEB_PUSH_VAPID_SUBJECT=mailto:ops@example.com
LOG_CONTENT=false
DEV_AUTH=false
```

Generate the VAPID keys once, for example with `pnpm dlx web-push generate-vapid-keys`. Leaving all three empty
turns Web Push off; the worker requires all three together. Compose passes the public key to the API and the
browser, and explicitly keeps the private key and the subject out of the API process.

The API validates this at startup and refuses to boot with dev auth, filesystem storage, a placeholder or short
secret, an `http://` public URL, or content logging enabled.

Set `POSTGRES_PASSWORD` to a generated password and use the same password (URL-encoded) in `DATABASE_URL`.
Compose refuses an unset or empty password and never publishes PostgreSQL's port in the production combination.
For an existing database volume, changing this variable does not rotate the database role's password: change the
role password through PostgreSQL and update the connection settings together.

## First deployment

```bash
pnpm install --frozen-lockfile
pnpm verify                                            # lint, typecheck, contracts + migration drift, tests, build
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml build
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml run --rm migrate
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml up -d
curl -fsS https://drop.example.com/health/ready
```

`api` serves the built dashboard from the same origin (`WEB_DIST_DIR`), so session cookies stay first-party and the
CSP is strict (`default-src 'self'`). `worker` runs the outbox consumer and the staging/connection sweeps; the API
delivers drops without it.

**Client addresses and `TRUST_PROXY`.** Rate limits (sign-in: 3 attempts in 10 s per address; password reset,
recovery codes and pairing per address) use the client address the API sees. Set `TRUST_PROXY=true` exactly when a
reverse proxy you run (Caddy, nginx) sits in front of the API and sets `X-Forwarded-For`; `compose.production.yaml`
does. Without a proxy, leave it `false`: a client could otherwise write that header itself. Behind a proxy with it
`false`, every visitor looks like the proxy and shares one sign-in limit. A plain TCP forward that does not keep
the source address has the same effect.

Web Push needs HTTPS (localhost is the development exception). After deploying, check it on a real device: Turn on
notifications → send a new drop → receive it on the lock screen → click through to the drop on the right agent. On
iOS/iPadOS 16.4+ also check the add-to-home-screen flow.

Tag images by version (for example `AGENTDROP_IMAGE=ghcr.io/interwork-ai/agentdrop/server:<version>`, the image CI
publishes) and pin base images by digest before a real release.

## Users

1. Each person signs up in the dashboard. Sign-up is `open` by default; set `SIGNUP_MODE=closed` (or switch it in
   Admin → Sign-up settings, see [ADMIN.md](ADMIN.md)) once the people you expect have registered. For an invite-only
   trial you can also keep the dashboard behind Caddy basic auth or a VPN.
2. On every machine: `agentdrop login --server https://drop.example.com`, then `agentdrop endpoint add …` per
   harness/profile and approve the code in the browser.
3. `agentdrop connect codex --profile codex` / `agentdrop connect claude-code --profile cc`.
4. `agentdrop doctor --mcp`.

## Password reset and email (optional SMTP)

The server sends exactly one kind of email: the password reset link. Configure it in `.env.production`:

```dotenv
SMTP_URL=smtps://USER:PASSWORD@smtp.example.com:465   # or smtp://…:587 for STARTTLS
MAIL_FROM=AgentDrop <no-reply@drop.example.com>
```

- `SMTP_URL` holds a credential: keep it only in the env file. It is never logged; the API refuses to start when
  `SMTP_URL` is set without `MAIL_FROM`. `nodemailer` ships inside the image/runtime tarball, nothing to install.
- The mail is plain text with only the link `PUBLIC_BASE_URL/reset-password?token=…` (the `WEB_ORIGIN` when that is
  set). The link lives 1 hour and works once; using it ends every browser session of the account (agent credentials
  are untouched). Request logs replace the `token` value with `[redacted]`; keep proxy access logs (Caddy) free of
  query strings as well, or rotate them.
- Requests are limited to 10 per hour per client address and 3 per hour per email address. The answer is the same
  whether or not the address has an account; closed accounts and the built-in assistant never get mail.
- Mail is optional: without SMTP, people still get back in on their own (ADR 0036) with
  `agentdrop account recover` on a computer where one of their agents is paired, or with a recovery code from
  Settings. The administrator's reset link stays as the last resort: open the user in Admin → Users and click
  "Generate reset link"; the link is shown once, a new one retires the previous one, and the audit log records
  `admin.password_reset_link` (actor and target, never the link or token). Hand it over privately.

Check outbound SMTP from the host before configuring it (TCP connect to the provider on 465/587, no mail sent).
Some networks leave only through an HTTP proxy: if that proxy does not tunnel SMTP, email there needs an HTTPS mail
API instead, and the server stays on the admin reset link.

Better Auth endpoints other than sign-in, sign-out, get-session, request-password-reset and reset-password answer
404 through `/api/auth/*`; in particular `/api/auth/sign-up/email` cannot bypass `SIGNUP_MODE=closed`.

## Backups

- Daily `pg_dump` of the database into `./backups` (mounted into the postgres container) and copy it off-host;
  keep 7 daily + 4 weekly.
- Enable versioning/backups on the bucket. Attachments are referenced by random keys stored in the database, so
  restore the database and the bucket from the same point in time.
- Rehearse a restore on a staging host before the first real users and before every PostgreSQL major upgrade:
  restore, run `pnpm db:check`, log in as two test users, verify one drop with an attachment is readable by the
  right endpoint and not by another.
- After restoring an older database, revoke every H credential (dashboard → My agents → Revoke) and re-pair; the restore may
  resurrect credentials that had been revoked after the backup point.

## Content encryption at rest

Design and rationale: [plan/CONTENT_ENCRYPTION.md](plan/CONTENT_ENCRYPTION.md), [ADR 0010](adr/0010-content-encryption-at-rest.md).
With it on, drop titles, bodies, extensions, attachment names and bytes and pending approvals are stored encrypted;
a database dump, a backup or the attachment store alone reveals no content. Whoever holds both the host and the
keyring can still decrypt; it is not end-to-end encryption.

**1. Create the keyring on the server that will use it** (each server its own; the key never leaves the host):

```bash
sudo install -d -m 0700 -o 1000 -g 1000 /etc/agentdrop
sudo docker run --rm --entrypoint node "$IMAGE" packages/domain/dist/content/keygen.js \
  | sudo install -m 0400 -o 1000 -g 1000 /dev/stdin /etc/agentdrop/content-keys.json
sudo python3 -c 'import json;d=json.load(open("/etc/agentdrop/content-keys.json"));print(d["active"], d["hmac"]["active"])'
```

The file must belong to uid 1000 (the container user) with mode 0400, or the server refuses to start. Keep it out
of the app directory, its `releases/` and `backups/`, and every `.env` file (deploy scripts copy those next to
database dumps). A whole-disk snapshot takes key and data together: exclude `/etc/agentdrop` or treat such
snapshots as holding the key.

**2. Back it up offline before anything else**: copy the file into a password manager or offline medium and note
the key ids printed above. Losing it makes all content, including every backup, unreadable for good.

**3. Mount it.** Add `-f compose.keys.yaml` to the compose command (`deploy/pull-deploy.sh` adds it by itself when
`/etc/agentdrop/content-keys.json` exists; the path can be changed with `CONTENT_KEYS_HOST_FILE`). If the file is
missing, Docker creates an empty directory in its place; create the file first. With the keyring mounted and
`CONTENT_ENCRYPTION` unset the server behaves as before but can read encrypted content.

**Hosts that allow bind mounts under one shared directory only** (some managed container platforms, often without
`docker cp` or `--ulimit`): keep the keyring in its own directory on that volume, outside the app directory and its
backups, mount it read-only at `/run/secrets/content-keys.json`, and disable core dumps in the entrypoint instead of
`--ulimit`. Because key and data then share the volume, encryption protects dumps and backups that leave it, not
someone who can read the volume.

**4. Switch it on**: `CONTENT_ENCRYPTION=on` where the other settings live (`.env.production`, or the shell /
`.env.trial` for `compose.local.yaml`), and restart API and worker. New content is encrypted; the worker
encrypts older content in small batches (`content backfill` log lines). Admin → Overview shows the key id and how
many older items remain. Switching back off only stops encrypting new content; encrypted content stays readable.

**Startup refuses** (fails closed) when the database holds encrypted content and no keyring is mounted, when the
keyring holds none of the database's keys, or when a key does not match its stored key check.

**Rotation (yearly):** add a new key with `keygen.js` output merged into the file (`keys` gains an entry, `active`
names it), restart API and worker. New content uses it, and the worker re-wraps every existing data key with it in
the background (`content backfill` lines with `step: rewrap`; content itself is not rewritten). When the backfill
reports done, the old key can leave the online file; keep its offline copy until every backup made with it has been
deleted.

**If the keyring leaks**, rewrapping is not enough (old backups hold data keys wrapped with the old key): encrypt the
content again under new data keys, destroy or register as exposed every backup made with the leaked key, and handle
it as an incident.

**Restore drill** (after every rotation, and before deleting plaintext backups): restore the newest backup into a
scratch database, start a server on it with the offline keyring copy, read a few drops and download an attachment.

**After the backfill** (plan §13.2; deleting backups is irreversible, do it only after the drill): `VACUUM FULL` the
`drops`, `approvals`, `outbox_events`, `audit_events` and `send_requests` tables, `CHECKPOINT`, then delete the
backups taken before encryption (including the pre-deploy dumps that `deploy/pull-deploy.sh` keeps under
`releases/<digest>/`, and any backups another deploy script made), old bucket object versions and any filesystem
trash.

## CLI update reminders

Once an hour the worker looks at the CLI version each agent's MCP bridge reported in the last 14 days. People with an
agent older than the CLI this build ships (read from `apps/cli/package.json` in the image) get a direct message from
the built-in `@agentdrop` assistant listing those agents and the upgrade command; it reaches the inbox, end-of-turn
notices, browser push and Feishu. Paced by `UPDATE_REMINDER_DAYS` (default `1,3,7`: at once, then after 1 day, 3 days, then every 7 days, starting over for
a new release) while still behind, none once
current, none for devices whose update checks are off. `CLI_LATEST_VERSION` overrides the recommended version (for a
server-only release that should keep recommending an older CLI, set it explicitly); `UPDATE_REMINDER_DAYS=0` turns the
reminders off. Both are worker settings.

## Upgrades / rollback

Migrations are expand → migrate → contract; the `migrate` service runs once before the new API starts. Roll back by
redeploying the previous image; do not run destructive down-migrations.

On a compose host, `deploy/pull-deploy.sh sha256:<digest>` deploys a CI-built image by digest (`--rollback` returns
to the previous one). It looks after the disk, since every image is about 1.3 GB:

- it refuses to start with less than `AGENTDROP_MIN_FREE_GB` free (default 3) on the deploy directory or Docker's
  data directory, before pulling or dumping anything;
- after the new version is ready, it keeps `AGENTDROP_KEEP` images of the server (default 3: the running one, the
  previous one for `--rollback`, and the newest other) and as many `releases/<digest>` folders with their
  pre-deploy database dumps. Other images, images a container still uses and hand-named folders are left alone; a
  deploy that fails removes nothing;
- dumps and copies of the env file are created readable by the deploying user only;
- `deploy/pull-deploy.sh --prune` runs only the cleanup.

By default it deploys the production stack (`compose.yaml` + `compose.production.yaml`, env file `.env.production`)
in the checkout the script lives in. A host laid out differently says so in an untracked `deploy/site.env` (or the
file named by `AGENTDROP_DEPLOY_SETTINGS`), which the script reads first; variables set in the environment win:

```bash
AGENTDROP_ENV_FILE=.env.local                 # the env file to use and back up before each deploy
AGENTDROP_COMPOSE_FILES="compose.local.yaml"  # space-separated compose files
AGENTDROP_GHCR_USER=<github user>             # required with a GHCR token file (AGENTDROP_GHCR_TOKEN_FILE)
```

Compose itself refuses to start without `AUTH_SECRET` and, for the production file, without `AGENTDROP_IMAGE`; the
script sets `AGENTDROP_IMAGE` to the digest it deploys.

## Metrics and alerts

Not implemented in this iteration: `/health/live` and `/health/ready` exist; request logs are structured (pino)
without content. Before scaling beyond a trial, add counters for: API request count, P50/P95 latency and 4xx/5xx
(never labelled with content); database pool waits, slow queries and lock waits; the oldest outbox event and the
dead-letter count; active bridges and their last heartbeat; staging size, orphaned objects and quotas; and the last
successful backup and last restore drill. Start alerts on repeated readiness failures, sustained 5xx, an overdue
backup, dead letters and low disk, and tune the thresholds to the real load.
