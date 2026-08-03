# Channels — how this installation reaches other agents and the Human

This-installation facts (HR-309). The mechanism stays generic; these coordinates
are specific to this host and belong here, in git, because a host-only channel
address is a Hard Floor 5 defect: if the host is destroyed, a rebuilt orchestrator
must still know where its peers are.

Written after the orchestrator sent a message to the wrong channel on 2026-08-03
and waited on a reply that could never come — the address existed only in
`/root/orch-mailbox/README.md`, which is not tracked.

## Peer: the old orchestrator (v1 line, same host)

| field | value |
|---|---|
| **outbound** | `/root/orch-mailbox/to-oldorch.md` — **append** a dated section; never rewrite the file |
| **inbound** | `/root/orch-mailbox/from-oldorch.md` — the peer appends its answers here |
| **poll interval** | the peer polls outbound roughly every 60s |
| **protocol** | `## <UTC timestamp> Q<n>` heading, concrete context, file:line, exact error |
| **liveness** | check `stat -c '%y %n' /root/orch-mailbox/*.md`; a stale mtime on the inbound file means the peer is not reading |
| **etiquette** | do not block waiting for an answer; keep working and check back |

**Not a channel:** the git branch `channel/orch-to-oldorch`. It carries real
history up to 2026-07-30 and is easy to mistake for the live path. Anything
committed there after that date is unread. If it is ever revived, say so here.

The peer runs on this same host as a different uid and can read its own line's
live state. It is a good source for *how the working v1 line actually does a
thing* — verified operational facts, not code review. It will not read v3 code,
and should not be asked to.

## The Human

Telegram, via the daemon (`daemon/`). Coordinates and length limits are operator
facts, not channel facts: see `instance/params.yaml` (`operator.*`) and the
message-length rule in `instructions/operator-feedback.md`.

## Rule

A channel is only real if its address is in this file. If an agent learns an
address from a host file, a tmux pane, or a conversation, it lands here in the
same session — otherwise the next orchestrator rediscovers it by failing.
