// AgentDrop for Claude Code (2.1.287+ mods). Draws what is waiting for the person in the band above the prompt,
// one row per drop, person or group, at most five, with Read / On it / Later buttons (each row goes by itself after
// two minutes), and opens /agentdrop, a pane to read drops without involving Claude. All data and actions
// go through the agentdrop CLI with the person's own profile; this module holds no credential. Text from other
// people is cleaned and shown, never handed to Claude unasked: the prompts the buttons submit carry only ids, a
// validated @handle or #slug, and fixed words (rows.js).
import {
  bandFallback,
  bandView,
  buildRows,
  capDismissed,
  catchUpPrompt,
  clean,
  dropView,
  errorText,
  FAILURES_BEFORE_CLEARING,
  fallbackConfigPath,
  groupDropRows,
  isBusy,
  isSignedOut,
  LATER_PREFIX,
  laterRowKey,
  mergeDismissed,
  pruneDismissed,
  rowKey,
  rowKeys,
  strings,
} from './rows.js';

const POLL_MS = 20_000;

let config = null; // { argv: [...], profile }
let data = null;
let language = 'en';
let failures = 0;
// the code of the last failed refresh, and whether notices were on when last known (also told by a failure)
let lastCode = null;
let enabled;
let dismissed = {};
let timers = [];
// when this session started (epoch ms), for the band: see buildRows in rows.js
let startedAt;
// when each row and line was first drawn on this session's band: it stays two minutes (ADR 0027); null when it was
// drawn while the person was away, so its two minutes start when they are back
let shownAt = new Map();
// when a row was first actually drawn (not just counted), and what this session already put away by time
let drawnAt = new Map();
let putAwayHere = new Set();
// the language the commands were registered in, to register them again once the person's is known
let commandsIn;
// when the person last typed, sent a prompt or pressed something here; `sensed` false when this Claude Code cannot
// tell (no typing hooks), and then every row counts down from when it was drawn
let activeAt;
let sensed = false;
let pane = { view: 'list', drop: null, id: null, group: null, note: null };

/** A CLI call that failed, by the code `agentdrop --json` reported (rows.js turns it into people text). */
class CliFailure extends Error {
  constructor(code, lang, notices) {
    super(code);
    this.code = code;
    this.language = lang;
    this.enabled = typeof notices === 'boolean' ? notices : undefined;
  }
}

async function loadConfig($) {
  // `agentdrop connect claude-code` writes, into this plugin's copy, where its claude-mod.json is
  let path = null;
  try {
    const pointer = JSON.parse(await $.fs.read(`${$.plugin.root}/config.json`));
    if (typeof pointer.config === 'string' && pointer.config) path = pointer.config;
  } catch {
    // a copy without the pointer (loaded by hand): the CLI's own rule for its config directory
  }
  if (!path)
    path = fallbackConfigPath({
      AGENTDROP_CONFIG_DIR: await $.env.get('AGENTDROP_CONFIG_DIR'),
      XDG_CONFIG_HOME: await $.env.get('XDG_CONFIG_HOME'),
      HOME: await $.env.get('HOME'),
      USERPROFILE: await $.env.get('USERPROFILE'),
    });
  try {
    const parsed = JSON.parse(await $.fs.read(path));
    if (Array.isArray(parsed.argv) && parsed.argv.length && typeof parsed.profile === 'string') return parsed;
  } catch {
    // not connected through `agentdrop connect claude-code`: stay out of the way
  }
  return null;
}

async function cli($, args) {
  let res;
  try {
    res = await $.process.run([...config.argv, '--json', ...args, '--profile', config.profile], {
      timeoutMs: 20_000,
    });
  } catch {
    // the agentdrop command could not start, or ran too long
    throw new CliFailure('NOT_STARTED');
  }
  if (res.exitCode !== 0) {
    let failure = new CliFailure('FAILED');
    try {
      const parsed = JSON.parse(res.stdout);
      if (typeof parsed?.error?.code === 'string')
        failure = new CliFailure(parsed.error.code, parsed.language, parsed.enabled);
    } catch {
      // an older CLI prints only to stderr: the generic sentence
    }
    throw failure;
  }
  return JSON.parse(res.stdout);
}

/** People text for a failure, in the person's language. */
function failureText(err) {
  return errorText(err?.code, err?.language ?? language);
}

