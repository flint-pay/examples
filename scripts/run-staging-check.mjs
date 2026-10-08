import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTrustedStagingRun } from './check-staging-event.mjs';

export function runWithoutPrivateOutput(program, args, options = {}) {
  const result = spawnSync(program, args, { ...options, stdio: 'pipe', encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  // Browser and API errors can contain customer details, session URLs, or credentials.
  // Keep all child output in memory and report only the result.
  return result.status === 0 && !result.error;
}

export function stagingDispatch(directory, script) {
  if (directory === 'headless/e2e' && script === 'fixtures:check') return { script };
  if (directory === 'headless/e2e' && script === 'e2e') return { mode: 'e2e' };
  const app = directory === 'headless/storefront' ? 'storefront' : directory === 'headless/account' ? 'account' : undefined;
  if (app && script === 'test:browser') return { mode: `browser:${app}` };
  if (app && script === 'test:integration') return { mode: `integration:${app}` };
  return undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const trusted = isTrustedStagingRun({ eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY });
  const [directory, script] = process.argv.slice(2);
  const dispatch = stagingDispatch(directory, script);
  if (!trusted || !dispatch || process.argv.length !== 4) {
    console.error('Staging check refused: a trusted main run and an explicit staging test script are required.');
    process.exitCode = 1;
  } else if (!(dispatch.mode
    ? await import('./run-staging-e2e.mjs').then(({ runStagingLifecycle }) => runStagingLifecycle(dispatch.mode)).catch(() => false)
    : runWithoutPrivateOutput('npm', ['run', script], { cwd: directory }))) {
    console.error('Staging checks failed. Private test output withheld. Reproduce locally to inspect the failure.');
    process.exitCode = 1;
  } else {
    console.log('Staging checks passed.');
  }
}
