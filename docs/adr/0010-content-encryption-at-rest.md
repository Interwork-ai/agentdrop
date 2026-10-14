# 0010. Message content is encrypted at rest with server-managed envelope keys

- Status: Accepted
- Date: 2026-09-25
- Plan: [docs/plan/CONTENT_ENCRYPTION.md](../plan/CONTENT_ENCRYPTION.md) (reviewed; revision 2)

## Context

Drop titles, bodies, extensions, attachment names and bytes, pending approval envelopes, approval reasons and
some outbox and audit rows are stored in plaintext, and content hashes are unkeyed. The admin console shows no
content, but anyone holding a database dump, a pre-deploy backup, read access to the database or the attachment
directory can read everything. Enterprise collaboration products (Slack, Microsoft 365, Google Workspace, Feishu)
encrypt content at rest with server-managed envelope keys, keep the key apart from the data, and grant content
access to a separate, audited compliance role rather than to ordinary administrators; end-to-end encryption is
reserved for narrow cases.

## Decision

- Content is encrypted in the domain layer with AES-256-GCM: a random data key per drop, attachment and pending
  approval, wrapped by a versioned master key from a keyring file (`CONTENT_KEYS_FILE`, owned by the service uid,
  mode 0400) that never enters the database, the deploy backups or env files copied next to them. Key ids are key
  fingerprints and each key has a check row in the database. Ciphertexts are bound to key id, table, row and field
  through associated data; attachments use segmented streaming AEAD that never releases unauthenticated bytes.
- Fail closed: a row that has a data key is never read from its plaintext columns, and a database that holds any
  ciphertext refuses to start without the keyring, independent of `NODE_ENV`.
- Content hashes become `HMAC(hmac_key, sha256)` so old rows upgrade in place. Search decrypts and matches in the
  application, returning once it has a match or has spent its budget; the dashboard and the MCP text say when more
  remains. Outbox events stop carrying titles, approval and audit reasons stop carrying file names, and search terms
  are redacted from request logs.
- Keys are server-managed, so password resets keep every message. The promise covers offline and read-only
  exposure (dumps, backups, read access, storage); database write access and whoever holds both host and keyring
  are out of scope, and this is stated.
- Rollout keeps ADR 0004's one-step rollback: R1 ships the full implementation behind `CONTENT_ENCRYPTION=off`;
  switching it on (config only) starts encrypted writes and a batched backfill; R2 makes encryption mandatory and
  disables plaintext reads; R3 removes the plaintext columns from code; R4 drops them. Plaintext backups are
  deleted only after a restore drill from a fresh encrypted backup and the offline keyring, and only on the
  operator's confirmation.
- Content access for compliance, if ever built, is a separate case-based capability, off by default, requiring two
  distinct administrators, with tamper-evident audit — never a property of the ordinary admin role.

## Consequences

Stolen dumps, backups, read-only database access or storage alone no longer reveal content. Losing the keyring
loses all content including backups, so an offline copy, key checks and restore drills are part of operating a
server; a leaked master key requires re-encrypting content and retiring old backups, not just rewrapping.
Metadata (who, when, sizes, lengths) stays visible. A later KMS integration can replace the keyring file without
changing stored data. One CLI release is needed to explain partial search pages to models.
