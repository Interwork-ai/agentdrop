/** Hard limits for payload_version 1. Changing these is a contract change. */
export const LIMITS = {
  PAYLOAD_VERSION: 1,
  TITLE_MAX_CHARS: 160,
  BODY_MAX_BYTES: 64 * 1024,
  EXTENSIONS_MAX_BYTES: 16 * 1024,
  MAX_ATTACHMENTS: 10,
  MAX_TARGETS: 20,
  /** People per group: active members + outstanding invitations + join requests awaiting an admin. */
  GROUP_MAX_MEMBERS: 20,
  /**
   * Distinct destination endpoints one send may expand to. Sized for groups that receive with all agents: 20
   * members with up to 10 agents each.
   */
  MAX_GROUP_RECIPIENT_H: 200,
  /**
   * Drops per export. The ceiling exists so one request cannot decide to read a whole server: at 64 KiB of body
   * each, 2000 is ~128 MiB worst case. Exceeding it is refused outright rather than truncated — a silently
   * short audit file is worse than none.
   */
  EXPORT_MAX_DROPS: 2000,
  /** Days one export may span. Longer ranges are split by the caller, which also keeps files reviewable. */
  EXPORT_MAX_DAYS: 366,
  DIRECTORY_LIMIT_DEFAULT: 10,
  DIRECTORY_LIMIT_MAX: 20,
  LIST_LIMIT_DEFAULT: 20,
  LIST_LIMIT_MAX: 50,
  /** Drops one "mark all as read" call changes; the client calls again while `remaining` > 0. */
  MARK_ALL_READ_MAX: 2000,
  READ_MAX_CHARS: 8192,
  READ_DEFAULT_CHARS: 4096,
  PREVIEW_CHARS: 160,
  NAME_MIN_CHARS: 1,
  NAME_MAX_CHARS: 64,
  REMARK_MAX_CHARS: 64,
  GROUP_DESCRIPTION_MAX_CHARS: 512,
  /** A default group name ("<creator nickname> +N") never passes this length; the nickname is shortened. */
  GROUP_DEFAULT_NAME_MAX_CHARS: 32,
  /** RFC 5321 path limit. */
  EMAIL_MAX_CHARS: 254,
  HANDLE_MIN: 3,
  HANDLE_MAX: 32,
  REQUEST_ID_MAX: 128,
} as const;

/** Bytes of a string encoded as UTF-8. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Control characters (except tab/newline/CR) are never allowed in human-facing names or titles. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the purpose of this rule
export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Bidi embedding/override (U+202A–U+202E) and isolate (U+2066–U+2069) controls reorder the text around them, so a
 * name or title could display as something other than what it is ("Trojan Source"). Joiners such as ZWJ (U+200D)
 * stay allowed: emoji sequences need them.
 */
export const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/;

/** Titles, names and remarks: no control characters and no bidi overrides or isolates. */
export function hasNoControlChars(value: string): boolean {
  return !CONTROL_CHARS.test(value) && !BIDI_CONTROLS.test(value);
}