/** What every session put off: one store key per row ("later:<row>"), read back and pruned after a week. */
async function reloadDismissed($) {
  const now = await $.clock.now();
  const stored = {};
  for (const key of await $.store.keys()) {
    const row = laterRowKey(key);
    if (row !== null) stored[row] = await $.store.get(key);
  }
  // the single object earlier builds kept, read once and moved to one key per row
  const legacy = await $.store.get('dismissed');
  if (legacy && typeof legacy === 'object') {
    for (const [row, at] of Object.entries(legacy))
      if (typeof at === 'number') await $.store.set(`${LATER_PREFIX}${row}`, at);
    Object.assign(stored, mergeDismissed(legacy, stored));
    await $.store.delete('dismissed');
  }
  // a week at most, and only the newest LATER_MAX: one get per key per poll stays bounded
  const kept = capDismissed(pruneDismissed(stored, now));
  for (const row of Object.keys(stored)) if (!(row in kept)) await $.store.delete(`${LATER_PREFIX}${row}`);
  // what this session put off stays even when its write did not land
  dismissed = capDismissed(pruneDismissed(mergeDismissed(kept, dismissed), now));
}

/** Puts one row off: writes that row's key only, so another session's "Later" is never overwritten. */
async function saveDismissed($, row, at) {
  dismissed[row] = at;
  await $.store.set(`${LATER_PREFIX}${row}`, at);
}

async function refresh($, fresh) {
  if (!config) return;
  try {
    const next = await cli($, fresh ? ['band', '--fresh'] : ['band']);
    data = next;
    if (next?.language) language = next.language;
    if (commandsIn !== undefined && commandsIn !== language) await registerCatchUp($);
    if (typeof next?.enabled === 'boolean') enabled = next.enabled;
    failures = 0;
    lastCode = null;
  } catch (err) {
    if (err?.language) language = err.language;
    if (typeof err?.enabled === 'boolean') enabled = err.enabled;
    // another session was refreshing and this one waited: the next poll reads that result
    if (!isBusy(err?.code)) {
      failures += 1;
      lastCode = err?.code ?? null;
      // signed out: nothing on the rows can work any more; otherwise one failure keeps the rows for one more
      // poll, and after that nothing stale stays pressable
      if (isSignedOut(lastCode) || failures >= FAILURES_BEFORE_CLEARING) data = null;
    }
  }
  try {
    // another session may have put rows off since: the store is shared
    await reloadDismissed($);
  } catch {
    // keep what this session knows
  }
  $.ui.invalidate('ui.render');
}

function dismissedSet() {
  return new Set(Object.keys(dismissed));
}

const PANE = { id: 'agentdrop', title: 'AgentDrop', focus: true, closeOnEscape: true };

/**
 * The person pressed "On it": the acknowledgement goes out, then the drop opens in the pane, so they see what they
 * took on (ADR 0027). Opening it is the person reading it, as from the pane's own list.
 */
async function ackAndShow($, id) {
  let sent;
  try {
    const res = await cli($, ['ack', id]);
    sent = clean(res.message, { max: 200 });
    // a reply that did not go out is not "on it": say so, open nothing
    if (!['delivered', 'already_sent', 'needs_approval'].includes(res.outcome)) {
      $.ui.toast(sent);
      await refresh($, true);
      return;
    }
  } catch (err) {
    $.ui.toast(failureText(err));
    await refresh($, true);
    return;
  }
  try {
    const res = await cli($, ['read', id, '--mark-read']);
    const lang = data?.language ?? language;
    pane = { view: 'drop', drop: dropView(res.drop, lang), id, group: null, note: sent };
    await $.ui.open(PANE);
    $.ui.invalidate('ui.render');
  } catch {
    // the acknowledgement went out; only showing the drop did not work
    $.ui.toast(sent);
  }
  await refresh($, true);
}

/** Away for this long, a new row waits for the person before its two minutes start (ADR 0027). */
const AWAY_MS = 300_000;

/** The person is at the session now: rows drawn while they were away start their two minutes. */
async function attend($) {
  const now = await $.clock.now();
  activeAt = now;
  for (const [key, at] of shownAt) if (at === null) shownAt.set(key, now);
}

