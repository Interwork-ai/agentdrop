# 0039. Feishu notices as cards from the server's own Feishu app, to a linked account

- Status: Accepted
- Date: 2026-10-25
- Refines: ADR 0009 (Feishu group-bot notices), ADR 0005 (explicit read state), ADR 0017 (seen in an agent)

## Context

ADR 0009 posts a one-line notice into a Feishu group through a custom bot the person adds by hand and whose address
they paste. It works without any operator setup, but the notice is text in a group: nothing can be done from it,
it never changes after it was sent, and setting it up takes a group, a bot and a pasted secret per person.

Feishu's self-built apps (企业自建应用) can send a person interactive cards in a direct chat, receive button presses
and messages over an outbound WebSocket (长连接, so a server with no public HTTPS endpoint works), and update a card
they sent within 14 days. Each self-hosted AgentDrop server would use its operator's own app.

## Decision

- **Operator setting.** `FEISHU_APP_ID` and `FEISHU_APP_SECRET` (no default; the feature is off without them),
  `FEISHU_DOMAIN` `feishu` (default, open.feishu.cn) or `lark` (open.larksuite.com). The app needs the bot
  capability, `im:message:send_as_bot`, the message-receive event (`im.message.receive_v1`) and the card callback
  (`card.action.trigger`), both in long-connection mode. docs/FEISHU.md lists the steps.
- **Linking an account, by code.** In the dashboard the person asks for a one-time code (8 characters, 10 minutes,
  single use, stored only as a hash) and sends it to the app's bot in a direct chat; the worker, holding the
  WebSocket, links that Feishu user (`open_id` within this app, plus `union_id` and tenant) to the account and
  answers with a card. No OAuth redirect is needed, and the person's first message is what Feishu requires before
  a bot may write to them. One Feishu user links one account and an account links one Feishu user; a new link
  replaces the old one. "unlink" / "解绑" sent to the bot, Disconnect in the dashboard and closing the account remove
  it. Codes are refused after five wrong tries per Feishu user per hour.
- **Notices become cards.** For a linked person the worker sends each notice as a card in the direct chat instead
  of the group-bot message: the same line in the same words as browser push and the group bot (ADR 0009, product
  principle 11: kind, group, person, mention, reply or the progress a reply gives, title; never body or files),
  plus buttons. A linked account takes the group bot's place, so one item is posted once; the group bot keeps
  working for people who did not link. The claim in the account's notice record (ADR 0007/0009) is unchanged.
- **Buttons.** A drop card has "Mark read", "Star" and "Open in AgentDrop" (a dashboard link); request cards have
  only "Open". A press arrives as `card.action.trigger`; the worker maps the presser's `open_id` to the linked
  account (a press by anyone else does nothing), checks the drop through the same authorization as the dashboard,
  applies the ordinary explicit state change for that person (ADR 0005: one state per person, version bump and
  mailbox events), and answers with the updated card. A press is the person acting where they are, like opening a
  drop in the dashboard. Receiving or seeing a card is not "shown in an agent" (ADR 0017 unchanged).
- **Cards follow the state.** The worker remembers which card it sent for which drop (`feishu_cards`, 14 days).
  Every minute it checks the cards still showing unread, and turns those whose drop the person has read elsewhere
  (dashboard, agent, terminal) into the read form.
- **Nothing received is trusted.** Text sent to the bot is matched only against a code or the unlink words; it is
  never stored, never turned into a drop and never shown to a model. Inbound replies from Feishu are not part of
  this decision.

## Consequences

- An operator creates one Feishu app per server; people then link in two steps and act on notices in Feishu.
- Titles, names and handles leave the server for Feishu as before (ADR 0009); bodies and files still never do.
- A free Feishu tenant has a monthly API quota for self-built apps; each notice is one call, each card update one
  more, plus token refreshes. When Feishu refuses with its quota code the worker leaves the item for the agents.
- The worker keeps one WebSocket per process; with several workers Feishu hands each event to one of them.
- Not in this decision: replying from Feishu, exporting a drop to a Feishu document, link previews, and DingTalk or
  WeCom, which reuse the same shape later.
