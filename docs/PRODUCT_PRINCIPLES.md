# Product defaults

The project's rules of thumb for what a person expects of the product without having to ask. Each one came from a
gap found in use; apply them to every new feature and check them when reviewing a change. `AGENTS.md` (two audiences, harness parity) still
governs; these fill in what a person expects of a messaging product.

## Say what it is, where from, and from whom

1. **Every notice is classified.** A direct message, a group message, a contact request, a group invitation and an
   approval are different things and read differently: group them under their own heading, direct messages first.
2. **Name the group and the person.** "New message" is not enough; say "in group “Core team” #core, from @bob".
   A person must be able to decide whether to look without opening anything.
3. **No internal identifiers in text for people.** Drop ids, endpoint ids, request ids and hashes mean nothing to a
   person (`[de5b769a]` in a notice was the example). People find things by title and sender. Models get the full
   id, because they need it to call a tool. A terminal command that accepts an id prefix may still print one.

## Never leave a person with only a number

4. **A count comes with who.** Wherever a person or their agent sees "2 members", they can also see who
   those members are (name and @handle), under the same visibility rule. Other people's agent counts are private.
   An agent that cannot list a group's
   members cannot answer "who is in #core" and cannot address anyone in it.
5. **What a person expects to do, their agent can do.** If people naturally say "tell @bob in the group" or "what
   is Alice's email", the agent must have the data (and tool field) to do it, without a second trip to the
   dashboard.

## Good defaults, bounded

6. **Anything a person must name gets a derived default.** A group created without a name is named after its
   creator and how many were invited ("Alice +2"), its slug from the creator's handle; invitees' names are never
   used, since they have not agreed to join. The person may still type their own, and admins can change both. Required fields
   that a sensible default could fill are friction.
7. **Every name has a length cap, and derived names a shorter one.** Typed names: 64 characters (slugs 32).
   Derived names stop adding parts at 32 and summarise the rest ("+3"). Every input field in the dashboard
   carries the same `maxLength` the server enforces.
8. **One neutral spelling for shared data.** A default stored once and read by people in different languages
   (a group name) avoids words from either language: names, commas, "+N".

## Identity and visibility

9. **Person-level facts are the same on every agent of that person** (ADR 0012): the public email, nickname and
   handle read identically whichever agent sent or received.
10. **New fields never widen who sees whom.** Show a new fact only where the person is already visible (accepted
    contacts, active co-members, recipients of their drops); pending requests and strangers see nothing new.
11. **Relays say the same thing, never the body.** Browser push and Feishu carry the same facts in the same words:
    kind (direct, group, request, invitation, join request), sender nickname and @handle, group name and #slug,
    "mentioned you", "replied to «X»" (only when the person may open X themselves) and the title; never bodies
    or attachments. Web Push payloads are encrypted to the browser.
    Both record what they announced in the person's shared notice state, so nothing is announced twice.

## Every surface, every client

12. **Change one surface, check the others.** A notice exists as the Stop/idle notice, the model's prompt context,
    `agentdrop pending`, Feishu, browser push and the dashboard; the same classification and names appear on all.
13. **Both languages on every person-facing surface**, including the service worker (it reads the dashboard's
    choice from Cache Storage) and server-rendered notices.
14. **Additive and tolerant.** New result fields are optional; readers treat a missing field as "not known" and
    never fail a notice over it; responses to bridges before 0.4.11 have newer fields removed
    (`apps/api/src/plugins/old-bridge.ts`).
15. **Other accounts see people, not agents** (ADR 0013). Never reveal another person's agent inventory, tools,
    automatic addresses, signatures or receiving-agent counts, including through saved results and errors. Only
    the owner sees their own agents. A deliberately published named entry exposes its chosen name and address,
    not the agent behind it; group capacity is a status, not an endpoint total.
16. **A missing prerequisite is announced where it cannot be missed, and blocked actions say why.** Until the
    first agent is paired, every page opens with an accent banner that says what the person cannot do yet and
    gives the one command to copy (`apps/web/src/ui/needs-agent.tsx`); a disabled Join, Create or Send carries a
    one-line reason and a link to fix it. A greyed-out button with no explanation reads as broken.

## Words people see

17. **One vocabulary for people.** Every dashboard string, notice and interactive CLI line uses the same few words;
    internal names stay in code, the API and text for models (`AGENTS.md`, two audiences).

    | Say (English / 中文) | Means | Never say to a person |
    | --- | --- | --- |
    | message / 消息 | one thing sent to a person or a group | drop, Drop, handoff, 交接, delivery |
    | New message / 写消息, Send message / 发送 | writing and sending one | New handoff, Send handoff, 发起交接 |
    | group / 群, 群组 | people who receive the same messages, named “Name” #slug | channel, room |
    | contact / 联系人 | a person you accepted, or who accepted you | connection, peer |
    | My space / 我的空间 | files and notes you keep for yourself | personal drop, self-drop |
    | agent / Agent | Codex, Claude Code, opencode, Cursor or oh-my-pi paired to your account | endpoint, 端点, H, harness, route |
    | assistant / 助手 | the built-in AgentDrop assistant (@agentdrop) | bot, system user |

    A terminal command may still be called `agentdrop ack` and a tool `send_drop`: the rule is about the words
    around them, not the names a person types.
