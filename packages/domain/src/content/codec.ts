import { randomUUID } from 'node:crypto';
import type { FieldRef, RowRef } from './cipher.js';
import { contentCipher, writesEncrypted } from './state.js';

/*
 * The only place content is sealed or opened (docs/plan/CONTENT_ENCRYPTION.md §6, §11). A row that has a data key
 * is always decrypted and its plaintext columns are never read, so nobody can slip plaintext in beside a
 * ciphertext. Rows without one are pre-encryption rows and are read as they are.
 */

export interface DropContent {
  title: string;
  body: string;
  extensions: Record<string, unknown>;
}

export interface DropContentColumns {
  title: string | null;
  body: string | null;
  extensions: unknown;
  dek: Buffer | null;
  titleEnc: Buffer | null;
  bodyEnc: Buffer | null;
  extensionsEnc: Buffer | null;
}

/** Ids of encrypted rows are chosen by the application: the ciphertext is bound to them before the insert. */
export function newRowId(): string {
  return randomUUID();
}

/** Column values for a new drop: encrypted when the switch is on, plaintext otherwise. */
export function sealDrop(id: string, content: DropContent): DropContentColumns {
  if (!writesEncrypted())
    return {
      title: content.title,
      body: content.body,
      extensions: content.extensions,
      dek: null,
      titleEnc: null,
      bodyEnc: null,
      extensionsEnc: null,
    };
  const cipher = contentCipher();
  const row: RowRef = { table: 'drops', id };
  const dek = cipher.newDek();
  const f = (field: string): FieldRef => ({ ...row, field });
  return {
    title: null,
    body: null,
    extensions: null,
    dek: cipher.wrapDek(dek, row),
    titleEnc: cipher.seal(dek, f('title'), content.title),
    bodyEnc: cipher.seal(dek, f('body'), content.body),
    extensionsEnc: cipher.seal(dek, f('extensions'), JSON.stringify(content.extensions ?? {})),
  };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // the parser message quotes its input, which is decrypted content
    throw new Error(`${what} is not valid JSON`);
  }
}

export function openDrop(row: { id: string } & DropContentColumns): DropContent {
  if (row.dek) {
    const cipher = contentCipher();
    const ref: RowRef = { table: 'drops', id: row.id };
    const dek = cipher.unwrapDek(row.dek, ref);
    const f = (field: string): FieldRef => ({ ...ref, field });
    if (!row.titleEnc || !row.bodyEnc || !row.extensionsEnc)
      throw new Error(`drop ${row.id}: ciphertext missing`);
    return {
      title: cipher.openText(dek, f('title'), row.titleEnc),
      body: cipher.openText(dek, f('body'), row.bodyEnc),
      extensions: parseJson(cipher.openText(dek, f('extensions'), row.extensionsEnc), 'extensions') as Record<
        string,
        unknown
      >,
    };
  }
  if (row.title === null || row.body === null) throw new Error(`drop ${row.id}: content missing`);
  return { title: row.title, body: row.body, extensions: (row.extensions ?? {}) as Record<string, unknown> };
}

/** Like openDrop, but a row that cannot be read shows as a placeholder instead of failing a whole list. */
export function openDropForList(
  row: { id: string } & DropContentColumns,
): DropContent & { unreadable?: true } {
  try {
    return openDrop(row);
  } catch (err) {
    console.error(`[agentdrop] drop ${row.id} could not be decrypted: ${(err as Error).name}`);
    return { title: '(content unavailable)', body: '', extensions: {}, unreadable: true };
  }
}

/* ------------------------------------------------------------------ attachments */

export interface AttachmentMeta {
  safeName: string;
  contentType: string;
  sha256: string | null;
}

export interface AttachmentMetaColumns {
  safeName: string | null;
  contentType: string | null;
  sha256: string | null;
  dek: Buffer | null;
  metaEnc: Buffer | null;
}

/** A data key for a new attachment (its bytes and its metadata share it), or null when writing plaintext. */
export function newAttachmentKey(id: string): { dek: Buffer; wrapped: Buffer } | null {
  if (!writesEncrypted()) return null;
  const cipher = contentCipher();
  const dek = cipher.newDek();
  return { dek, wrapped: cipher.wrapDek(dek, { table: 'attachments', id }) };
}

