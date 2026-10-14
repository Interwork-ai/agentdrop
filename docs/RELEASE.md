# Releasing the CLI

The CLI ships two ways, from the same build:

1. **npm**: package `agentdrop-cli` (the name `agentdrop` is taken on npm), command `agentdrop`.
2. **Server-hosted fallback**: default API images may contain the same tarball at `/install/agentdrop.tgz`.
   `/install.sh` follows the npm `latest` tag by default and remains available in server-only images.

## One-time setup (repository owner)

1. Create an npm account (https://www.npmjs.com/signup), verify the email, enable 2FA.
2. First publish from a logged-in machine (a package must exist before automation can be attached):
   `npm login`, then `pnpm --filter @agentdrop/cli pack:standalone && cd apps/cli/pack/out && npm publish --access public`.
3. Pick one automation route:
   - **A (recommended) Trusted publishing:** npmjs.com → package `agentdrop-cli` → Settings → Trusted Publisher →
     GitHub Actions, the repository that runs the release (`<owner>/<repo>`), workflow `release.yml`. Then
     `gh variable set NPM_TRUSTED_PUBLISHING --body true`. No secret to rotate.
   - **B Token:** Access Tokens → Generate New Token → Granular, packages `agentdrop-cli`, read & write, bypass 2FA;
     `gh secret set NPM_TOKEN`.
   Without either, the workflow still builds and attaches the tarball to a GitHub Release; only npm is skipped.

## When to release

Not after every change. Commits go to `main` as they are done, each with its CHANGELOG line under **Unreleased**,
and a push runs only the CI jobs it needs. A release (and with it the full check and the server image build) is
cut when:

- something users run is broken or unsafe and the fix is on `main` (release it the same day);
- a coherent batch of user-visible changes is finished and checked, typically no more than one a day;
- a server-side change must reach the deployments (`--scope server`) or a client change must reach users
  (`--scope cli`); choose the narrower scope when only one side changed, so nothing is built twice.

Prose, tests, CI and internal refactors are never released on their own; they ride along with the next release.

## Every release

Choose the scope explicitly when releasing the client or service separately:

```bash
pnpm release 0.4.1 --scope cli       # CLI only; v0.4.1 triggers npm + GitHub Release
pnpm release 0.4.1 --scope server    # service only; server-v0.4.1, no npm publishing
pnpm release 0.4.1                  # legacy combined release (default scope: all)
```

Only stable X.Y.Z versions are accepted. The script rejects dirty working trees, detached HEAD, existing tags,
and non-increasing versions before modifying files. It verifies the selected scope, stages only version files,
then commits. The default branch takes no direct pushes (a repository ruleset: pull requests only, no force-push,
no deletion), so the script pushes the commit to `release/<tag>`, opens a pull request with `gh`, squash-merges it,
checks that the merged commit has exactly the verified tree, and only then tags it and pushes the tag. If anything
else reached the branch with the merge, it stops without tagging. `gh` must be signed in with push rights. Never
force-push a failed release.

Use `--prepare` to make reviewable version edits without committing, tagging or pushing. After reviewing those
edits, run the applicable verification, commit, and push the branch and annotated tag together. CI client verification
runs on Node 22 for a push and on Node 22/24 for a release; the npm release workflow uses the pinned Node version and needs no PostgreSQL. It verifies the
actual bundled dependency graph, installs the tarball and tests a real MCP stdio handshake before publishing.

Before deploying, the release tag's `server-artifacts` run must be green: it runs every CI job on the tagged commit,
including `e2e`, the only check that clicks through the dashboard in a real browser (also on a plain-http origin),
and only then builds the image and the runtime tarball. A CLI-only release builds no server image. Run it
locally with `E2E_DATABASE_URL=postgresql://localhost:5432/agentdrop_e2e pnpm e2e` after `pnpm build` (the database
is reset; never point it at real data). After deploying, run `pnpm smoke:live <target> --expect-version X.Y.Z` for
every live server (fixed QA accounts, see [QUALITY.md](QUALITY.md) §5) and record the result in the deployment
log; a deploy is not done until all are green. The full policy is [QUALITY.md](QUALITY.md).

Service deploys remain a separate operation; a server-only tag does not automatically deploy anything. Operators
record each deploy, and any hand edit of a host's configuration, in their own deployment log outside the repository
([PUBLIC_REPOSITORY.md](PUBLIC_REPOSITORY.md)); deployments are never recorded in the repository or in commit messages. The Docker
build uses `build:server` and optionally `build:cli` (`INCLUDE_CLI=false` skips the bundled tarball). Users can always
install the published CLI from npm or through `/install.sh`. What belongs to the client and what to the server is
described in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-client-and-server-boundary).

The project publishes with trusted publishing (route A) and the repository variable `NPM_TRUSTED_PUBLISHING=true`.
If the npm step of a release fails, the tag and GitHub Release stay as they are; fix the cause and release the next
patch version rather than moving the tag.

## Versioning and compatibility

Versions are [SemVer](https://semver.org/) over what users and agents depend on, not over internal code. While the
major version is 0, a **minor** bump carries what would otherwise be major. The public surface is:

| Surface | Breaking (major; minor while 0.x) | Minor | Patch |
|---|---|---|---|
| CLI commands and flags, hook output shapes | a command/flag removed or renamed, output a script parses changes shape | new command, flag or optional output field | fixes, wording |
| MCP tools (`packages/contracts/src/tools.ts`) | a tool or input field removed, a result field removed or retyped | new optional input or result field | description wording |
| `/v1` HTTP API and error codes | route, field or code removed or retyped | new route, optional field or code | fixes |
| Database schema | a destructive migration (only ever after a deprecation release) | expand migrations | none |
| Dashboard, notice wording, docs | — | new pages or settings | wording, layout |

Compatibility rules are recorded in [ADR 0004](adr/0004-compatibility-and-migrations.md): a server serves the
previous minor CLI, a CLI works against the previous minor server, migrations are expand-only per release, and a
removal is deprecated (changelog `Deprecated`) one minor release before it happens.

Every user-visible change adds a line to `CHANGELOG.md` under **Unreleased** in the same commit. `pnpm release`
moves those notes under the new version with today's date and refuses to release while the section is empty.
Only the latest minor release receives fixes.
