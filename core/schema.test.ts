import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { DurableStore, FencedTransitionError, type CreateLaneInput } from "./schema";

const paths = new Set<string>();
let serial = 0;
const open = (now = 1_000) => {
  const path = `/tmp/v3-schema-${process.pid}-${serial++}.sqlite`;
  paths.add(path);
  return { store: new DurableStore(path, { now: () => now }), path };
};

afterEach(() => {
  for (const path of paths) for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) rmSync(path + suffix);
  paths.clear();
});

const lane = (overrides: Partial<CreateLaneInput> = {}): CreateLaneInput => ({
  id: "lane-1", missionId: "mission-1", managerId: "manager-1", parentId: "manager-1",
  depth: 2, retryBudget: 2, acceptanceId: "accept-1", ...overrides,
});

describe("v3 durable hierarchy contract", () => {
  test("persists mission, manager and lane parentage with required evidence fields", () => {
    const { store } = open();
    store.createMission({ id: "mission-1", correlationId: "corr-1", acceptanceId: "mission-accept" });
    store.createManager({ id: "manager-1", missionId: "mission-1", parentId: "mission-1", depth: 1 });
    const created = store.createLane(lane());
    expect(created).toMatchObject({ parentId: "manager-1", depth: 2, generation: 0, retryBudget: 2, acknowledgementAt: null, semanticEvidencePath: null, terminalSha: null, terminalReportPath: null, terminalVerdict: null });
    expect(store.reconstruct().lanes).toHaveLength(1);
    store.close();
  });

  test("fences stale owners across claim, acknowledgement, progress and terminal transition", () => {
    const { store } = open();
    store.createMission({ id: "mission-1", correlationId: "corr-1", acceptanceId: "mission-accept" });
    store.createManager({ id: "manager-1", missionId: "mission-1", parentId: "mission-1", depth: 1 });
    store.createLane(lane());
    const first = store.claimLane("lane-1", "dispatcher-a", 100);
    expect(first.fencingToken).toBe(1);
    expect(() => store.claimLane("lane-1", "dispatcher-b", 100)).toThrow(FencedTransitionError);
    store.close();

    const restarted = new DurableStore(store.path, { now: () => 1_101 });
    const second = restarted.claimLane("lane-1", "dispatcher-b", 100);
    expect(second.fencingToken).toBe(2);
    expect(() => restarted.acknowledgeLane("lane-1", "dispatcher-a", 1)).toThrow(FencedTransitionError);
    restarted.acknowledgeLane("lane-1", "dispatcher-b", 2);
    restarted.recordSemanticProgress("lane-1", "dispatcher-b", 2, "/evidence/progress.json");
    restarted.completeLane("lane-1", "dispatcher-b", 2, { sha: "a".repeat(40), reportPath: "/reports/lane-1.md", verdict: "clean" });
    expect(restarted.getLane("lane-1")).toMatchObject({ generation: 1, semanticEvidencePath: "/evidence/progress.json", terminalVerdict: "clean" });
    restarted.close();
  });

  test("reconstructs active ownership and pending outbox after restart", () => {
    const { store, path } = open();
    store.createMission({ id: "mission-1", correlationId: "corr-1", acceptanceId: "mission-accept" });
    store.createManager({ id: "manager-1", missionId: "mission-1", parentId: "mission-1", depth: 1 });
    store.createLane(lane());
    store.claimLane("lane-1", "dispatcher-a", 500);
    const message = store.enqueueOutbox({ id: "msg-1", channel: "telegram", dedupeKey: "lane-1:no-go", payload: { verdict: "NO-GO" } });
    expect(message.deliveryState).toBe("pending");
    store.close();

    const restarted = new DurableStore(path, { now: () => 1_100 });
    const snapshot = restarted.reconstruct();
    expect(snapshot.lanes[0]).toMatchObject({ leaseOwner: "dispatcher-a", fencingToken: 1, leaseDeadlineAt: 1_500 });
    expect(snapshot.outbox[0]).toMatchObject({ id: "msg-1", deliveryState: "pending", attempts: 0 });
    restarted.markOutboxAttempt("msg-1", "failed", "network");
    restarted.markOutboxAttempt("msg-1", "delivered");
    expect(restarted.reconstruct().outbox[0]).toMatchObject({ deliveryState: "delivered", attempts: 2, lastError: null });
    restarted.close();
  });

  test("rejects invalid hierarchy and terminal evidence", () => {
    const { store } = open();
    store.createMission({ id: "mission-1", correlationId: "corr-1", acceptanceId: "mission-accept" });
    store.createManager({ id: "manager-1", missionId: "mission-1", parentId: "mission-1", depth: 1 });
    expect(() => store.createLane(lane({ depth: 3 }))).toThrow("depth");
    store.createLane(lane());
    const claim = store.claimLane("lane-1", "dispatcher-a", 100);
    expect(() => store.completeLane("lane-1", "dispatcher-a", claim.fencingToken, { sha: "bad", reportPath: "", verdict: "clean" })).toThrow();
    store.close();
  });
});
