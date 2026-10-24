# agentdrop CLI

```bash
agentdrop login --server https://drop.example.com            # record the server, create the device identity
agentdrop endpoint add --harness codex --profile codex --label "MacBook Codex"
agentdrop endpoint add --harness claude-code --profile cc --label "MacBook Claude Code"
agentdrop endpoint add --harness cursor --profile cursor --label "MacBook Cursor"
agentdrop connect cursor --profile cursor                     # edits ~/.cursor/mcp.json; no Stop hook
agentdrop connect codex --profile codex                       # codex mcp add … (or edits ~/.codex/config.toml)
agentdrop connect claude-code --profile cc                    # claude mcp add … (or edits ~/.claude.json)
agentdrop skill install                                       # complete skill directory into ~/.codex, ~/.claude, ~/.config/opencode, ~/.cursor, ~/.omp/agent
agentdrop doctor --mcp                                        # config, credentials, reachability, real handshake
agentdrop endpoint list --check
agentdrop device rebind --yes                                 # after cloning a machine image
```

Daily use without an agent (every command takes `--profile <name>` and `--json`):

```bash
agentdrop inbox --profile codex                               # list drops (--view sent|starred|archived, --unread)
agentdrop read 3f2a91c0 --profile codex                       # read one drop by id or id prefix (marks it read in a terminal; --keep-unread)
agentdrop send @wang -m "the ablation run finished" --file results.csv --profile codex
git log -1 | agentdrop send '#lab' --profile ci                # text from a pipe; me sends to my space
agentdrop pending --profile codex                             # requests, invitations, unread, approvals
agentdrop space put figures.zip notes.md --note "for the workstation" --profile codex
agentdrop space list --profile codex                          # my space, newest first: id prefix, files, sizes, agent
agentdrop space get --latest --to ~/incoming --profile gpu    # download every file of an item; --force to replace
agentdrop space rm 3f2a91c0 --profile codex                   # delete an item and free its space
```

`read` printed to an interactive terminal marks an unread drop read for all your agents and says so; piped output,
`--json`, `--keep-unread` and agents running the CLI through a shell tool leave it unread (`--mark-read` forces it).
`send` resolves the recipient like `directory_lookup` (exact `@handle` or `#slug`; a plain name only when exactly one
entry is called that), takes the text from `-m`/`--body` or a pipe, derives the title from the first line (80
characters) or the first file name, uploads files under the same allowlist as `upload_file`, and retries a dropped
connection with the same request id. `--json` prints the raw send result.

`agentdrop setup` run in a project folder offers, after pairing, to allow that folder for uploads (default yes; only
at an interactive terminal; `--allow-current-dir` / `--no-allow-current-dir` decide without asking). Home, root,
system, hidden and key folders are never offered.

My space keeps files and notes for yourself: anything put in from one agent can be listed and downloaded from every
other agent of yours, arrives read and is announced nowhere. `space put` reads only from the profile's allowed
folders (`agentdrop allow-dir add`) and never uploads key or credential files; `space get` saves into the downloads
folder below unless `--to` is given, verifies each file's sha256, never runs or unpacks anything, and refuses to
overwrite an existing file unless `--force`.

`agentdrop mcp --profile <name>` is the stdio bridge started by the client. It reads one profile, loads the
credential from the OS keychain (macOS) or a 0600 file, and exposes the `core` (5) or `standard` (14) toolset.
stdout carries MCP frames only; diagnostics go to stderr and `~/.local/state/agentdrop/logs/bridge-<profile>.log`.

Paths (XDG, overridable with `AGENTDROP_CONFIG_DIR`, `AGENTDROP_DATA_DIR`, `AGENTDROP_STATE_DIR`):

```
~/.config/agentdrop/device.json
~/.config/agentdrop/profiles/<profile>.json      # server_url, h_id, names, credential reference (never the secret)
~/.config/agentdrop/credentials/<account>.token  # only when no keychain is available (mode 0600)
~/.local/share/agentdrop/downloads/<drop_id>/
~/.local/state/agentdrop/logs/
```

Equivalent manual client configuration:

```toml
# ~/.codex/config.toml
[mcp_servers.agentdrop]
command = "/absolute/path/to/agentdrop"
args = ["mcp", "--profile", "codex"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

```bash
claude mcp add --transport stdio --scope user agentdrop -- /absolute/path/to/agentdrop mcp --profile cc
```

Cursor can also be paired and configured in one command:

`agentdrop setup --server https://drop.example.com --harness cursor`

