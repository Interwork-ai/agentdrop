#!/usr/bin/env bash
# Deploy a compose host from a CI-built image instead of building on the host.
#
#   deploy/pull-deploy.sh sha256:<digest>      # exact build, what you normally want
#   deploy/pull-deploy.sh edge                 # newest main build
#   deploy/pull-deploy.sh --rollback           # back to the previously deployed digest
#   deploy/pull-deploy.sh --prune              # only the cleanup below, no deploy
#
# Always deploys by digest, never by a moving tag: a tag can be repointed between the pull and the restart, and
# then "what is running" stops being answerable. A tag argument is resolved to a digest once, up front.
#
# Disk: each image is ~1.3 GB and every deploy leaves one behind, and a full disk can stop PostgreSQL in the middle of
# a deploy. A deploy refuses to start with less than AGENTDROP_MIN_FREE_GB free (default 3). After a deploy that
# became ready, it keeps AGENTDROP_KEEP images of this server (default 3: the one running, the previous one that
# --rollback returns to, and the newest other) and as many digest-named release folders with their database dumps.
# Only this image's repository is touched, an image a container still uses is skipped, hand-named folders under
# releases/ stay, and a failed deploy removes nothing.
#
# Layout: by default the directory this script's checkout lives in (AGENTDROP_BASE), with the production stack
# from docs/DEPLOY.md: compose.yaml + compose.production.yaml and the env file .env.production. A host with another
# layout keeps it in an untracked settings file, sourced first when it exists:
#   ${AGENTDROP_DEPLOY_SETTINGS:-$AGENTDROP_BASE/deploy/site.env}
# e.g.  AGENTDROP_ENV_FILE=.env.local
#       AGENTDROP_COMPOSE_FILES="compose.local.yaml"
#       AGENTDROP_GHCR_USER=<github user owning the token>
# Variables already set in the environment take precedence over the settings file.
#
# Pulling a private image needs GHCR read access: put a read:packages token in AGENTDROP_GHCR_TOKEN_FILE
# (default ~/.agentdrop-ghcr-token, mode 600) together with AGENTDROP_GHCR_USER, or run `docker login ghcr.io` once
# beforehand. A public image needs neither.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${AGENTDROP_BASE:-$(dirname "$script_dir")}"
SETTINGS="${AGENTDROP_DEPLOY_SETTINGS:-$BASE/deploy/site.env}"
if [ -f "$SETTINGS" ]; then
  # the environment wins over the file: remember what was set before sourcing it
  _saved="$(for v in $(compgen -e | grep -E '^(AGENTDROP_[A-Z0-9_]+|CONTENT_KEYS_HOST_FILE)$'); do
    printf '%s=%q\n' "$v" "${!v}"
  done)"
  # shellcheck disable=SC1090
  . "$SETTINGS"
  eval "$_saved"
  unset _saved
  BASE="${AGENTDROP_BASE:-$BASE}"
fi
IMAGE="${AGENTDROP_IMAGE:-ghcr.io/interwork-ai/agentdrop/server}"
TOKEN_FILE="${AGENTDROP_GHCR_TOKEN_FILE:-$HOME/.agentdrop-ghcr-token}"
STATE="$BASE/releases/deployed.json"
PENDING="$BASE/releases/pending.json"
KEEP="${AGENTDROP_KEEP:-3}"
MIN_FREE_GB="${AGENTDROP_MIN_FREE_GB:-3}"
READY_TRIES="${AGENTDROP_READY_TRIES:-30}"
ENV_FILE="${AGENTDROP_ENV_FILE:-.env.production}"
read -r -a compose_files <<< "${AGENTDROP_COMPOSE_FILES:-compose.yaml compose.production.yaml}"
COMPOSE=()
for file in "${compose_files[@]}"; do COMPOSE+=(-f "$file"); done

# database dumps, env copies and release files are readable by the deploying user only
umask 077

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }

# a rollback needs the running image and the previous one, whatever AGENTDROP_KEEP says
[ "$KEEP" -ge 2 ] 2>/dev/null || KEEP=2

state_field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "${2:-$STATE}" 2>/dev/null || true; }
free_gb() { sudo df -Pk "$1" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1048576 }'; }

# A pull needs ~1.3 GB, the dump and the migration more: refuse before anything changes.
check_space() {
  local dir free
  for dir in "$BASE" "$(sudo docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"; do
    [ -n "$dir" ] || continue
    free="$(free_gb "$dir")"
    [ -n "$free" ] || continue
    [ "$free" -ge "$MIN_FREE_GB" ] ||
      die "only ${free} GB free on $dir (need ${MIN_FREE_GB}); nothing was changed. Free space first, e.g. $0 --prune"
  done
}

