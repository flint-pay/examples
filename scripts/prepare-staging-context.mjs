import { chmodSync, mkdtempSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrustedStagingRun } from './check-staging-event.mjs';

export function prepareStagingContext(env = process.env, checkout = process.cwd()) {
  if (!isTrustedStagingRun({ eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    repository: env.GITHUB_REPOSITORY })) throw new Error('Trusted staging context required.');
  if (!env.RUNNER_TEMP || !isAbsolute(env.RUNNER_TEMP) || !env.GITHUB_ENV) throw new Error('Private runner context required.');
  const parent = realpathSync(env.RUNNER_TEMP);
  const rel = relative(realpathSync(checkout), parent);
  if (!(rel === '..' || rel.startsWith('../')) || isAbsolute(rel)) throw new Error('Private staging files must stay outside the checkout.');
  const fixture = JSON.parse(env.E2E_FIXTURE_JSON ?? 'null');
  if (fixture?.schema_version !== 1 || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(fixture.run ?? '')) throw new Error('Private fixture manifest required.');
  const directory = mkdtempSync(join(parent, 'headless-acceptance-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'fixtures.json');
  writeFileSync(path, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
  appendFileSync(env.GITHUB_ENV, `E2E_PRIVATE_RUN_DIR=${directory}\nE2E_FIXTURE_FILE=${path}\nE2E_RUN_ID=${fixture.run}\n`);
  return { directory, path };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { prepareStagingContext(); console.log('Private staging context prepared.'); }
  catch { console.error('Staging context failed. Check the private fixture manifest and runner configuration.'); process.exitCode = 1; }
}
