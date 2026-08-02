import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemMailboxIpc } from '../mailbox-ipc';
import type { MailboxMessage } from '../mailbox-ipc';

const tempDirs: string[] = [];
const mailboxKey = 'mailbox-secret';

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `master-orch-replay-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function buildMessage(): MailboxMessage {
  return {
    messageId: 'message-1',
    correlationId: 'corr-1',
    causationId: null,
    sender: 'master',
    recipient: 'bill',
    taskOwner: 'bill',
    messageType: 'dispatch',
    priority: 'normal',
    createdAt: '1750000000000',
    requiresResponse: true,
    payloadVersion: 1,
    payload: { taskId: 'task-1' },
  };
}

describe('FilesystemMailboxIpc replay lock', () => {
  it('named restart-race replay lock: claims once, archives once, and ignores a replayed inbox file after restart', async () => {
    const rootDir = makeTempDir('restart-race');
    const firstMailbox = new FilesystemMailboxIpc(rootDir);
    await firstMailbox.createMailbox('master');
    await firstMailbox.createMailbox('bill');

    await firstMailbox.writeOutbound(buildMessage(), mailboxKey);
    await firstMailbox.relayNext('master', mailboxKey);
    const firstReceipt = await firstMailbox.claimNext('bill');
    await firstMailbox.ack(firstReceipt!, 'completed', '1750000001000');

    const archivedPath = join(
      rootDir,
      'bill',
      'archive',
      'acked-1750000000000-message-1.json',
    );
    const replayPath = join(
      rootDir,
      'bill',
      'inbox',
      '1750000000000-message-1.json',
    );
    copyFileSync(archivedPath, replayPath);

    const secondMailbox = new FilesystemMailboxIpc(rootDir);
    const secondReceipt = await secondMailbox.claimNext('bill');

    expect(secondReceipt).toBeNull();
    expect(readFileSync(archivedPath, 'utf8')).toContain('"taskId": "task-1"');
    expect(
      readFileSync(
        join(rootDir, 'bill', 'archive', 'deduplicated-1750000000000-message-1.json'),
        'utf8',
      ),
    ).toContain('"taskId": "task-1"');
  });
});
