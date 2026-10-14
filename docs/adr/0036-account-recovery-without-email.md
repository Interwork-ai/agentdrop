# 0036. Getting back into an account without email or an administrator

- Status: Accepted
- Date: 2026-10-14

## Context

A forgotten web password had two ways back: a reset email, which only works on a server whose operator configured
SMTP, and a one-time link an administrator generates in the console. Most self-hosted servers never configure mail,
so in practice every forgotten password became work for an administrator and a wait for the person. Mandatory email
verification would fix the email path but adds a mail provider, DNS records and a sign-up hurdle that most people
running AgentDrop for a team do not want.

Every AgentDrop user has something email-less products lack: a computer where one of their agents is paired, holding
a credential for their account. Products that log in "from another device you are already signed in on" (Telegram's
codes, scan-to-log-in) use the same idea. For the case where that computer is gone, products keep printed recovery
codes (GitHub, Bitwarden).

## Decision

Three light changes; none needs email, and none adds an MCP tool.

1. **From a paired device.** `agentdrop account recover` prints a one-time reset link for the account's web password
   (`POST /v1/h/account/recovery-link`, H credential). The link is the same one an administrator would generate: one
   hour, single use, a newer one retires the older, setting the password ends every web session and leaves agent
   credentials alone. Because an agent can run commands on that computer, the CLI runs it only for a person at an
   interactive terminal (stdin and stdout a TTY, outside a known agent shell, as in ADR 0032) and only after the
   person types their own handle. The server allows five per hour per account, refuses a suspended account, and
   audits `account.recovery_link` with the agent (`h_id`), never the link.
2. **Recovery codes.** Settings → Account generates ten one-time codes (about 60 bits each, shown once, only a
   SHA-256 stored in `account_recovery_codes`); the current password is asked again, so a borrowed browser session
   alone cannot mint them. A new set replaces the old one. On "Forgot password", the sign-in email plus one unused
   code returns the reset link (`POST /v1/auth/recover-with-code`); case, spaces, dashes and the look-alikes o/i/l do
   not matter. Every failure answers alike (wrong email, someone else's code, used or malformed code), attempts are
   limited per address and per email, and `account.recovery_codes_generated` / `account.recovery_code_used` are
   audited without the codes.
3. **Stay signed in longer.** A web session lasts 60 days instead of 14, renewed daily while in use, so a person who
   uses the dashboard rarely needs the password at all.

Email reset stays where a server sends mail, and the administrator's reset link stays as the last resort. The
"Forgot password" page lists what this server offers: email (if configured), a recovery code, the terminal command,
then the administrator.

## Consequences

- Whoever controls a person's computer and can type at its terminal can reset that person's web password. They
  could already read and send that person's mail through the paired agent; the password adds the dashboard, which
  is why the handle has to be typed and the attempt is audited. An agent with a shell tool cannot pass the terminal
  check without a TTY on stdin; the check is a heuristic, like ADR 0032's.
- Recovery codes are as strong as their storage: anyone with the email and one code can set a new password. The
  dashboard says so when it shows them.
- Longer sessions mean a signed-in browser stays useful to whoever has it for longer; setting a new password (any
  path) still ends every session.
- Self-hosted servers need nothing new to get all of this.
