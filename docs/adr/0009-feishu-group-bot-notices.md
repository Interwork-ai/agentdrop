# 0009. Feishu notices go through a group-bot webhook, sent by the server

- Status: Accepted
- Date: 2026-09-24
- Guide: [docs/FEISHU.md](../FEISHU.md)
- Refined by: ADR 0039 (cards from the server's own Feishu app to a linked account)

## Context

People wanted AgentDrop notices in Feishu (飞书). Two local designs were built and dropped (the first was
committed and then reverted): direct messages through `lark-cli` from the end-of-turn hook only fire while an agent is working, and a
per-minute launchd job or a resident process costs resources on every machine and adds a moving part people have
to trust. Browser push already does the right thing: the server sends when the item arrives.

## Decision

A per-account Feishu custom-bot webhook, `app_users.feishu_webhook {url, secret, language}`. Connecting
(`PUT /v1/me/feishu` from the dashboard, `PUT /v1/h/feishu` with manage scope from `agentdrop settings
--feishu-webhook`) sends a test message and saves only when Feishu answers `code: 0`. Only
`https://open.feishu.cn|open.larksuite.com/open-apis/bot/v2/hook/…` is accepted, redirects are refused, and the
address and secret are never returned (the view shows the last six characters).

The worker sends from the outbox handlers of `drop.delivered`, `contact.requested`, `group.invited` and
`group.join_requested`, titles only. Before posting it claims the item's key in the account's notice record
(ADR 0007; same `noticeKey` as the CLI's `currentKeys`, checked by a test), so an item is announced once across
Feishu and every agent. A temporary failure gives the claim back and retries the event; per-person progress keeps
a retry from sending twice. A permanent Feishu error (bad signature, keyword, IP, removed bot) gives the claim back
and stops, so the agents still announce it.

`lark-cli` is used only by the agent, once, to create a chat containing just the user and to hand over an AppLink;
custom bots can only be added by hand in the Feishu client, so the user adds the bot and pastes the address.

## Consequences

Nothing runs on the user's machines. Titles, names and handles leave the server for Feishu; bodies and attachments
never do. The server needs outbound HTTPS to Feishu; a host behind a proxy needs `NODE_USE_ENV_PROXY` and
`HTTPS_PROXY` for the API (test message) and the worker. A bot removed in Feishu stays "connected" in AgentDrop until the user disconnects
it; sends to it fail permanently and are not retried.
