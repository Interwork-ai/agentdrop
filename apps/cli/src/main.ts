import { harnessKeySchema, type ReplyProgress } from '@agentdrop/contracts';
import { Command, Option } from 'commander';
import { maybeStartTakeWorker, takeClaudeMod } from './claude-mod.js';
import { synchronizeClientSettings } from './client-preferences.js';
import { accountRecoverCommand } from './commands/account.js';
import { allowDirCommand } from './commands/allowdir.js';
import {
  autorunOffCommand,
  autorunOnCommand,
  autorunPollCommand,
  autorunStatusCommand,
} from './commands/autorun.js';
import { ackCommand, bandCommand, markReadCommand, modFailure } from './commands/band.js';
import { connectCommand, disconnectCommand } from './commands/connect.js';
import { contactAddCommand, contactRemoveCommand } from './commands/contact.js';
import { deviceRebindCommand, deviceShowCommand } from './commands/device.js';
import { doctorCommand } from './commands/doctor.js';
import { endpointAddCommand, endpointListCommand, endpointRemoveCommand } from './commands/endpoint.js';
import { exportCommand } from './commands/export.js';
import {
  groupCreateCommand,
  groupInviteCommand,
  groupLeaveCommand,
  groupListCommand,
  groupRequestsCommand,
} from './commands/group.js';
import { loginCommand } from './commands/login.js';
import {
  approvalsCommand,
  approveCommand,
  inboxCommand,
  readCommand,
  requestsCommand,
  respondCommand,
} from './commands/mail.js';
import { mcpCommand } from './commands/mcp.js';
import { pendingCommand } from './commands/pending.js';
import { sendCommand } from './commands/send.js';
import { type SettingsOptions, settingsCommand } from './commands/settings.js';
import { setupCommand } from './commands/setup.js';
import { ensureBundledSkills, skillInstallCommand, skillRemoveCommand } from './commands/skill.js';
import { spaceGetCommand, spaceListCommand, spacePutCommand, spaceRmCommand } from './commands/space.js';
import { statuslineCommand } from './commands/statusline.js';
import { experimentalEnabled } from './experimental.js';
import { harnessChoices, harnessLabels, isConnectableHarness, parseHarnessList } from './harnesses.js';
import { synchronizeInstalledHooks } from './hook-lifecycle.js';
import { readLanguage } from './locale.js';
import { CLI_VERSION, createOutput, type Output, prefix } from './output.js';
import { synchronizeInstalledSkills } from './skill-lifecycle.js';
import { listProfiles } from './store.js';
import { acknowledgeSkillSync, maintainUpdates } from './updates.js';

/** Run by the Claude Code mod on a timer or a button press (apps/cli/claude-mod). */
const MOD_COMMANDS = new Set(['band', 'ack', 'mark-read']);

/**
 * Commands a person types whose `--profile` may be left out when exactly one profile is paired on this computer.
 * Hooks, the MCP entry, the mod and plugins always pass it; `endpoint add` names a new one and `endpoint remove`
 * forgets one, so those keep requiring it.
 */
const DEFAULT_PROFILE_COMMANDS = new Set([
  'allow-dir add',
  'allow-dir remove',
  'allow-dir list',
  'connect',
  'inbox',
  'read',
  'send',
  'requests',
  'accept',
  'decline',
  'account recover',
  'contact add',
  'contact remove',
  'group list',
  'group create',
  'group invite',
  'group requests',
  'group leave',
  'space put',
  'space list',
  'space get',
  'space rm',
  'export',
  'approvals',
  'approve',
  'band',
  'ack',
  'mark-read',
  'pending',
  'autorun on',
  'autorun off',
  'autorun status',
]);

/** `group invite` for the group subcommand, `inbox` for a top-level one. */
function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c?.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/**
 * The profile a command uses when none was given: the only one paired here. With none or several, the person is
 * told which exist, in their language.
 */
export function defaultProfile(profiles: string[] = listProfiles().map((p) => p.profile)): string {
  const zh = readLanguage() === 'zh';
  if (profiles.length === 1) return profiles[0] as string;
  if (profiles.length === 0)
    throw new Error(
      zh
        ? '这台电脑上还没有配对任何 Agent；先运行 agentdrop setup --server <服务器地址>'
        : 'no agent is paired on this computer yet; run agentdrop setup --server <server address> first',
    );
  throw new Error(
    zh
      ? `这台电脑上有 ${profiles.length} 个配置（${profiles.join('、')}）；请加上 --profile <名称> 指定用哪一个`
      : `${profiles.length} profiles are paired on this computer (${profiles.join(', ')}); add --profile <name> to say which one`,
  );
}