/** Puts a row away for every session, a person's row with each drop it stands for. */
async function putAway($, row) {
  const now = await $.clock.now();
  for (const key of rowKeys(row)) await saveDismissed($, key, now);
}

/** Rows the person handed to Claude (Read, Look) leave the band: the conversation has them now. */
async function handOff($, row) {
  try {
    await attend($);
    await putAway($, row);
  } catch {
    // the press still goes through
  }
  $.ui.invalidate('ui.render');
  void $.prompt.submit({ text: row.prompt, asUser: true });
}

/**
 * `/agentdrop-read` in the person's language; registered again (a name registered again is replaced) once a refresh
 * tells the language, since the session starts before the first one.
 */
async function registerCatchUp($) {
  const t = strings(language);
  const catchUp = { name: 'agentdrop-read', description: t.catchUp };
  commandsIn = language;
  try {
    await $.command.register({ ...catchUp, argumentHint: t.catchUpHint });
  } catch {
    try {
      // a Claude Code without argument hints
      await $.command.register(catchUp);
    } catch {
      // the name is taken: the rest still works, and asking Claude does the same
    }
  }
}

/** The person's own gesture: typed at the terminal or sent through Remote Control, not a loop, task or other agent. */
function byPerson(e) {
  return e?.origin?.kind === 'composer' || e?.origin?.kind === 'bridge';
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    // a resumed session starts again: one poll per process, never two
    for (const timer of timers) timer.cancel();
    timers = [];
    shownAt = new Map();
    drawnAt = new Map();
    putAwayHere = new Set();
    // the band lists what is new to this session, not what an earlier one already showed (ADR 0025)
    try {
      startedAt = await $.clock.now();
      activeAt = startedAt;
    } catch {
      startedAt = undefined;
    }
    // a script, CI or `claude -p` run: nobody looks at a band
    if (
      (await $.env.get('CLAUDE_CODE_SESSION_ATTENDED')) === '0' ||
      (await $.env.get('AGENTDROP_UNATTENDED')) === '1'
    )
      return next(e);
    config = await loadConfig($);
    if (!config) return next(e);
    try {
      await reloadDismissed($);
    } catch {
      // a store that cannot be read: nothing is put off yet, and the band still works
    }
    try {
      await $.command.register({
        name: 'agentdrop',
        description: 'AgentDrop: read what is waiting for you, without starting a turn',
        immediate: true,
      });
    } catch {
      // the name is taken: the band still works
    }
    await registerCatchUp($);
    timers = [$.clock.after(1_000, () => refresh($, false)), $.clock.every(POLL_MS, () => refresh($, false))];
    return next(e);
  });

  // typing and sending are the person at the session: what was drawn while they were away starts its two minutes.
  // Hooks this Claude Code does not have are skipped; then every row counts down from when it was drawn.
  // Only the person's own: a /loop, a scheduled task or a message from another agent does not mean they are there.
  // Never in the way of typing: the edit goes on at once, the note is taken beside it.
  // Claude Code reads each on("<event>", …) as written: the event is always a string literal, never a variable.
  try {
    on('prompt.edit', ($, e, next) => {
      attend($).catch(() => {});
      return next(e);
    });
    sensed = true;
  } catch {
    // this Claude Code has no such hook
  }
  try {
    on('prompt.submit', ($, e, next) => {
      if (byPerson(e)) attend($).catch(() => {});
      return next(e);
    });
    sensed = true;
  } catch {
    // this Claude Code has no such hook
  }

  // the person asks Claude to catch them up, optionally on a person, group or project they name (ADR 0028)
  on('command.run', { command: 'agentdrop-read' }, async ($, e) => {
    // the words become a prompt as the person: only from the person's own gesture
    if (!byPerson(e)) return {};
    const text = catchUpPrompt(e.args, data?.language ?? language);
    // Claude Code refuses a submit from inside command.run (it would wait on the turn this hook holds): submit right
    // after the hook has returned
    $.clock.after(0, () => {
      $.prompt.submit({ text, asUser: true }).catch(() => {
        // nothing to tell: the person sees no turn start and can ask Claude directly
      });
    });
    return {};
  });

  on('command.run', { command: 'agentdrop' }, async ($) => {
    pane = { view: 'list', drop: null, id: null, group: null, note: null };
    // open at once with what the band has, then bring it up to date
    await $.ui.open(PANE);
    void refresh($, true);
    return {};
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config || e.props.hasSurvey) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const t = strings(data?.language ?? language);
    const width = Math.max(20, e.props.bodyColumns - 2);
    if (!data) {
      // nothing with notices off; signed out, or the inbox out of reach, as one dim line
      const line = bandFallback({ failures, code: lastCode, enabled }, language);
      if (!line) return next(e);
      return Box({
        flexDirection: 'column',
        width,
        children: [Text({ dimColor: true, children: [line] })],
      });
    }
    // each row and line for two minutes, the newest five rows at most; a new message is a new row (ADR 0027)
    const now = await $.clock.now();
    const put = dismissedSet();
    const built = buildRows(data, put, 'band', startedAt);
    for (const key of putAwayHere) put.add(key);
    const view = bandView(built, { shownAt, drawnAt }, now, put, data.language ?? language);
    const { rows, footer, stamp, drawn, expired } = view;
    const here = !sensed || (typeof activeAt === 'number' && now - activeAt <= AWAY_MS);
    for (const [key, at] of stamp) shownAt.set(key, at === undefined ? (here ? now : null) : at);
    for (const key of drawn) drawnAt.set(key, now);
    // put away for every session on the machine, as "Later" does; the pane and the dashboard still list them. Once
    // per key in this session, so a key the shared list later drops is not written over and over.
    for (const key of expired) {
      if (putAwayHere.has(key)) continue;
      putAwayHere.add(key);
      saveDismissed($, key, now).catch(() => {
        // this session has them put away either way
      });
    }
    if (rows.length === 0 && footer.length === 0) return next(e);
    // no hotkeys here: a digit typed into an empty prompt answers Claude's numbered options, not this band
    const children = [
      Text({ bold: true, children: [`✉ ${t.title}`] }),
      ...rows.map((row) => {
        const buttons =
          row.kind === 'person'
            ? [
                // several from one person: Claude reads them all; acknowledging is per drop, in the pane
                Button({
                  key: `read:${rowKey(row)}`,
                  label: t.read,
                  onPress: () => handOff($, row),
                }),
              ]
            : row.kind === 'drop'
              ? [
                  Button({
                    key: `read:${row.id}`,
                    label: t.read,
                    onPress: () => handOff($, row),
                  }),
                  Button({
                    key: `ack:${row.id}`,
                    label: t.ack,
                    onPress: async () => {
                      await attend($).catch(() => {});
                      await ackAndShow($, row.id);
                    },
                  }),
                ]
              : [
                  Button({
                    key: `look:${row.id}`,
                    label: t.look,
                    onPress: () => handOff($, row),
                  }),
                  ...(row.drops.length
                    ? [
                        Button({
                          key: `mark:${row.id}`,
                          label: t.markRead,
                          onPress: async () => {
                            try {
                              // only the drops this row stands for; mentions and replies listed above stay unread
                              const res = await cli($, [
                                'mark-read',
                                ...row.drops.flatMap((d) => ['--drop', d]),
                              ]);
                              // some may be gone or changed meanwhile: worth a word only when none could be marked
                              if (res?.marked === 0 && res?.skipped > 0)
                                $.ui.toast(errorText('VERSION_CONFLICT', language));
                            } catch (err) {
                              $.ui.toast(failureText(err));
                            }
                            await refresh($, true);
                          },
                        }),
                      ]
                    : []),
                ];
        return Box({
          key: rowKey(row),
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Box({
              flexGrow: 1,
              flexShrink: 1,
              children: [Text({ wrap: 'truncate-end', children: [row.text] })],
            }),
            ...buttons,
            Button({
              key: `later:${rowKey(row)}`,
              label: t.later,
              dimColor: true,
              onPress: async () => {
                await attend($).catch(() => {});
                await putAway($, row);
                $.ui.invalidate('ui.render');
              },
            }),
          ],
        });
      }),
      ...footer.map((line) => Text({ dimColor: true, wrap: 'truncate-end', children: [line] })),
    ];
    return Box({ flexDirection: 'column', width, children });
  });

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'agentdrop') return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const t = strings(data?.language ?? language);
    const note = pane.note ? [Text({ dimColor: true, children: [pane.note] })] : [];
    if (pane.view === 'drop' && pane.drop) {
      const d = pane.drop;
      const id = pane.id;
      return Box({
        flexDirection: 'column',
        rowGap: 1,
        children: [
          Text({ bold: true, children: [d.title] }),
          ...(d.meta ? [Text({ dimColor: true, children: [d.meta] })] : []),
          // someone else's words, cleaned and shown to the person as written; nothing here reaches Claude
          Text({ wrap: 'wrap', children: [d.body] }),
          ...(d.truncated ? [Text({ dimColor: true, children: [d.truncated] })] : []),
          ...(d.files.length ? [Text({ dimColor: true, children: [d.files.join(' · ')] })] : []),
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Button({
                key: 'pane-ack',
                label: t.ack,
                onPress: async () => {
                  try {
                    const res = await cli($, ['ack', id]);
                    pane.note = clean(res.message, { max: 200 });
                  } catch (err) {
                    pane.note = failureText(err);
                  }
                  $.ui.invalidate('ui.render');
                  await refresh($, true);
                },
              }),
              Button({
                key: 'pane-back',
                label: `← ${t.back}`,
                autoFocus: true,
                onPress: () => {
                  pane = pane.group
                    ? { view: 'group', drop: null, id: null, group: pane.group, note: null }
                    : { view: 'list', drop: null, id: null, group: null, note: null };
                  $.ui.invalidate('ui.render');
                },
              }),
            ],
          }),
          ...note,
        ],
      });
    }
    if (!data) {
      const line = isSignedOut(lastCode)
        ? errorText(lastCode, language)
        : failures > 0
          ? t.unreachable
          : t.loading;
      return Box({
        flexDirection: 'column',
        children: [Text({ dimColor: true, children: [line] }), ...note],
      });
    }
    // opening a drop here is the person reading it, as in the dashboard: mark it read
    const opener = (row, i, back) =>
      Button({
        key: `open:${row.id}`,
        label: row.text,
        plain: true,
        ...(i < 9 ? { hotkey: String(i + 1) } : {}),
        ...(i === 0 ? { autoFocus: true } : {}),
        onPress: async () => {
          try {
            const res = await cli($, ['read', row.id, '--mark-read']);
            pane = {
              view: 'drop',
              drop: dropView(res.drop, data?.language ?? language),
              id: row.id,
              group: back,
              // the drop is shown either way; only marking it read did not work
              note: res.mark_read_failed ? strings(data?.language ?? language).markFailed : null,
            };
          } catch (err) {
            pane.note = failureText(err);
          }
          $.ui.invalidate('ui.render');
          void refresh($, true);
        },
      });
    if (pane.view === 'group' && pane.group) {
      // one group row, opened: its unread drops, each one to read
      const list = groupDropRows(data, pane.group);
      return Box({
        flexDirection: 'column',
        children: [
          ...note,
          ...list.map((row, i) => opener(row, i, pane.group)),
          ...(list.length === 0 ? [Text({ dimColor: true, children: [t.nothing] })] : []),
          Button({
            key: 'group-back',
            label: `← ${t.back}`,
            ...(list.length === 0 ? { autoFocus: true } : {}),
            onPress: () => {
              pane = { view: 'list', drop: null, id: null, group: null, note: null };
              $.ui.invalidate('ui.render');
            },
          }),
        ],
      });
    }
    // the person opened the pane: it lists what is unread even with notices off
    const { rows, footer } = buildRows(data, new Set(), 'pane');
    const drops = rows.filter((r) => r.kind === 'drop');
    const groupRows = rows.filter((r) => r.kind === 'group');
    const children = [
      ...note,
      ...drops.map((row, i) => opener(row, i, null)),
      ...groupRows.map((row, j) => {
        const i = drops.length + j;
        return Button({
          key: `group:${row.id}`,
          label: row.text,
          plain: true,
          ...(i < 9 ? { hotkey: String(i + 1) } : {}),
          ...(i === 0 ? { autoFocus: true } : {}),
          onPress: () => {
            pane = { view: 'group', drop: null, id: null, group: row.id, note: null };
            $.ui.invalidate('ui.render');
          },
        });
      }),
      ...footer.map((line) => Text({ dimColor: true, children: [line] })),
      ...(rows.length === 0 && footer.length === 0 ? [Text({ dimColor: true, children: [t.nothing] })] : []),
    ];
    return Box({ flexDirection: 'column', children });
  });
}
