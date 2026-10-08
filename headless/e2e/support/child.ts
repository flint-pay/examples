import { spawn } from 'node:child_process';
import { invariant } from './safe.ts';
import type { CredentialScanner } from './credential-scan.ts';

// Child output is scanned and discarded at capture. Do not echo even redacted URLs.
export function spawnChild(command: string, args: string[], cwd: string, scanner: CredentialScanner, env: NodeJS.ProcessEnv,observeOutput?:(stream:'stdout'|'stderr',chunk:string)=>void) {
  const child = spawn(command, args, { cwd, env: { PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`, NODE_NO_WARNINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  for (const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]] as const) {
    let tail = '';
    stream.on('data', chunk => { observeOutput?.(name,String(chunk));const text = tail + String(chunk); scanner.scan(text, 'child'); tail = text.slice(-4096); });
  }
  return child;
}
export async function runChild(command: string, args: string[], cwd: string, scanner: CredentialScanner, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawnChild(command, args, cwd, scanner, env);
  let interrupted = false;
  const stop = () => { interrupted = true; if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const result = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    scanner.assertClean(); invariant(result === 0 && !interrupted, 'CHILD_CHECK_FAILED');
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