export function buildProgram(): Command {
  const program = new Command('agentdrop')
    .description('AgentDrop: cross-network drops between your agents')
    .version(CLI_VERSION)
    .option('--json', 'machine-readable output', false)
    .option('-q, --quiet', 'suppress progress messages', false);

  const out = () => {
    const o = program.opts<{ json: boolean; quiet: boolean }>();
    return createOutput({ json: o.json, quiet: o.quiet });
  };
  /**
   * A command the Claude Code mod runs: with --json a failure also prints its code and the person's language on
   * stdout, so the mod tells the person what happened in its own words, never the error's.
   */
  const forMod = async (profile: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      if (!program.opts<{ json: boolean }>().json) throw err;
      process.stdout.write(`${JSON.stringify(modFailure(err, profile))}\n`);
      throw err;
    }
  };

  program.hook('preAction', async (_root, action) => {
    if (DEFAULT_PROFILE_COMMANDS.has(commandPath(action)) && !action.opts<{ profile?: string }>().profile)
      action.setOptionValue('profile', defaultProfile());
    if (
      action.name() === '_sync-skills' ||
      action.name() === '_take-claude-mod' ||
      action.parent?.name() === 'skill'
    )
      return;
    // The Claude Code mod runs these every 20 s in every session: skills and hooks are repaired by the next
    // ordinary command instead.
    const forMod = MOD_COMMANDS.has(action.name());
    // Never emit startup diagnostics onto the MCP/Stop protocol streams.
    if (!forMod) {
      try {
        const report = synchronizeInstalledSkills();
        if (!report.error && report.skill_version) acknowledgeSkillSync(report.skill_version);
      } catch {
        /* A later invocation can repair the bundled skill. */
      }
    }
    // After an upgrade, the Claude Code mod follows this CLI: the copy is rewritten here (local files only), and a
    // detached worker tells Claude Code to take it, so no hook or poll waits on `claude`. Never from connect,
    // setup or disconnect, which install or remove the mod themselves, nor from `mcp`.
    maybeStartTakeWorker(action.name());
    /*
     * Repair installed hooks the way the skill folder already repairs itself. Skipped while a hook is the thing
     * running: rewriting a harness config from inside that harness's own hook is asking for a torn read, and any
     * ordinary invocation repairs it moments later anyway.
     */
    if (!process.argv.includes('--in-hook') && action.name() !== 'mcp' && !forMod) {
      try {
        synchronizeInstalledHooks();
      } catch {
        /* A later invocation can repair the hooks; never break the command the user actually asked for. */
      }
    }
    const profile = action.opts<{ profile?: string }>().profile;
    // Stop hooks must inspect stop_hook_active before doing network work; they sync in pendingHookResult.
    // The opencode plugin runs `autorun poll` on a timer; it must stay a single cheap request.
    if (profile && action.name() !== 'pending' && action.parent?.name() !== 'autorun')
      await synchronizeClientSettings(profile);
  });

  program
    .command('setup')
    .description('one-shot onboarding: login, pair every installed harness, connect, hook, skill, doctor')
    .requiredOption('--server <url>', 'AgentDrop server, e.g. https://drop.example.com')
    .option(
      '--harness <list>',
      `comma-separated subset: ${harnessChoices(',')} (default: whatever is installed)`,
    )
    .option('--allow-dir <dir>', 'directory upload_file may read from')
    .option('--allow-current-dir', 'let agents upload from the current folder without asking')
    .option('--no-allow-current-dir', 'do not offer the current folder for uploads')
    .option('--no-browser', 'do not open the browser automatically')
    .option('--no-cli', 'edit client config files directly instead of codex/claude mcp add')
    .action(
      async (o: {
        server: string;
        harness?: string;
        allowDir?: string;
        allowCurrentDir?: boolean;
        browser: boolean;
        cli: boolean;
      }) => {
        const harnesses = o.harness === undefined ? undefined : parseHarnessList(o.harness);
        await setupCommand(out(), {
          server: o.server,
          ...(harnesses?.length ? { harnesses } : {}),
          ...(o.allowDir ? { allowDir: o.allowDir } : {}),
          ...(o.allowCurrentDir !== undefined ? { allowCurrentDir: o.allowCurrentDir } : {}),
          noBrowser: !o.browser,
          noCli: !o.cli,
        });
      },
    );

  program
    .command('login')
    .description('record the server for this device and verify it is reachable')
    .requiredOption('--server <url>', 'https://drop.example.com')
    .option('--device-label <label>', 'display name of this logical device')
    .option('--allow-http', 'accept a plain http:// server on a trusted network (trial only)', false)
    .action(async (o: { server: string; deviceLabel?: string; allowHttp: boolean }) =>
      loginCommand(out(), o),
    );

  const endpoint = program.command('endpoint').description('manage paired endpoints (H) of this device');
  endpoint
    .command('add')
    .description('pair a harness profile with the server (approve in the browser)')
    .requiredOption('--harness <key>', `${harnessChoices(' | ')} | other`)
    .requiredOption('--profile <name>', 'local profile name, e.g. codex or cc')
    .option('--label <name>', 'agent name shown in the dashboard')
    .option('--server <url>', 'override the server recorded by login')
    .option('--timeout <seconds>', 'stop waiting after N seconds', (v) => Number.parseInt(v, 10))
    .action(
      async (o: { harness: string; profile: string; label?: string; server?: string; timeout?: number }) => {
        const harness = harnessKeySchema.parse(o.harness);
        await endpointAddCommand(out(), {
          harness,
          profile: o.profile,
          ...(o.label ? { label: o.label } : {}),
          ...(o.server ? { server: o.server } : {}),
          ...(o.timeout ? { timeoutS: o.timeout } : {}),
        });
      },
    );
  endpoint
    .command('list')
    .description('list local profiles')
    .option('--check', 'verify each credential against the server', false)
    .action(async (o: { check: boolean }) => endpointListCommand(out(), o));
  endpoint
    .command('remove')
    .description('forget a local profile and its credential')
    .requiredOption('--profile <name>')
    .action(async (o: { profile: string }) => endpointRemoveCommand(out(), o));

  const device = program.command('device').description('this logical device');
  device
    .command('show')
    .description('show the local device identity')
    .action(async () => deviceShowCommand(out()));
  device
    .command('rebind')
    .description('generate a new installation id and discard local credentials (after cloning a machine)')
    .option('--label <label>')
    .option('--yes', 'confirm', false)
    .action(async (o: { label?: string; yes: boolean }) => deviceRebindCommand(out(), o));

  const allow = program
    .command('allow-dir')
    .description('directories upload_file may read from (per profile)');
  allow
    .command('add')
    .argument('<dir>')
    .requiredOption('--profile <name>')
    .action(async (dir: string, o: { profile: string }) =>
      allowDirCommand(out(), { profile: o.profile, action: 'add', dir }),
    );
  allow
    .command('remove')
    .argument('<dir>')
    .requiredOption('--profile <name>')
    .action(async (dir: string, o: { profile: string }) =>
      allowDirCommand(out(), { profile: o.profile, action: 'remove', dir }),
    );
  allow
    .command('list')
    .requiredOption('--profile <name>')
    .action(async (o: { profile: string }) => allowDirCommand(out(), { profile: o.profile, action: 'list' }));

  program
    .command('mcp')
    .description('run the stdio MCP bridge for one profile (used by Codex / Claude Code, not interactively)')
    .requiredOption('--profile <name>')
    .option('--toolset <name>', 'core | standard (default: profile setting)')
    .action(async (o: { profile: string; toolset?: string }) => {
      if (o.toolset && o.toolset !== 'core' && o.toolset !== 'standard')
        throw new Error('--toolset must be core or standard');
      await mcpCommand({
        profile: o.profile,
        ...(o.toolset ? { toolset: o.toolset as 'core' | 'standard' } : {}),
      });
    });

  program
    .command('connect')
    .description('register the bridge in a client: agentdrop connect codex --profile codex')
    .argument('<harness>', harnessChoices(' | '))
    .requiredOption('--profile <name>', 'paired profile to expose')
    .option('--executable <path>', 'absolute path of the agentdrop binary to write into the config')
    .option('--no-cli', 'edit the config file directly instead of using codex/claude mcp add')
    .option('--no-hook', 'do not install the completion hook/plugin that reports pending requests')
    .action(
      async (harness: string, o: { profile: string; executable?: string; cli: boolean; hook: boolean }) => {
        if (!isConnectableHarness(harness))
          throw new Error(`harness must be ${harnessChoices(', ', ' or ')}`);
        await connectCommand(out(), {
          harness,
          profile: o.profile,
          ...(o.executable ? { executable: o.executable } : {}),
          noCli: !o.cli,
          noHook: !o.hook,
        });
      },
    );
  program
    .command('disconnect')
    .description('remove the bridge entry from a client configuration')
    .argument('<harness>', harnessChoices(' | '))
    .option('--no-cli', 'edit the config file directly')
    .action(async (harness: string, o: { cli: boolean }) => {
      if (!isConnectableHarness(harness)) throw new Error(`harness must be ${harnessChoices(', ', ' or ')}`);
      await disconnectCommand(out(), { harness, noCli: !o.cli });
    });

  program
    .command('inbox')
    .description('list drops of a profile (no MCP needed)')
    .requiredOption('--profile <name>')
    .option('--view <view>', 'inbox | sent | starred | archived', 'inbox')
    .option('--unread', 'unread only', false)
    .option('--limit <n>', 'max rows', (v) => Number.parseInt(v, 10))
    .action(async (o: { profile: string; view: string; unread: boolean; limit?: number }) =>
      inboxCommand(out(), {
        profile: o.profile,
        view: o.view,
        unread: o.unread,
        ...(o.limit ? { limit: o.limit } : {}),
      }),
    );
  program
    .command('read')
    .description(
      'read one drop (id or id prefix); shown in a terminal, an unread drop is then marked read (ADR 0032)',
    )
    .argument('<drop_id>', 'the id, or its first characters (at least 4)')
    .requiredOption('--profile <name>')
    .option('--mark-read', 'mark as read after reading, also when not printed to a terminal', false)
    .option('--keep-unread', 'leave it unread even when read in a terminal', false)
    .action(async (dropId: string, o: { profile: string; markRead: boolean; keepUnread: boolean }) =>
      forMod(o.profile, () =>
        readCommand(out(), { profile: o.profile, dropId, markRead: o.markRead, keepUnread: o.keepUnread }),
      ),
    );
  program
    .command('send')
    .description(
      'send a message from a terminal or a script: to @handle, #group or me (my space); text from --body, -m or a pipe',
    )
    .argument('<to>', '@handle, #group, a contact or group name, or me')
    .option('--title <text>', 'title (default: the first line of the text, or the first file name)')
    .option('-m, --body <text>', 'the text (default: what is piped in)')
    .option('--file <paths...>', 'files to attach, up to 10 (same folders as upload_file: see allow-dir)')
    .option('--reply-to <drop_id>', 'the message this answers (id or id prefix)')
    .addOption(
      new Option(
        '--progress <state>',
        'with --reply-to: where the work that message asked for stands',
      ).choices(['started', 'done', 'declined', 'needs_info']),
    )
    .requiredOption('--profile <name>')
    .action(
      async (
        to: string,
        o: {
          title?: string;
          body?: string;
          file?: string[];
          replyTo?: string;
          progress?: ReplyProgress;
          profile: string;
        },
      ) =>
        sendCommand(out(), {
          profile: o.profile,
          to,
          ...(o.title !== undefined ? { title: o.title } : {}),
          ...(o.body !== undefined ? { body: o.body } : {}),
          ...(o.file ? { files: o.file } : {}),
          ...(o.replyTo ? { replyTo: o.replyTo } : {}),
          ...(o.progress ? { progress: o.progress } : {}),
        }),
    );
  program
    .command('requests')
    .description('pending contact requests and group invitations')
    .requiredOption('--profile <name>')
    .action(async (o: { profile: string }) => requestsCommand(out(), o));
  program
    .command('accept')
    .description('accept a contact request (@handle) or a group invitation (#slug) with this profile')
    .argument('<target>')
    .requiredOption('--profile <name>')
    .action(async (target: string, o: { profile: string }) =>
      respondCommand(out(), { profile: o.profile, target, decision: 'accept' }),
    );
  program
    .command('decline')
    .description('decline a contact request (@handle) or a group invitation (#slug)')
    .argument('<target>')
    .requiredOption('--profile <name>')
    .action(async (target: string, o: { profile: string }) =>
      respondCommand(out(), { profile: o.profile, target, decision: 'decline' }),
    );
  const account = program.command('account').description('your AgentDrop account');
  account
    .command('recover')
    .description('forgot your web password: get a one-time reset link (type it yourself in a terminal)')
    .requiredOption('--profile <name>')
    .action(async (o: { profile: string }) => accountRecoverCommand(out(), { profile: o.profile }));
  const contact = program.command('contact').description('manage contacts from the terminal');
  contact
    .command('add')
    .description(
      'send a contact request to @handle; they accept in their agent, the dashboard or agentdrop accept',
    )
    .argument('<handles...>', '@handle, repeatable or comma separated')
    .requiredOption('--profile <name>')
    .action(async (handles: string[], o: { profile: string }) =>
      contactAddCommand(out(), { profile: o.profile, handles }),
    );
  contact
    .command('remove')
    .description('remove contacts: first run shows who would be removed; add --confirm to remove them')
    .argument('<handles...>', '@handle, repeatable or comma separated')
    .requiredOption('--profile <name>')
    .option('--confirm', 'actually remove them (only after the person has confirmed)', false)
    .action(async (handles: string[], o: { profile: string; confirm: boolean }) =>
      contactRemoveCommand(out(), { profile: o.profile, handles, confirm: o.confirm }),
    );
  const group = program
    .command('group')
    .description('persistent groups: create, invite, see what is waiting, leave');
  group
    .command('list')
    .description('my groups and the invitations waiting for me')
    .requiredOption('--profile <name>')
    .action(async (o: { profile: string }) => groupListCommand(out(), o));
  group
    .command('create')
    .description('create a group and optionally invite people in the same step')
    .argument('[slug]', 'short code, unique across the server (default: your handle)')
    .option(
      '--name <display_name>',
      'group name (default: your nickname and how many you invite, e.g. "Alice +2")',
    )
    .option('--description <text>')
    .option('--invite <handles...>', 'people to invite right away (@handle, repeatable or comma separated)')
    .requiredOption('--profile <name>')
    .action(
      async (
        slug: string | undefined,
        o: { name?: string; description?: string; invite?: string[]; profile: string },
      ) =>
        groupCreateCommand(out(), {
          profile: o.profile,
          ...(slug ? { slug } : {}),
          ...(o.name ? { name: o.name } : {}),
          ...(o.description ? { description: o.description } : {}),
          ...(o.invite ? { invite: o.invite } : {}),
        }),
    );
  group
    .command('invite')
    .description('invite people to a group (#slug or group_id); may need an admin to approve')
    .argument('<group>')
    .argument('<handles...>')
    .requiredOption('--profile <name>')
    .action(async (target: string, handles: string[], o: { profile: string }) =>
      groupInviteCommand(out(), { profile: o.profile, target, handles }),
    );
  group
    .command('requests')
    .description('join requests waiting for me as a group admin (decide them in the dashboard)')
    .requiredOption('--profile <name>')
    .action(async (o: { profile: string }) => groupRequestsCommand(out(), o));
  group
    .command('leave')
    .description('leave a group (#slug or group_id); owners must transfer ownership first')
    .argument('<group>')
    .requiredOption('--profile <name>')
    .action(async (target: string, o: { profile: string }) =>
      groupLeaveCommand(out(), { profile: o.profile, target }),
    );

  const space = program
    .command('space')
    .description('my space: keep files and notes for yourself and pick them up on any of your machines');
  space
    .command('put')
    .description('put files and/or a note into my space (same folders as upload_file: see allow-dir)')
    .argument('[files...]', 'files to put in (up to 10)')
    .option('--note <text>', 'a note kept with the files, or on its own')
    .option('--title <text>', 'title (default: the first file name, or the first line of the note)')
    .requiredOption('--profile <name>')
    .action(async (files: string[], o: { note?: string; title?: string; profile: string }) =>
      spacePutCommand(out(), {
        profile: o.profile,
        files,
        ...(o.note !== undefined ? { note: o.note } : {}),
        ...(o.title ? { title: o.title } : {}),
      }),
    );
  space
    .command('list')
    .description('what is in my space, newest first')
    .option('--limit <n>', 'max items (1-50, default 20)', (v) => Number.parseInt(v, 10))
    .requiredOption('--profile <name>')
    .action(async (o: { limit?: number; profile: string }) =>
      spaceListCommand(out(), { profile: o.profile, ...(o.limit ? { limit: o.limit } : {}) }),
    );
  space
    .command('get')
    .description('download every file of one item (default: the latest); never runs or unpacks them')
    .argument('[drop_id]', 'id or id prefix from space list')
    .option('--latest', 'the newest item', false)
    .option('--to <dir>', 'folder to save into (default: the AgentDrop downloads folder)')
    .option('--force', 'replace files of the same name in that folder', false)
    .requiredOption('--profile <name>')
    .action(
      async (id: string | undefined, o: { latest: boolean; to?: string; force: boolean; profile: string }) =>
        spaceGetCommand(out(), {
          profile: o.profile,
          ...(id ? { id } : {}),
          latest: o.latest,
          ...(o.to ? { to: o.to } : {}),
          force: o.force,
        }),
    );
  space
    .command('rm')
    .description('delete one item from my space and free the space its files used')
    .argument('<drop_id>', 'id or id prefix from space list')
    .requiredOption('--profile <name>')
    .action(async (id: string, o: { profile: string }) => spaceRmCommand(out(), { profile: o.profile, id }));

  program
    .command('export')
    .description(
      'export a date range of drops with one contact or one group as a verifiable NDJSON audit file',
    )
    .requiredOption('--profile <name>')
    .option('--contact <handle>', 'direct traffic with @handle, both directions (no group traffic)')
    .option('--group <slug>', "one group's timeline (#slug)")
    .requiredOption('--since <date>', 'YYYY-MM-DD (UTC midnight) or a full ISO timestamp; included')
    .requiredOption(
      '--until <date>',
      'YYYY-MM-DD (UTC midnight) or a full ISO timestamp; excluded — the range is [since, until)',
    )
    .option('--brief', 'metadata and a preview only; the default exports full bodies', false)
    .option('--format <fmt>', 'jsonl | md (md is for reading; jsonl is the verifiable artifact)', 'jsonl')
    .option(
      '--out <file>',
      'write to a file; nothing is written unless the trailer verifies (default: stdout)',
    )
    .action(
      async (o: {
        profile: string;
        contact?: string;
        group?: string;
        since: string;
        until: string;
        brief: boolean;
        format: string;
        out?: string;
      }) =>
        exportCommand(out(), {
          profile: o.profile,
          ...(o.contact ? { contact: o.contact } : {}),
          ...(o.group ? { group: o.group } : {}),
          since: o.since,
          until: o.until,
          brief: o.brief,
          format: o.format,
          ...(o.out ? { out: o.out } : {}),
        }),
    );

  program
    .command('approvals')
    .description('sends waiting for my approval')
    .requiredOption('--profile <name>')
    .action(async (o: { profile: string }) => approvalsCommand(out(), o));
  program
    .command('approve')
    .description('approve (or --reject) a pending send; asks for confirmation on the terminal')
    .argument('<approval_id>')
    .requiredOption('--profile <name>')
    .option('--reject', 'reject instead of approve', false)
    .option('--yes', 'skip the confirmation prompt (interactive terminal only)', false)
    .action(async (id: string, o: { profile: string; reject: boolean; yes: boolean }) =>
      approveCommand(out(), { profile: o.profile, id, reject: o.reject, yes: o.yes }),
    );
  program
    .command('band')
    .description('JSON for the Claude Code mod: what is waiting for you, one row per drop or group')
    .requiredOption('--profile <name>')
    .option('--fresh', 'query now instead of the shared 15 s cache', false)
    .action(async (o: { profile: string; fresh: boolean }) =>
      forMod(o.profile, () => bandCommand(out(), { profile: o.profile, fresh: o.fresh })),
    );
  program
    .command('ack')
    .description('reply "got it, I am on it" to a drop, where it was asked (its author, or its group)')
    .argument('<drop_id>', 'the id, or its first characters (at least 4)')
    .requiredOption('--profile <name>')
    .option('--note <text>', 'one line saying what you will do, sent with the reply')
    .action(async (dropId: string, o: { profile: string; note?: string }) =>
      forMod(o.profile, () =>
        ackCommand(out(), { profile: o.profile, dropId, ...(o.note ? { note: o.note } : {}) }),
      ),
    );
  program
    .command('mark-read')
    .description(
      'mark your unread drops read: all, one group with --group, or exactly the drops given with --drop',
    )
    .requiredOption('--profile <name>')
    .option('--group <group>', 'one group: #slug or its id')
    .option('--up-to <iso_time>', 'only drops received up to this time')
    .option(
      '--drop <drop_id>',
      'only this drop (repeatable; `<drop_id>:<state_version>` skips reading it first)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action(async (o: { profile: string; group?: string; upTo?: string; drop?: string[] }) =>
      forMod(o.profile, () =>
        markReadCommand(out(), {
          profile: o.profile,
          ...(o.group ? { group: o.group } : {}),
          ...(o.upTo ? { upTo: o.upTo } : {}),
          ...(o.drop?.length ? { drops: o.drop } : {}),
        }),
      ),
    );
  program
    .command('statusline')
    .description('one line for the Claude Code status bar: new AgentDrop items you have not seen yet')
    .requiredOption('--profile <name>')
    .action(async (o: { profile: string }) => statuslineCommand({ profile: o.profile }));
  program
    .command('pending')
    .description(
      'what is waiting for me (requests, invitations, unread, approvals); --in-hook for client hooks',
    )
    .requiredOption('--profile <name>')
    .option('--format <fmt>', 'text | hook', 'text')
    .option('--in-hook', 'emit client hook JSON; silent when nothing is due', false)
    .option(
      '--hook-output <target>',
      'system-message | cursor | opencode | prompt-context | session-start',
      'system-message',
    )
    .action(async (o: { profile: string; format: string; inHook: boolean; hookOutput: string }) => {
      if (o.format !== 'text' && o.format !== 'hook') throw new Error('--format must be text or hook');
      if (!['system-message', 'cursor', 'opencode', 'prompt-context', 'session-start'].includes(o.hookOutput))
        throw new Error(
          '--hook-output must be system-message, cursor, opencode, prompt-context or session-start',
        );
      await pendingCommand(out(), {
        profile: o.profile,
        format: o.inHook ? 'hook' : o.format,
        hookOutput: o.hookOutput as
          | 'system-message'
          | 'cursor'
          | 'opencode'
          | 'prompt-context'
          | 'session-start',
      });
    });

  program
    .command('settings')
    .description('show or configure local hook notices and update preferences')
    .option('--notifications <mode>', 'on | off')
    .option('--notify-interval <duration>', 'minimum notice interval: 0 (default, every hook), 30m, 2h, 1d')
    .option('--notice-detail <level>', 'counts | names')
    .option('--updates <mode>', 'off | notify | auto (default: auto)')
    .option('--update-check-interval <duration>', 'update check interval, e.g. 24h (at least 1m)')
    .option('--language <lang>', 'language of notices shown to you: en (default) | zh')
    .option(
      '--feishu-webhook <address|off>',
      'send notices to a Feishu group bot (its webhook address), or off',
    )
    .option('--feishu-secret <secret>', 'signature secret, if the bot has signature verification on')
    .option(
      '--feishu-watch <terms|show|off>',
      'watch terms (comma-separated) picking updates that bots post in your Feishu groups; show; or off',
    )
    .option(
      '--profile <name>',
      'whose account (needed for --feishu-webhook or --feishu-watch when there are several profiles)',
    )
    .action((o: SettingsOptions) => settingsCommand(out(), o));

  program
    .command('update')
    .description('check for or install a stable CLI update in this npm global installation')
    .option('--check', 'only check; do not install', false)
    .action(async (o: { check: boolean }) => {
      const result = await maintainUpdates({ force: true, install: !o.check });
      out().result(result, () => result.message);
      if (['check_failed', 'install_failed', 'skills_failed', 'manual_required'].includes(result.status))
        process.exitCode = 1;
    });

  // Hidden and experimental: see docs/HARNESSES.md "Hidden: autorun". Not listed in --help, the skill or the web,
  // and not registered at all unless the experimental switch is on (never in the installable package).
  if (experimentalEnabled()) registerAutorun(program, out);

  program.command('_maintenance', { hidden: true }).action(async () => {
    try {
      await maintainUpdates();
    } catch {
      /* Detached optional maintenance is always quiet. */
    }
  });
  program.command('_take-claude-mod', { hidden: true }).action(() => {
    if (!takeClaudeMod()) process.exitCode = 1;
  });
  program.command('_sync-skills', { hidden: true }).action(() => {
    const result = ensureBundledSkills();
    if (result.errors.length) process.exitCode = 1;
  });

  const skill = program
    .command('skill')
    .description('companion skill (SKILL.md) that teaches clients how to use the tools');
  skill
    .command('install')
    .description(`install the shared skill for ${harnessLabels()}`)
    .option('--only <clients...>', harnessChoices(' | '))
    .action(async (o: { only?: string[] }) =>
      skillInstallCommand(out(), { ...(o.only ? { only: o.only } : {}) }),
    );
  skill
    .command('remove')
    .description('remove the installed skill from all clients')
    .action(async () => skillRemoveCommand(out(), {}));

  program
    .command('doctor')
    .description('diagnose configuration, credentials and connectivity')
    .option('--profile <name>', 'only check one profile')
    .option('--mcp', 'also spawn the bridge and run a real MCP handshake + tools/list', false)
    .action(async (o: { profile?: string; mcp: boolean }) => {
      const checks = await doctorCommand(out(), o);
      if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
    });

  markProfileOptional(program);
  return program;
}

