import { readFile, readdir, readlink, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { invariant } from './safe.ts';

export function parseStatus(text: string): { uid: number; effectiveUid: number; parent: number } {
  const uid = /^Uid:\s+(\d+)\s+(\d+)/m.exec(text), parent = /^PPid:\s+(\d+)/m.exec(text);
  invariant(uid && parent, 'PROC_STATUS_INVALID');
  return { uid: Number(uid[1]), effectiveUid: Number(uid[2]), parent: Number(parent[1]) };
}
export function parseStartTicks(text: string): number {
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  const ticks = Number(fields[19]);
  invariant(fields.length >= 20 && /^\d+$/.test(fields[19]) && Number.isSafeInteger(ticks), 'PROC_STAT_INVALID');
  return ticks;
}
export function parseCmdline(value: Buffer): string[] {
  invariant(value.length > 0 && value.at(-1) === 0, 'PROC_CMDLINE_INVALID');
  return value.toString('utf8').slice(0, -1).split('\0');
}
export function listeningInodes(text: string, port: number): Set<string> {
  const found = new Set<string>();
  for (const line of text.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/), local = fields[1]?.split(':');
    if (fields[3] === '0A' && local && parseInt(local.at(-1)!, 16) === port && /^\d+$/.test(fields[9] ?? '')) found.add(fields[9]);
  }
  return found;
}
export class Procfs {
  readonly root: string;
  constructor(root = '/proc') { this.root = root; }
  async available(): Promise<boolean> { try { return (await stat(join(this.root, 'stat'))).isFile(); } catch { return false; } }
  async process(pid: number) {
    const dir = join(this.root, String(pid));
    const [status, command, stats, boot, cwd, fds, executable] = await Promise.all([
      readFile(join(dir, 'status'), 'utf8'), readFile(join(dir, 'cmdline')), readFile(join(dir, 'stat'), 'utf8'),
      readFile(join(this.root, 'stat'), 'utf8'), realpath(join(dir, 'cwd')), this.socketInodes(pid), realpath(join(dir, 'exe')),
    ]);
    const btime = /^btime (\d+)$/m.exec(boot); invariant(btime, 'PROC_BOOT_TIME_INVALID');
    return { ...parseStatus(status), command: parseCmdline(command), cwd, executable, startedAt: Number(btime[1]) * 1000 + parseStartTicks(stats) * 10, sockets: fds };
  }
  async socketInodes(pid: number): Promise<Set<string>> {
    const dir = join(this.root, String(pid), 'fd'), found = new Set<string>();
    for (const fd of await readdir(dir)) {
      try { const match = /^socket:\[(\d+)\]$/.exec(await readlink(join(dir, fd))); if (match) found.add(match[1]); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
    return found;
  }
  async listens(pid: number, port: number): Promise<boolean> {
    const sockets = await this.socketInodes(pid);
    for (const file of ['tcp', 'tcp6']) for (const inode of listeningInodes(await readFile(join(this.root, 'net', file), 'utf8'), port)) if (sockets.has(inode)) return true;
    return false;
  }
  async holds(pid: number, dev: number, ino: number): Promise<boolean> {
    const dir = join(this.root, String(pid), 'fd');
    for (const fd of await readdir(dir)) {
      try { const info = await stat(join(dir, fd)); if (info.dev === dev && info.ino === ino) return true; }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
    return false;
  }
  async holders(dev: number, ino: number, uid: number): Promise<number[]> {
    const result: number[] = [];
    for (const pid of (await readdir(this.root)).filter(p => /^\d+$/.test(p))) {
      try {
        const identity = parseStatus(await readFile(join(this.root, pid, 'status'), 'utf8'));
        if ((identity.uid === uid || identity.effectiveUid === uid) && await this.holds(Number(pid), dev, ino)) result.push(Number(pid));
      } catch (error: any) { if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error; }
    }
    return result;
  }
}
