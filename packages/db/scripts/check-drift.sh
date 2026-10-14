#!/usr/bin/env bash
# Fails when the Drizzle schema has changes that are not captured by a committed migration.
set -euo pipefail
cd "$(dirname "$0")/.."
before=$(git status --porcelain -- drizzle | wc -l | tr -d ' ')
if out=$(pnpm exec drizzle-kit generate --name ci_drift_check 2>&1); then
  :
else
  generator_status=$?
  echo "$out" >&2
  echo "[db:check] schema generation failed; migration consistency was not checked." >&2
  exit "$generator_status"
fi
after=$(git status --porcelain -- drizzle | wc -l | tr -d ' ')
if [ "$after" != "$before" ]; then
  echo "$out"
  echo "[db:check] schema drift: uncommitted migration generated. Run 'pnpm db:generate' with a proper name and commit it." >&2
  git status --porcelain -- drizzle >&2
  exit 1
fi
echo "[db:check] migrations are in sync with the schema"
