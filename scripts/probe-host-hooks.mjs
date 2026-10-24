#!/usr/bin/env node
// Probes whether a host runs Claude Code-style command hooks before an adapter relies on them (docs/HARNESSES.md).
//
//   node scripts/probe-host-hooks.mjs install <settings.json>...   add a probe hook for every event to each file
//   (start the host, open a session, send two prompts, let a turn finish; note what you see on screen)
//   node scripts/probe-host-hooks.mjs report                       which file's hooks fired, for which events, in order
//   node scripts/probe-host-hooks.mjs remove <settings.json>...    take the probe hooks out again
//
// Each probe hook appends one line to the log (event, file, the input's keys, session id; never the prompt text) and
// answers with a `systemMessage` naming the event, which shows whether the host displays it to the person. Prompt
// and session-start hooks also return `additionalContext`, so asking the model "what does the probe line say?"
// shows whether the model receives it. A Cursor-style `hooks.json` (`{version, hooks: {event: [{command}]}}`) is
// written in that shape when the file name is `hooks.json`. Every write keeps a `.probe-backup` of the original. The
// command names this node by absolute path: a desktop app started from the Dock does not have a shell PATH.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The environment assignment that marks a probe command, so `remove` takes out only these.
const MARK = 'AGENTDROP_PROBE_HOOK';
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SessionEnd',
  'PreCompact',
  // the names a Cursor-style host uses for the same moments
  'beforeSubmitPrompt',
  'stop',
  'sessionStart',
];
const LOG = process.env.PROBE_LOG ?? join(homedir(), '.agentdrop-probe', 'hooks.log');
const self = fileURLToPath(import.meta.url);
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'install') edit(rest, install);
else if (cmd === 'remove') edit(rest, remove);
else if (cmd === 'fire') await fire(rest[0], rest[1]);
else if (cmd === 'report') report();
else {
  console.error('usage: probe-host-hooks.mjs install|remove <settings.json>... | report');
  process.exit(2);
}

function edit(paths, change) {
  if (!paths.length) throw new Error('name at least one settings file');
  for (const p of paths.map((x) => resolve(x))) {
    const before = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    if (existsSync(p) && !existsSync(`${p}.probe-backup`)) copyFileSync(p, `${p}.probe-backup`);
    const after = change(before, p);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(after, null, 2)}\n`);
    console.log(`${cmd}: ${p}`);
  }
}

function install(config, path) {
  const cursorStyle = basename(path) === 'hooks.json';
  const hooks = { ...remove(config, path).hooks };
  for (const event of EVENTS) {
    const command = `${MARK}=1 ${quote(process.execPath)} ${quote(self)} fire ${event} ${quote(path)}`;
    const handler = cursorStyle ? { command } : { hooks: [{ type: 'command', command, timeout: 10 }] };
    hooks[event] = [...(hooks[event] ?? []), handler];
  }
  return cursorStyle ? { version: config.version ?? 1, ...config, hooks } : { ...config, hooks };
}

function remove(config) {
  const hooks = {};
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    const kept = (Array.isArray(groups) ? groups : []).filter((g) => !JSON.stringify(g).includes(MARK));
    if (kept.length) hooks[event] = kept;
  }
  const next = { ...config, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

async function fire(event, file) {
  let input = {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    /* a host that sends no JSON is a finding too: keys stay empty */
  }
  mkdirSync(dirname(LOG), { recursive: true });
  const line = {
    at: new Date().toISOString(),
    event,
    file,
    hook_event_name: input.hook_event_name ?? input.hookEventName ?? null,
    session_id: input.session_id ?? input.sessionId ?? input.conversation_id ?? null,
    source: input.source ?? null,
    keys: Object.keys(input).sort(),
  };
  appendFileSync(LOG, `${JSON.stringify(line)}\n`);
  const say = `AgentDrop probe: ${event} ran from ${file}`;
  const context = ['SessionStart', 'UserPromptSubmit', 'sessionStart', 'beforeSubmitPrompt'].includes(event)
    ? { hookSpecificOutput: { hookEventName: event, additionalContext: `The probe line is: PROBE-${event}` } }
    : {};
  process.stdout.write(JSON.stringify({ systemMessage: say, ...context }));
}

function report() {
  if (!existsSync(LOG)) {
    console.log(`no hook ran (nothing in ${LOG})`);
    return;
  }
  const lines = readFileSync(LOG, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  for (const l of lines)
    console.log(`${l.at}  ${l.event.padEnd(18)} ${l.source ?? ''}\t${l.file}\tkeys=${l.keys.join(',')}`);
  const fired = [...new Set(lines.map((l) => `${l.event} ← ${l.file}`))];
  console.log(`\n${lines.length} runs; fired: ${fired.join('; ')}`);
}