/** `--profile` stops being mandatory on DEFAULT_PROFILE_COMMANDS; preAction fills it in (defaultProfile). */
function markProfileOptional(cmd: Command): void {
  for (const sub of cmd.commands) {
    if (DEFAULT_PROFILE_COMMANDS.has(commandPath(sub))) {
      const option = sub.options.find((o) => o.long === '--profile');
      if (option) {
        option.mandatory = false;
        option.description = option.description
          ? `${option.description} (optional when only one profile is paired)`
          : 'local profile (optional when only one profile is paired)';
      }
    }
    markProfileOptional(sub);
  }
}

function registerAutorun(program: Command, out: () => Output): void {
  const autorun = program
    .command('autorun', { hidden: true })
    .description('queue new drops into the open harness session (codex, claude-code, opencode)');
  const int = (v: string) => Number.parseInt(v, 10);
  autorun
    .command('on')
    .requiredOption('--profile <name>')
    .option('--from <handles...>', 'only drops from these senders are queued (@a,@b)')
    .option('--interval <seconds>', 'poll interval, at least 15', int)
    .option('--cooldown <seconds>', 'minimum gap between two deliveries', int)
    .option('--max-per-hour <n>', 'deliver at most N times per hour', int)
    .option('--instructions <file>', 'your own standing instructions, appended to the fixed message')
    .option('--thread <id>', 'codex: always queue into this thread')
    .action(
      (o: {
        profile: string;
        from?: string[];
        interval?: number;
        cooldown?: number;
        maxPerHour?: number;
        instructions?: string;
        thread?: string;
      }) => {
        for (const [name, value, min] of [
          ['--interval', o.interval, 15],
          ['--cooldown', o.cooldown, 0],
          ['--max-per-hour', o.maxPerHour, 1],
        ] as const)
          if (value !== undefined && (!Number.isInteger(value) || value < min))
            throw new Error(`${name} must be an integer ≥ ${min}`);
        autorunOnCommand(out(), {
          ...o,
          ...(o.from ? { from: o.from.flatMap((h) => h.split(',')).filter(Boolean) } : {}),
        });
      },
    );
  autorun
    .command('off')
    .requiredOption('--profile <name>')
    .action((o: { profile: string }) => autorunOffCommand(out(), o));
  autorun
    .command('status')
    .requiredOption('--profile <name>')
    .action((o: { profile: string }) => autorunStatusCommand(out(), o));
  autorun
    .command('poll')
    .description('used by the opencode plugin')
    .requiredOption('--profile <name>')
    .option('--probe', 'only report whether autorun is on', false)
    .action(async (o: { profile: string; probe: boolean }) => autorunPollCommand(o));
}

export async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      String((err as { code: string }).code).startsWith('commander.')
    ) {
      const code = (err as { exitCode?: number }).exitCode ?? 1;
      process.exitCode = code;
      return;
    }
    process.stderr.write(`${prefix('error')}${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && /(main|agentdrop)(\.(js|mjs|ts))?$/.test(process.argv[1]);
if (isMain) void run(process.argv);
