import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Sets or removes NAME=value lines in a .env file and leaves every other line alone. Secrets go to the file,
 * never to the terminal. The file is readable by its owner only.
 */
export function updateEnvFile(path: string, values: Record<string, string | null>) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  if (lines.at(-1) === '') lines.pop();
  const pending = new Map(Object.entries(values));
  const output: string[] = [];
  for (const line of lines) {
    const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (name === undefined || !pending.has(name)) {
      output.push(line);
      continue;
    }
    const value = pending.get(name);
    pending.delete(name);
    if (value !== null) output.push(`${name}=${value}`);
  }
  for (const [name, value] of pending) if (value !== null) output.push(`${name}=${value}`);
  writeFileSync(path, `${output.join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