Automatic setup detects `cursor`, `cursor-agent` or `~/.cursor`. The user configuration is shared by Cursor IDE and
CLI ([Cursor MCP](https://cursor.com/docs/cli/mcp)):

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agentdrop": {
      "command": "/absolute/path/to/agentdrop",
      "args": ["mcp", "--profile", "cursor"]
    }
  }
}
```

The bridge, messaging rules, preferences and updater are shared by all clients. Cursor and opencode have distinct
pairing keys and default public routes `@user/cursor` and `@user/opencode`. opencode MCP registration remains manual;
`connect` / `setup` automate Codex, Claude Code and Cursor only. Local configuration does not transfer to cloud or
SSH hosts. Real Cursor headless operation has not been tested.

oh-my-pi (`omp`) pairs as its own key with the default route `@user/omp`. `connect omp` writes `mcpServers.agentdrop`
into `~/.omp/agent/mcp.json` and one managed extension, `~/.omp/agent/extensions/agentdrop.js`, which runs the same
`pending --in-hook` commands at session start, prompt and turn end (`PI_CODING_AGENT_DIR` relocates both).

WorkBuddy (`workbuddy`, macOS) pairs as its own key with the default route `@user/workbuddy`. `connect workbuddy`
writes `mcpServers.agentdrop` into `~/.workbuddy/mcp.json` (`~/.workbuddy-ai` for the international edition,
`WORKBUDDY_CONFIG_DIR` overrides), the skill into its `skills/`, and Claude Code's three hooks into its
`settings.json`. WorkBuddy asks once whether to trust the new server; allow it.

## Quiet Stop hooks and updates (0.4.3+)

```bash
agentdrop settings                                      # show this computer's preferences
agentdrop settings --notify-interval 2h --notice-detail counts
agentdrop settings --notify-interval 30m --notice-detail names
agentdrop settings --notifications off                   # silence hook notices, not manual commands
agentdrop settings --updates notify --update-check-interval 2h
agentdrop settings --updates auto                        # explicitly opt into automatic installation
agentdrop settings --updates off                         # no background version checks
agentdrop update --check                                 # check now, never install
agentdrop update                                         # explicitly install a newer stable version
```

Defaults: notices enabled, **at most one every 30 minutes per server/Agent**, unread titles plus other pending counts; stable CLI version
checks once every two days, notify only. `0` for `--notify-interval` restores per-trigger notices; update checks require
at least `1m`. Accepted units are `m`, `h`, `d`, up to `30d`. Settings are local in `~/.config/agentdrop/settings.json`
(or `AGENTDROP_CONFIG_DIR`), apply to both supported Stop adapters, and do not change the mailbox read state.
`names` adds a short list of request/invitation names; no message body or attachment content is shown.

A Stop event is a trigger, not a timer: nothing runs while your harness is idle. After a notice, high-frequency
Stop events are quiet and avoid mailbox network requests until the interval expires. A successful empty check consumes the full notice interval; failed checks quietly retry after five minutes. Manual `pending` and
`inbox` remain immediate. Aliases pointing to the same server/H share notification state across processes.

Registry checks and optional installation run in a short-lived background process, with shared update state and
locking. Automatic installation is supported only for a verified npm global installation and uses that exact
prefix, a validated stable version from the official npm registry, and no sudo or package lifecycle scripts.
Source checkouts, npx, other package managers and unrecognized layouts require a manual CLI upgrade through their
original installation method. Existing MCP processes keep running their loaded version; new processes use the
update. Network/install failures do not produce hook stderr. Updates and mailbox notices share the notice interval.

After upgrading an older installation, re-run `agentdrop connect codex --profile <name>` or
`agentdrop connect claude-code --profile <name>` once to remove the old per-trigger "checking" status label.
All four harnesses receive the same notice text, byte for byte; only the wrapper differs, because the audience
does. Codex and Claude Code print it as a `systemMessage` warning and opencode as a TUI toast — human-only
channels a model never reads, so nothing is said to the model there. Cursor’s documented
[Stop output](https://cursor.com/docs/hooks#stop) has no human-only field: `followup_message` is submitted as the
next user message, so there and only there the notice is fenced as untrusted data and followed by an instruction
to report it in one line. Use `agentdrop pending --profile cursor` for an immediate check.

## Dashboard preferences and complete skill updates

In Dashboard → Settings → Client preferences, choose a device and save notice/update modes and intervals.
The default notice interval is 30 minutes and the stable-version check runs daily; automatic CLI installation remains opt-in.
A paired CLI 0.4.3+ reads only its credential-bound device's policy. Active Stop hooks, MCP heartbeats and profile-based
CLI commands check for changes at most once per minute; failures back off. Saved settings and the client's applied
report are displayed separately, including CLI/skill versions. No running client means no immediate application.

Once the dashboard saves a policy, that device uses it. Local `agentdrop settings` stays a fallback for unconfigured
devices and older servers. Remote preferences are cached per server/H and never rewrite unrelated local settings.

Skills are a **directory**, not only SKILL.md. The bundled entrypoint is shared by Codex, Claude Code, opencode and Cursor;
references load only when needed. Auto-upgrade verifies the newly installed CLI version, invokes that new executable
to synchronize the complete skill directory, and reports success only after synchronization. If CLI installation
succeeds but skill synchronization fails, the result is `skills_failed` and the next run can repair skills without
installing the CLI again. Manual npm upgrades are repaired on the next ordinary CLI command (including MCP startup).
Existing sessions may keep already-loaded instructions until their harness reloads them.

Automatic skill sync discovers installed harness config roots and remembered skill targets; it does not create
roots for absent harnesses. Explicit `agentdrop skill install` installs all four targets (or `--only` selects a subset).
CODEX_HOME, CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME are respected. Each installed directory has a version and full-tree
hash manifest. Old copies are backed up privately before replacement; failed replacement rolls back. Symbolic links
are not followed. `skill remove` records an opt-out; explicit `skill install` re-enables synchronization.

Cursor installs the full directory under `~/.cursor/skills/agentdrop` ([Cursor skills](https://cursor.com/docs/skills)).
