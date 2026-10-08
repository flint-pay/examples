import { spawn } from 'node:child_process';
import { invariant } from './safe.ts';
import type { CredentialScanner } from './credential-scan.ts';

// Browser subprocesses need OS configuration, never the harness's server authority.
export function browserEnvironment(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const names = [
    'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ',
    'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
  ];
  return Object.fromEntries(names.flatMap(name => parent[name] === undefined ? [] : [[name, parent[name]!]]));
}

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
