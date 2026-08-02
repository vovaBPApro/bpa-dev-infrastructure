import { hostname } from 'node:os';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

type LockOwner = {
  token: string;
  pid: number;
  hostname: string;
  leaseExpiresAt: number;
};

const LEASE_MS = 2_000;
const ACQUIRE_TIMEOUT_MS = 5_000;

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(`${lockPath}/owner.json`, 'utf8')) as LockOwner;
    return typeof value.token === 'string' && typeof value.leaseExpiresAt === 'number' ? value : null;
  } catch {
    return null;
  }
}

function ownerIsAlive(owner: LockOwner): boolean {
  if (owner.hostname !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeOwner(lockPath: string, owner: LockOwner): Promise<void> {
  const temporary = `${lockPath}/owner.${owner.token}.tmp`;
  await writeFile(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await rename(temporary, `${lockPath}/owner.json`);
}

export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const token = crypto.randomUUID();
  const owner: LockOwner = { token, pid: process.pid, hostname: hostname(), leaseExpiresAt: 0 };
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      owner.leaseExpiresAt = Date.now() + LEASE_MS;
      await writeOwner(lockPath, owner);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const incumbent = await readOwner(lockPath);
      const missingOwnerIsStale = !incumbent && await stat(lockPath)
        .then((entry) => Date.now() - entry.mtimeMs >= LEASE_MS)
        .catch(() => false);
      if (missingOwnerIsStale || (incumbent && (incumbent.leaseExpiresAt <= Date.now() || !ownerIsAlive(incumbent)))) {
        const stalePath = `${lockPath}.stale.${token}`;
        try {
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        } catch (takeoverError) {
          if ((takeoverError as NodeJS.ErrnoException).code !== 'ENOENT') throw takeoverError;
        }
      }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring lock: ${lockPath}`);
      await Bun.sleep(5);
    }
  }
  const heartbeat = setInterval(() => {
    owner.leaseExpiresAt = Date.now() + LEASE_MS;
    void readOwner(lockPath).then((current) => {
      if (current?.token === token) return writeOwner(lockPath, owner);
    });
  }, LEASE_MS / 3);
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    const current = await readOwner(lockPath);
    if (current?.token === token) await rm(lockPath, { recursive: true, force: true });
  }
}
