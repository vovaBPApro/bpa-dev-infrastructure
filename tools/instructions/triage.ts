#!/usr/bin/env bun
// Supported operator-inbox triage actions. This records an orchestrator's
// judgement; it never attempts to classify Human words itself.
import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalSecretPattern,
  readJsonl,
  validateTriageRow,
  type InboxRow,
  type TriageRow,
} from "./ledger.ts";

export const SURFACE_AT_MS = 20 * 60 * 60 * 1000;

type Surface = { msgId: string; ageMs: number; text: string; kind: "untriaged" | "answer-owed" };

function paths(repo: string) {
  const dir = join(repo, "instance", "decisions");
  return { inbox: join(dir, "inbox.jsonl"), triage: join(dir, "triage.jsonl") };
}

function load(repo: string) {
  const p = paths(repo);
  const inbox = existsSync(p.inbox) ? readJsonl<InboxRow>(p.inbox, "instance/decisions/inbox.jsonl").rows.map((r) => r.value) : [];
  const triage = existsSync(p.triage) ? readJsonl<TriageRow>(p.triage, "instance/decisions/triage.jsonl").rows.map((r) => r.value) : [];
  return { p, inbox, triage };
}

export function surfaceTriage(repo: string, nowMs = Date.now()): Surface[] {
  const { inbox, triage } = load(repo);
  const byId = new Map(triage.map((row) => [String(row.msg_id), row]));
  const result: Surface[] = [];
  for (const row of inbox) {
    const id = String(row.msg_id);
    if (existsSync(join(repo, "instance", "decisions", `HR-${id}.md`))) continue;
    const verdict = byId.get(id);
    const ageMs = nowMs - Date.parse(row.ts);
    if (!Number.isFinite(ageMs)) continue;
    const text = typeof row.text === "string" ? row.text : "";
    if (!verdict && ageMs >= SURFACE_AT_MS) result.push({ msgId: id, ageMs, text, kind: "untriaged" });
  }
  for (const verdict of triage) {
    if (!(verdict.answer_status === "owed" || (!verdict.answer_status && verdict.reason.startsWith("open-owed-answer")))) continue;
    const inbound = inbox.find((row) => String(row.msg_id) === String(verdict.msg_id));
    const ageMs = inbound ? nowMs - Date.parse(inbound.ts) : 0;
    result.push({ msgId: String(verdict.msg_id), ageMs: Number.isFinite(ageMs) ? ageMs : 0, text: verdict.quote, kind: "answer-owed" });
  }
  return result;
}

function assertRow(repo: string, row: TriageRow): void {
  const invalid = validateTriageRow(row, 1);
  if (invalid) throw new Error(invalid.detail);
  if (row.answer_status === undefined) throw new Error("answer_status is required for new verdicts");
  const pattern = canonicalSecretPattern(repo);
  if (!pattern) throw new Error("canonical secret scanner missing");
  if (new RegExp(pattern).test(row.quote)) throw new Error("verbatim quote contains secret-shaped content");
}

export function appendVerdict(repo: string, input: Omit<TriageRow, "quote">): void {
  const { p, inbox, triage } = load(repo);
  const id = String(input.msg_id);
  if (triage.some((row) => String(row.msg_id) === id)) throw new Error(`msg ${id} already has a verdict`);
  const inbound = inbox.find((row) => String(row.msg_id) === id);
  if (!inbound || typeof inbound.text !== "string" || inbound.text.length === 0) throw new Error(`msg ${id} is absent from inbox or has no text`);
  const row: TriageRow = { ...input, quote: inbound.text };
  assertRow(repo, row);
  appendFileSync(p.triage, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function dischargeAnswer(repo: string, msgId: string): void {
  const { p, triage } = load(repo);
  const index = triage.findIndex((row) => String(row.msg_id) === msgId);
  if (index < 0) throw new Error(`msg ${msgId} has no verdict`);
  if (!(triage[index].answer_status === "owed" || (!triage[index].answer_status && triage[index].reason.startsWith("open-owed-answer")))) throw new Error(`msg ${msgId} does not owe an answer`);
  triage[index] = { ...triage[index], answer_status: "answered" };
  assertRow(repo, triage[index]);
  const temp = `${p.triage}.tmp-${process.pid}`;
  writeFileSync(temp, triage.map((row) => JSON.stringify(row)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temp, p.triage);
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const command = args.shift();
    const repo = resolve(args.includes("--repo") ? option(args, "--repo") : process.cwd());
    if (command === "surface") {
      const now = args.includes("--now-ms") ? Number(option(args, "--now-ms")) : Date.now();
      for (const item of surfaceTriage(repo, now)) {
        const hours = (item.ageMs / 3_600_000).toFixed(1);
        process.stdout.write(`TRIAGE ${item.kind} msg=${item.msgId} age=${hours}h message=${JSON.stringify(item.text)}\n`);
      }
    } else if (command === "append") {
      appendVerdict(repo, {
        msg_id: option(args, "--msg-id"), verdict: option(args, "--verdict"),
        category: option(args, "--category"), reason: option(args, "--reason"),
        triaged_by: option(args, "--triaged-by"), triaged_at: option(args, "--triaged-at"),
        answer_status: option(args, "--answer-status") as "answered" | "owed",
      });
    } else if (command === "discharge") dischargeAnswer(repo, option(args, "--msg-id"));
    else throw new Error("usage: triage.ts surface|append|discharge [options]");
  } catch (error) {
    process.stderr.write(`triage: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
