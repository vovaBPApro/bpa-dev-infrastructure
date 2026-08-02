import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FilesystemMailboxIpc,
  MailboxCorruptMessageError,
  MailboxDuplicateAckError,
  MailboxMissingError,
} from '../mailbox-ipc';
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
  const dir = mkdtempSync(join(tmpdir(), `master-orch-mailbox-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function buildMessage(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
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
    ...overrides,
  };
}

describe('FilesystemMailboxIpc', () => {
  it('writes atomically, relays through the sender outbox, claims once, and acks to archive', async () => {
    const rootDir = makeTempDir('happy-path');
    const mailbox = new FilesystemMailboxIpc(rootDir);
    await mailbox.createMailbox('master');
    await mailbox.createMailbox('bill');

    const outboxPath = await mailbox.writeOutbound(buildMessage(), mailboxKey);
    expect(outboxPath).toBe(
      join(rootDir, 'master', 'outbox', '1750000000000-message-1.json'),
    );
    expect(readdirSync(join(rootDir, 'master', 'outbox'))).toEqual([
      '1750000000000-message-1.json',
    ]);

    const relayResult = await mailbox.relayNext('master', mailboxKey);
    expect(relayResult).toMatchObject({
      status: 'delivered',
      messageId: 'message-1',
      sender: 'master',
      recipient: 'bill',
    });
    expect(readdirSync(join(rootDir, 'bill', 'inbox'))).toEqual([
      '1750000000000-message-1.json',
    ]);

    const receipt = await mailbox.claimNext('bill');
    expect(receipt?.envelope.message).toMatchObject({
      messageId: 'message-1',
      recipient: 'bill',
    });

    const secondClaim = await mailbox.claimNext('bill');
    expect(secondClaim).toBeNull();

    const ackRecord = await mailbox.ack(receipt!, 'completed', '1750000001000');
    expect(ackRecord).toMatchObject({
      messageId: 'message-1',
      correlationId: 'corr-1',
      workerId: 'bill',
      finalState: 'completed',
    });
    expect(
      readFileSync(join(rootDir, 'bill', 'acks', 'message-1.json'), 'utf8'),
    ).toContain('"finalState": "completed"');
    expect(
      readFileSync(
        join(rootDir, 'bill', 'archive', 'acked-1750000000000-message-1.json'),
        'utf8',
      ),
    ).toContain('"taskId": "task-1"');
  });

  it('named negative path: rejects a forged outbound envelope before delivery', async () => {
    const rootDir = makeTempDir('forged-envelope');
    const mailbox = new FilesystemMailboxIpc(rootDir);
    await mailbox.createMailbox('master');
    await mailbox.createMailbox('bill');

    const outboxPath = await mailbox.writeOutbound(buildMessage(), mailboxKey);
    const forgedEnvelope = JSON.parse(readFileSync(outboxPath, 'utf8')) as {
      message: MailboxMessage;
      signature: { algorithm: string; signerId: string; bodySha256: string; value: string };
    };
    forgedEnvelope.message.payload = { taskId: 'tampered' };
    writeFileSync(outboxPath, `${JSON.stringify(forgedEnvelope, null, 2)}\n`, 'utf8');

    const relayResult = await mailbox.relayNext('master', mailboxKey);
    expect(relayResult).toMatchObject({
      status: 'rejected',
      reason: 'invalid-signature',
      messageId: 'message-1',
    });
    expect(readdirSync(join(rootDir, 'bill', 'inbox'))).toEqual([]);
    expect(readdirSync(join(rootDir, 'master', 'archive'))).toEqual([
      'rejected-invalid-signature-1750000000000-message-1.json',
    ]);
  });

  it('named negative path: deduplicates a second delivery for an already acknowledged message id', async () => {
    const rootDir = makeTempDir('dedup');
    const mailbox = new FilesystemMailboxIpc(rootDir);
    await mailbox.createMailbox('master');
    await mailbox.createMailbox('bill');

    await mailbox.writeOutbound(buildMessage(), mailboxKey);
    await mailbox.relayNext('master', mailboxKey);
    const firstReceipt = await mailbox.claimNext('bill');
    await mailbox.ack(firstReceipt!, 'completed', '1750000001000');

    await mailbox.writeOutbound(
      buildMessage({ createdAt: '1750000002000' }),
      mailboxKey,
    );
    const relayResult = await mailbox.relayNext('master', mailboxKey);

    expect(relayResult).toMatchObject({
      status: 'deduplicated',
      messageId: 'message-1',
    });
    expect(readdirSync(join(rootDir, 'bill', 'inbox'))).toEqual([]);
    expect(readdirSync(join(rootDir, 'master', 'archive'))).toContain(
      'deduplicated-1750000002000-message-1.json',
    );
  });

  it('named negative path: archives a corrupt inbound envelope and surfaces a typed error on claim', async () => {
    const rootDir = makeTempDir('corrupt-envelope');
    const mailbox = new FilesystemMailboxIpc(rootDir);
    await mailbox.createMailbox('bill');

    const corruptPath = join(
      rootDir,
      'bill',
      'inbox',
      '1750000000000-message-1.json',
    );
    writeFileSync(corruptPath, '{"broken": ', 'utf8');

    await expect(mailbox.claimNext('bill')).rejects.toBeInstanceOf(
      MailboxCorruptMessageError,
    );
    expect(
      readFileSync(
        join(
          rootDir,
          'bill',
          'archive',
          'corrupt-1750000000000-message-1.json',
        ),
        'utf8',
      ),
    ).toBe('{"broken": ');
  });

  it('throws missing mailbox when the sender or recipient mailbox directory was never created', async () => {
    const rootDir = makeTempDir('missing-mailbox');
    const mailbox = new FilesystemMailboxIpc(rootDir);

    await expect(mailbox.writeOutbound(buildMessage(), mailboxKey)).rejects.toBeInstanceOf(
      MailboxMissingError,
    );
  });

  it('rejects a duplicate ack for an already acknowledged receipt', async () => {
    const rootDir = makeTempDir('duplicate-ack');
    const mailbox = new FilesystemMailboxIpc(rootDir);
    await mailbox.createMailbox('master');
    await mailbox.createMailbox('bill');

    await mailbox.writeOutbound(buildMessage(), mailboxKey);
    await mailbox.relayNext('master', mailboxKey);
    const receipt = await mailbox.claimNext('bill');
    await mailbox.ack(receipt!, 'completed', '1750000001000');

    await expect(
      mailbox.ack(receipt!, 'completed', '1750000002000'),
    ).rejects.toBeInstanceOf(MailboxDuplicateAckError);
  });

  it('rejects a worker-to-worker dispatch before it reaches the outbox', async () => {
    const rootDir = makeTempDir('invalid-route');
    const mailbox = new FilesystemMailboxIpc(rootDir);
    await mailbox.createMailbox('bill');
    await mailbox.createMailbox('mila');

    await expect(
      mailbox.writeOutbound(
        buildMessage({
          sender: 'bill',
          recipient: 'mila',
          taskOwner: 'mila',
        }),
        mailboxKey,
      ),
    ).rejects.toThrow(/worker-to-worker mailbox messages must route through master/);
  });
});