# Keep KEEP images of $IMAGE and KEEP digest-named release folders: the deployed one, the previous one, then the
# newest others.
prune() {
  local current previous cur_id prev_id keep count id name removed=0 skipped=0 folders=0
  current="$(state_field digest)"
  previous="$(state_field previous_digest)"
  cur_id=""
  prev_id=""
  [ -n "$current" ] && cur_id="$(sudo docker image inspect "$IMAGE@$current" --format '{{.Id}}' 2>/dev/null || true)"
  [ -n "$previous" ] && prev_id="$(sudo docker image inspect "$IMAGE@$previous" --format '{{.Id}}' 2>/dev/null || true)"

  keep=" "
  count=0
  for id in $cur_id $prev_id; do
    case "$keep" in *" $id "*) ;; *) keep="$keep$id " && count=$((count + 1)) ;; esac
  done
  # `docker images` lists the newest first
  for id in $(sudo docker images --no-trunc --format '{{.ID}}' "$IMAGE" | awk '!seen[$0]++'); do
    case "$keep" in *" $id "*) continue ;; esac
    if [ "$count" -lt "$KEEP" ]; then
      keep="$keep$id "
      count=$((count + 1))
    elif [ -n "$(sudo docker ps -a -q --filter "ancestor=$id")" ]; then
      skipped=$((skipped + 1))
    elif sudo docker rmi -f "$id" >/dev/null 2>&1; then
      removed=$((removed + 1))
    else
      skipped=$((skipped + 1))
    fi
  done

  keep=" "
  count=0
  for name in "$(echo "$current" | cut -c8-19)" "$(echo "$previous" | cut -c8-19)"; do
    [ -n "$name" ] || continue
    case "$keep" in *" $name "*) ;; *) keep="$keep$name " && count=$((count + 1)) ;; esac
  done
  # only folders this script creates (the first 12 hex digits of a digest), newest first
  for name in $(cd "$BASE/releases" 2>/dev/null && ls -1t | grep -E '^[0-9a-f]{12}$' || true); do
    [ -d "$BASE/releases/$name" ] || continue
    case "$keep" in *" $name "*) continue ;; esac
    if [ "$count" -lt "$KEEP" ]; then
      keep="$keep$name "
      count=$((count + 1))
    else
      rm -rf "${BASE:?}/releases/$name"
      folders=$((folders + 1))
    fi
  done

  local note=""
  [ "$skipped" -gt 0 ] && note="; $skipped image(s) still in use left alone"
  log "cleanup: removed $removed image(s) and $folders release folder(s), keeping $KEEP of each$note; $(free_gb "$BASE") GB free"
}

[ -d "$BASE" ] || die "$BASE not found; set AGENTDROP_BASE"
cd "$BASE"

target="${1:-edge}"
if [ "$target" = "--prune" ]; then
  prune
  exit 0
fi

[ -f "$ENV_FILE" ] || die "env file $ENV_FILE not found in $BASE; set AGENTDROP_ENV_FILE"
for file in "${compose_files[@]}"; do
  [ -f "$file" ] || die "compose file $file not found in $BASE; set AGENTDROP_COMPOSE_FILES"
done
check_space

# content encryption keyring (docs/plan/CONTENT_ENCRYPTION.md §14): mounted when the host has one
# (sudo: the key directory is private to the container user, not readable by whoever runs this script)
if sudo test -f "${CONTENT_KEYS_HOST_FILE:-/etc/agentdrop/content-keys.json}"; then
  [ -f compose.keys.yaml ] || die "$BASE/compose.keys.yaml not found but a content keyring exists"
  COMPOSE+=(-f compose.keys.yaml)
fi

if [ "$target" = "--rollback" ]; then
  [ -f "$STATE" ] || die "no previous deployment recorded in $STATE"
  # A failed or interrupted attempt leaves STATE at the last healthy deployment. Recover that
  # deployment, rather than skipping it and selecting the version before it.
  if [ -f "$PENDING" ]; then
    target="$(state_field recovery_digest "$PENDING")"
  else
    target="$(state_field previous_digest)"
  fi
  [ -n "$target" ] || die "no previous digest recorded; roll back by passing a digest explicitly"
  log "rolling back to $target"
fi

