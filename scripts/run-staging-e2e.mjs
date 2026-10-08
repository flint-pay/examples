import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../headless/e2e/support/config.ts';
import { verifyBuilds, verifyApiBuild } from '../headless/e2e/support/build.ts';
import { verifySourceCheckout } from '../headless/e2e/support/source.ts';
import { CredentialScanner } from '../headless/e2e/support/credential-scan.ts';

export function startPrivateChild(script, args, env, scanner) {
  const child = spawn(process.execPath, [script, ...args], {
    env, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    // A tracked process group lets teardown stop only this task's descendants.
    detached: process.platform !== 'win32',
  });
  for (const stream of [child.stdout, child.stderr]) {
    let tail = '';
    stream.on('data', chunk => {
      const value = tail + String(chunk); scanner.scan(value, 'child'); tail = value.slice(-4096);
    });
  }
  let failed = false;
  const done = new Promise(resolve => {
    child.once('error', () => { failed = true; });
    child.once('close', (code, signal) => resolve({ code, signal, failed }));
  });
  return { done,
    running: () => !failed && child.exitCode === null && child.signalCode === null,
    stop: signal => {
      try { if (signal === 'SIGKILL' && child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    },
  };
}

async function stopOwned(child, timeout) {
  if (!child) return true;
  child.stop('SIGTERM');
  let timer;
  const result = await Promise.race([child.done, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); })]);
  clearTimeout(timer);
  if (result) return result.code === 0 && !result.failed;
  child.stop('SIGKILL');
  await Promise.race([child.done, new Promise(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
  clearTimeout(timer);
  return false;
}

export async function runStagingLifecycle(mode, env = process.env, dependencies = {}) {
  const start = dependencies.start ?? startPrivateChild;
  let apps, suite, scanner, success = false, interrupted = false;
  const stop = () => { interrupted = true; suite?.stop('SIGTERM'); apps?.stop('SIGTERM'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    if (!['e2e', 'browser:storefront', 'browser:account', 'integration:storefront', 'integration:account'].includes(mode)) return false;
    const config = (dependencies.loadConfig ?? loadConfig)(env, true);
    (dependencies.verifySource ?? verifySourceCheckout)(config);
    await (dependencies.verifyApi ?? verifyApiBuild)(config);
    scanner = new CredentialScanner(Object.values(config.pins).concat(Object.values(config.operatorPins)).map(pin => pin.key));
    apps = start('headless/e2e/scripts/apps.ts', ['--apply'], env, scanner);
    let ready = false;
    const deadline = Date.now() + (dependencies.readyTimeout ?? 60_000);
    while (Date.now() < deadline && !interrupted && apps.running()) {
      try { await (dependencies.verifyBuilds ?? verifyBuilds)(config); ready = true; break; }
      catch { await delay(dependencies.pollInterval ?? 1000); }
    }
    if (!ready || interrupted || !apps.running()) return false;
    const [kind, app] = mode.split(':');
    const script = kind === 'e2e' ? 'e2e.ts' : mode === 'integration:account' ? 'account-integration.ts' : 'single-app.ts';
    const args = kind === 'e2e' || mode === 'integration:account' ? ['--apply'] : ['--apply', '--app', app, ...(kind === 'integration' ? ['--integration'] : [])];
    suite = start(`headless/e2e/scripts/${script}`, args, env, scanner);
    const result = await suite.done;
    success = result.code === 0 && !result.failed && !interrupted && apps.running();
  } catch { success = false; }
  finally {
    let suiteStopped = false, appsStopped = false;
    try { suiteStopped = await stopOwned(suite, dependencies.stopTimeout ?? 45_000); } catch {}
    try { appsStopped = await stopOwned(apps, dependencies.stopTimeout ?? 15_000); } catch {}
    success = success && suiteStopped && appsStopped;
    try { scanner?.assertClean(); } catch { success = false; }
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
  return success;
}

export const runStagingE2E = (env = process.env, dependencies = {}) => runStagingLifecycle('e2e', env, dependencies);
