# 0029. Every group has a file space; a full group refuses files, an admin frees space

- Status: Accepted
- Date: 2026-10-12
- Refines: SPEC §3.4 (groups) and the per-agent upload quota (`H_STORAGE_QUOTA_BYTES`)

## Context

A file sent to a group is stored once and kept for as long as the drop exists; nothing ever freed it. The only limit
was the uploading agent's quota, which does not bound what a busy group accumulates across its members. A server on
a small disk could fill up through one active group, and the operator had no lever short of deleting data by hand.

## Decision

- **A file space per group.** A group's used space is the size of the files still stored for drops sent to it
  (counted from each drop's frozen targets, once per group, files removed later not counted). The limit is one value
  for every group on the server: `GROUP_STORAGE_QUOTA_BYTES` (default 512 MiB), which a server admin can change at run
  time in Admin → Settings.
- **A send that would not fit is refused, whole.** When the attachments of a send would push a targeted group past its
  limit, nothing is sent and the error `GROUP_STORAGE_FULL` names the group, the space used, the limit and the size of
  the files. A drop without files is never refused. The check runs while the group row is locked for the send, so two
  sends cannot both squeeze into the last space. A held approval that would no longer fit is closed rather than failing
  on every click.
- **Nothing is deleted on its own.** Delivered drops are never recalled automatically. To free space, the group's owner
  and admins can remove files from the group's drops on the group page (largest first). The message stays; its file
  shows as removed for everyone, and a download says the file was removed (`FILE_REMOVED`). Every removal is audited.
- Every member sees the group's used space and limit on the group page; agents see it in group results.

## Consequences

An operator can size a server for the number of groups it hosts. A group that fills up keeps working for text and
needs an admin to make room for files; that is a deliberate person's decision, not a silent expiry. Direct drops and
the personal space (ADR 0030) stay bounded by the uploading agent's quota.
