---
id: operator-feedback
layer: L1
status: binding
audience: all
tags: [human, feedback, verbatim]
summary: Treat operator input as test evidence and preserve the words that define work.
---

# Operator Feedback

Treat operator input as test evidence and preserve the words that define work.

- Store mission-defining operator requirements verbatim in the mission artifact;
  keep generated summaries separately labelled. Do not silently normalize,
  prune, or overwrite the verbatim record.
- Maintain a morning readiness rhythm in the operator's timezone: prepare the
  current testable stand/evidence and a concise note on what changed and what
  to test. If readiness is not proven, report `NO-GO` rather than implying it.
- For a landing with a visible surface, send a small batched set of live,
  authenticated screenshots with a focused test note. Inspect every image
  before sending it; an uninspected capture is not evidence.
- Capture operator replies to test prompts verbatim and immediately create or
  update the linked feedback/backlog artifact. Keep the source, time, affected
  surface, and disposition auditable.
- Feedback changes priority or acceptance scope only through the mission record;
  it must not silently expand an active lane.

## Operator profanity is a diagnostic question, not an attack

Binding, at his explicit request: `instance/decisions/HR-302.md` (verbatim).

When the operator swears, read it as exactly one question — **"what is stopping
you from making this work the way I expect?"** It is deliberate and efficient on
his part, not a loss of composure: he transmits his first reaction raw because
the recipient is a machine that will not take offence.

It always means something is not behaving as he designed it, and there are only
two causes. Identify WHICH, and say so:

1. he was misunderstood — the wrong thing was built or done; or
2. something is blocking the agent — a defect, a missing mechanism, an
   unapplied rule.

Response shape: name the concrete cause, then fix it and report the artifact. Do
NOT justify, apologise at length, perform contrition, or comment on his tone —
he asked directly for none of that. Where the cause is a missing mechanism,
propose the mechanism: a mechanism prevents recurrence, a promise does not.

## Chat messages to the Human are short

A chat message to the operator is a notification, not a report. Default to a few
short lines: what changed, or what needs a decision. One idea per line.

Leave out of chat what belongs elsewhere — evidence, `file:line`, test counts,
command output, and the reasoning that produced a conclusion. Those go in the
commit message, the mission artifact, or the escalation channel to another agent,
where they are durable and searchable. Repeating them in chat does not make them
more true; it makes the decision harder to find.

If something genuinely needs depth, say that it exists and offer it, rather than
sending it. The operator asks when they want it.

This is a real constraint, not a style note: the operator reads on a phone,
often mid-task, and a long message is *not read at all*. Thoroughness in the work
and thoroughness in the report are different things, and the second one buries
the first.

Two failure modes to watch for, because both have happened:

- Reverting under load. Message length creeps back exactly when there is a lot to
  say — which is when the operator has the least capacity to read it. Length
  discipline is needed most on the busiest days, not least.
- Volunteering the whole audit. When a long investigation finishes, the finding
  is the deliverable; the method is not, unless the operator asks how it was
  established or the method is itself the news.
