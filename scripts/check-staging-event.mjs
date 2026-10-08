import { fileURLToPath } from 'node:url';

export function isTrustedStagingRun({ eventName, ref, repository }) {
  return ['schedule', 'workflow_dispatch'].includes(eventName) &&
    ref === 'refs/heads/main' && repository === 'flint-pay/examples';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!isTrustedStagingRun({ eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY })) {
    console.error('Staging checks require a scheduled or manual run on flint-pay/examples main.');
    process.exitCode = 1;
  }
}