export function attachmentDek(row: { id: string; dek: Buffer | null }): Buffer | null {
  return row.dek ? contentCipher().unwrapDek(row.dek, { table: 'attachments', id: row.id }) : null;
}

export function sealAttachmentMeta(
  row: { id: string; dek: Buffer | null },
  meta: AttachmentMeta,
): Pick<AttachmentMetaColumns, 'safeName' | 'contentType' | 'sha256' | 'metaEnc'> {
  const dek = attachmentDek(row);
  if (!dek)
    return { safeName: meta.safeName, contentType: meta.contentType, sha256: meta.sha256, metaEnc: null };
  return {
    safeName: null,
    contentType: null,
    sha256: null,
    metaEnc: contentCipher().seal(
      dek,
      { table: 'attachments', id: row.id, field: 'meta' },
      JSON.stringify({ safe_name: meta.safeName, content_type: meta.contentType, sha256: meta.sha256 }),
    ),
  };
}

export function openAttachmentMeta(row: { id: string } & AttachmentMetaColumns): AttachmentMeta {
  if (row.dek) {
    const dek = attachmentDek(row);
    if (!dek || !row.metaEnc) throw new Error(`attachment ${row.id}: metadata missing`);
    const m = parseJson(
      contentCipher().openText(dek, { table: 'attachments', id: row.id, field: 'meta' }, row.metaEnc),
      'attachment metadata',
    ) as { safe_name: string; content_type: string; sha256: string | null };
    return { safeName: m.safe_name, contentType: m.content_type, sha256: m.sha256 };
  }
  if (row.safeName === null || row.contentType === null)
    throw new Error(`attachment ${row.id}: metadata missing`);
  return { safeName: row.safeName, contentType: row.contentType, sha256: row.sha256 };
}

/* ------------------------------------------------------------------ approvals */

export interface ApprovalContent<E> {
  envelope: E;
  reasons: string[];
}

export function sealApproval<E>(
  id: string,
  content: ApprovalContent<E>,
): { envelope: unknown; reasons: string[]; dek: Buffer | null; payloadEnc: Buffer | null } {
  if (!writesEncrypted())
    return { envelope: content.envelope, reasons: content.reasons, dek: null, payloadEnc: null };
  const cipher = contentCipher();
  const row: RowRef = { table: 'approvals', id };
  const dek = cipher.newDek();
  return {
    envelope: {},
    reasons: [],
    dek: cipher.wrapDek(dek, row),
    payloadEnc: cipher.seal(dek, { ...row, field: 'payload' }, JSON.stringify(content)),
  };
}

export function openApproval<E>(row: {
  id: string;
  envelope: unknown;
  reasons: unknown;
  dek: Buffer | null;
  payloadEnc: Buffer | null;
}): ApprovalContent<E> {
  if (row.dek) {
    const cipher = contentCipher();
    const ref: RowRef = { table: 'approvals', id: row.id };
    if (!row.payloadEnc) throw new Error(`approval ${row.id}: ciphertext missing`);
    const dek = cipher.unwrapDek(row.dek, ref);
    return parseJson(
      cipher.openText(dek, { ...ref, field: 'payload' }, row.payloadEnc),
      'approval',
    ) as ApprovalContent<E>;
  }
  return { envelope: row.envelope as E, reasons: (row.reasons as string[]) ?? [] };
}

/* ------------------------------------------------------------------ hashes */

/** Stored form of a content hash computed as sha256 hex (v1): keyed (v2) when writing encrypted. */
export function storedHash(v1hex: string): { hash: string; version: 1 | 2 } {
  return writesEncrypted()
    ? { hash: contentCipher().contentHmac(v1hex), version: 2 }
    : { hash: v1hex, version: 1 };
}

export function hashMatches(v1hex: string, stored: string, version: number): boolean {
  if (version === 1) return stored === v1hex;
  return contentCipher().matchesStoredHash(v1hex, stored, version);
}
