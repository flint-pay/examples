import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/examples.yml', import.meta.url), 'utf8');
const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)]
  .filter((match) => match[2].includes('runs-on:'));

test('every secret-bearing workflow job rejects PR events, forks and non-main dispatch refs', () => {
  const secretJobs = jobs.filter((match) => match[2].includes('secrets.'));
  assert.deepEqual(secretJobs.map((match) => match[1]), ['integration', 'browser', 'e2e']);
  for (const [, , body] of secretJobs) {
    assert.match(body, /if: >-\n\s+github\.repository == 'flint-pay\/examples' && github\.ref == 'refs\/heads\/main' &&\n\s+\(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\)/);
    assert.match(body, /node scripts\/check-staging-event\.mjs/);
    assert.match(body, /node scripts\/run-staging-check\.mjs/);
    assert.ok(body.indexOf('npm ci') < body.indexOf('secrets.'));
    assert.ok(!/^    env:/m.test(body), 'Secrets must not enter dependency installation jobs.');
  }
  for (const [, name, body] of jobs.filter((match) => ['static', 'discover', 'repo-checks'].includes(match[1]))) {
    assert.ok(!body.includes('secrets.'), `${name} must have no secret references.`);
  }
});

test('workflow has no public dispatch secret trigger, unsafe artifact upload or credential persistence', () => {
  assert.ok(!workflow.includes('pull_request_target'));
  assert.ok(!workflow.includes('repository_dispatch'));
  assert.ok(!workflow.includes('upload-artifact'));
  assert.ok(!workflow.includes('download-artifact'));
  assert.equal((workflow.match(/uses: actions\/checkout@/g) ?? []).length,
    (workflow.match(/persist-credentials: false/g) ?? []).length);
});

test('staging jobs share complete private fixture configuration and serialize the sandbox pair', () => {
  assert.match(workflow, /concurrency:\n  group: examples-\$\{\{ github.repository \}\}-\$\{\{ github.ref \}\}\n  cancel-in-progress: false/);
  for (const name of ['integration', 'browser', 'e2e']) {
    const body = jobs.find(match => match[1] === name)[2];
    assert.match(body, /max-parallel: 1/); assert.match(body, /node scripts\/prepare-staging-context.mjs/);
    assert.match(body, /E2E_FIXTURE_JSON: \$\{\{ secrets.FLINT_E2E_FIXTURE_JSON \}\}/);
    assert.match(body, /env: (?:&staging-environment|\*staging-environment)/);
    for (const app of ['storefront', 'account']) assert.match(body, new RegExp(`working-directory: headless/${app}`));
  }
  for (const name of ['E2E_OPERATOR_A_API_KEY', 'E2E_OPERATOR_B_API_KEY', 'E2E_TARGET_COMMIT', 'E2E_API_TARGET_COMMIT', 'E2E_API_ARTIFACT_ID', 'E2E_STOREFRONT_A_ARTIFACT_ID', 'E2E_STOREFRONT_B_ARTIFACT_ID', 'E2E_ACCOUNT_A_ARTIFACT_ID']) assert.match(workflow, new RegExp(`          ${name}:`));
  for (const sandbox of ['A', 'B']) for (const field of ['MERCHANT_ID', 'PROVIDER_ID']) assert.match(workflow, new RegExp(`E2E_SANDBOX_${sandbox}_${field}: \\$\\{\\{ secrets\\.`));
  assert.match(workflow, /name: Local injected account integration/);
  assert.match(jobs.find(match => match[1] === 'browser')[2], /needs: \[discover, repo-checks, static, integration\]/);
  assert.match(jobs.find(match => match[1] === 'e2e')[2], /needs: \[discover, repo-checks, static, integration, browser\]/);
});
