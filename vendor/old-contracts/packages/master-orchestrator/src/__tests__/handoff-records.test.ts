import {
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileHandoffRecordStore,
  findStaleMailboxEntries,
  reconstructHandoffAudit,
  selectArchiveBundles,
  selectHandoffRecordsForPrune,
} from '../handoff-records';
import { bootstrapMailboxTree } from '../mailbox-bootstrap';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `master-orch-handoff-${name}-`));
  tempDirs.push(dir);
  return dir;
}

describe('FileHandoffRecordStore', () => {
  it('appends records without overwriting the existing audit trail', async () => {
    const rootDir = makeTempDir('append');
    const store = new FileHandoffRecordStore(rootDir);

    const path = await store.append({
      correlationId: 'corr-1',
      messageId: 'message-1',
      messageType: 'dispatch',
      taskOwner: 'bill',
      sender: 'master',
      recipient: 'bill',
      recordedAt: '1750000000000',
      summary: 'Dispatch to Bill',
      artifactRefs: [],
    });
    await store.append({
      correlationId: 'corr-1',
      messageId: 'message-2',
      messageType: 'status',
      taskOwner: 'bill',
      sender: 'bill',
      recipient: 'master',
      recordedAt: '1750000001000',
      summary: 'Bill completed the task',
      artifactRefs: ['artifact://bill/report'],
    });

    const audit = await reconstructHandoffAudit(rootDir, 'corr-1');
    expect(path).toBe(join(rootDir, 'corr-1.jsonl'));
    expect(audit).toHaveLength(2);
    expect(audit[0]?.messageId).toBe('message-1');
    expect(audit[1]?.artifactRefs).toEqual(['artifact://bill/report']);
  });

  it('selects stale queues, archive bundles, and prune candidates', async () => {
    const rootDir = makeTempDir('retention');
    await bootstrapMailboxTree(rootDir, { workerIds: ['master', 'bill'] });
    const handoffDir = join(rootDir, 'master', 'handoff-records');
    const store = new FileHandoffRecordStore(handoffDir);
    const now = Date.now();
    const oldSeconds = (now - 10 * 24 * 60 * 60 * 1000) / 1000;

    writeFileSync(
      join(rootDir, 'bill', 'inbox', '1750000000000-message-1.json'),
      '{}\n',
      'utf8',
    );
    utimesSync(
      join(rootDir, 'bill', 'inbox', '1750000000000-message-1.json'),
      oldSeconds,
      oldSeconds,
    );

    writeFileSync(
      join(rootDir, 'bill', 'archive', 'acked-1750000000000-message-1.json'),
      '{}\n',
      'utf8',
    );
    utimesSync(
      join(rootDir, 'bill', 'archive', 'acked-1750000000000-message-1.json'),
      oldSeconds,
      oldSeconds,
    );

    await store.append({
      correlationId: 'corr-prune',
      messageId: 'message-prune',
      messageType: 'handoff_record',
      taskOwner: 'master',
      sender: 'master',
      recipient: 'master',
      recordedAt: '1750000000000',
      summary: 'Old record',
      artifactRefs: [],
    });
    utimesSync(join(handoffDir, 'corr-prune.jsonl'), oldSeconds, oldSeconds);

    const staleEntries = await findStaleMailboxEntries({
      rootDir,
      workerIds: ['master', 'bill'],
      now,
      staleAfterMs: 24 * 60 * 60 * 1000,
    });
    const bundles = await selectArchiveBundles({
      rootDir,
      workerIds: ['master', 'bill'],
      now,
      olderThanMs: 24 * 60 * 60 * 1000,
    });
    const pruneCandidates = await selectHandoffRecordsForPrune({
      rootDir: handoffDir,
      now,
      retentionMs: 24 * 60 * 60 * 1000,
    });

    expect(staleEntries).toHaveLength(1);
    expect(staleEntries[0]?.queue).toBe('inbox');
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.workerId).toBe('bill');
    expect(pruneCandidates).toEqual([join(handoffDir, 'corr-prune.jsonl')]);
  });
});