if [ -f "$TOKEN_FILE" ]; then
  [ -n "${AGENTDROP_GHCR_USER:-}" ] ||
    die "$TOKEN_FILE exists but AGENTDROP_GHCR_USER is not set: set it to the GitHub user that owns the token"
  log "authenticating to ghcr.io"
  tr -d '\r\n' < "$TOKEN_FILE" | sudo docker login ghcr.io -u "$AGENTDROP_GHCR_USER" --password-stdin >/dev/null
fi

case "$target" in
  sha256:*) digest="$target" ;;
  *)
    log "resolving tag '$target' to a digest"
    sudo docker pull -q "$IMAGE:$target" >/dev/null
    digest="$(sudo docker image inspect "$IMAGE:$target" --format '{{index .RepoDigests 0}}' | sed 's/.*@//')"
    [ -n "$digest" ] || die "could not resolve $IMAGE:$target to a digest"
    ;;
esac

ref="$IMAGE@$digest"
log "target $ref"
sudo docker pull -q "$ref" >/dev/null

current="$(sudo docker inspect agentdrop-api-1 --format '{{.Image}}' 2>/dev/null || true)"

# A pre-deploy dump is the only thing that makes a bad migration survivable; migrations are expand-only, so the
# previous image keeps working against the new schema and a rollback does not need a down-migration.
rel="$BASE/releases/$(echo "$digest" | cut -c8-19)"
mkdir -p "$rel"
log "backing up the database to $rel/database-before.sql"
sudo docker exec agentdrop-postgres-1 pg_dump -U agentdrop agentdrop > "$rel/database-before.sql"
cp "$ENV_FILE" "$rel/$(basename "$ENV_FILE" | sed 's/^\.//').before" 2>/dev/null || true
printf 'services:\n  api:\n    image: %s\n  worker:\n    image: %s\n  migrate:\n    image: %s\n' "$ref" "$ref" "$ref" \
  > "$rel/compose.release.yaml"

case "$ENV_FILE" in /*) env_path="$ENV_FILE" ;; *) env_path="./$ENV_FILE" ;; esac
set -a; . "$env_path"; set +a
# the compose files name the image through AGENTDROP_IMAGE; the release file below pins the same digest
export AGENTDROP_IMAGE="$ref"

# Persist the recovery target before migrations or container changes, including process interruption.
printf '{"recovery_digest":"%s"}\n' "$(state_field digest)" > "$PENDING.tmp"
mv "$PENDING.tmp" "$PENDING"

log "migrating (one-shot, before the new api starts)"
sudo -E docker compose "${COMPOSE[@]}" -f "$rel/compose.release.yaml" -p agentdrop run --rm migrate

log "starting api and worker"
sudo -E docker compose "${COMPOSE[@]}" -f "$rel/compose.release.yaml" -p agentdrop up -d api worker

log "waiting for API container readiness"
for _ in $(seq 1 "$READY_TRIES"); do
  # The host port may serve a proxy redirect (HTTP 301), which curl -f considers success. Check the API itself.
  if sudo docker exec agentdrop-api-1 node -e '
    fetch("http://127.0.0.1:" + (process.env.PORT || "3000") + "/health/ready", {
      signal: AbortSignal.timeout(5000), redirect: "error"
    }).then(async response => {
      if (!response.ok || (await response.json()).status !== "ready") process.exit(1);
    }).catch(() => process.exit(1));
  ' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 2
done
if [ "${ready:-0}" != 1 ]; then
  sudo docker compose -p agentdrop logs api --tail 40 || true
  die "not ready after $((READY_TRIES * 2))s — roll back with: $0 --rollback"
fi

previous="$(state_field digest)"
[ "$previous" != "$digest" ] || previous="$(state_field previous_digest)"
printf '{"digest":"%s","previous_digest":"%s","deployed_at":"%s"}\n' \
  "$digest" "${previous:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE.tmp"
mv "$STATE.tmp" "$STATE"
rm -f "$PENDING"

log "ready: $ref"
sudo docker exec agentdrop-api-1 node -e '
  fetch("http://127.0.0.1:" + (process.env.PORT || "3000") + "/health/ready", {
    signal: AbortSignal.timeout(5000), redirect: "error"
  }).then(async response => {
    if (!response.ok) process.exit(1);
    console.log(await response.text());
  }).catch(() => process.exit(1));
'
[ -n "$current" ] && log "previous image id was $current"
# only now, with the new image ready and recorded: a failed deploy keeps everything for a rollback
prune || log "cleanup did not finish; the deploy itself succeeded"
exit 0
