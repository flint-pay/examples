import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkIdentityCopies } from './check-identity-copies.mjs';
import { punctuationViolations } from './check-punctuation.mjs';
import { discoverExamples, validateManifest } from './validate-manifests.mjs';
import { matrices } from './examples-matrix.mjs';
import { renderIndex, updateIndex } from './generate-index.mjs';

function fixture(id = 'headless/storefront', kind = 'example') {
  return {
    schema_version: 1, kind, id, area: 'headless', title: 'Headless example', summary: 'An embedded checkout example.',
    language: 'typescript', runtime: { node: '>=24' }, status: 'beta', status_note: 'Uses the beta SDK.',
    guides: [{ title: 'Checkout', url: 'https://developers.withflintpay.com/docs/guides/headless-checkout' }],
    requires: { flint_sdk: { package: '@flintpay/node', version: '3.0.0-beta.20261007031000' },
      stripe_js: true, stripe_test_mode: true, sandbox: 'dedicated', second_sandbox: false,
      customer_account_mode: 'any', webhooks: 'optional', inbox: 'optional', capabilities: [], sandbox_setup: [] },
    commands: { install: 'npm ci', setup: 'npm run setup', dev: 'npm run dev', check: 'npm run check', test: 'npm test',
      test_integration: 'npm run test:integration', test_browser: 'npm run test:browser', e2e: 'npm run e2e' },
    ports: [4100], env: { file: '.env.example', required: ['FLINT_API_KEY'], optional: [] },
    ci: { check: true, integration: kind === 'example' ? 'nightly' : 'none', browser: 'none', e2e: kind === 'e2e' ? 'nightly' : 'none' },
    ...(kind === 'e2e' ? { covers: ['headless/storefront', 'headless/account'] } : {}),
  };
}

const packageFixture = () => ({ dependencies: { '@flintpay/node': '3.0.0-beta.20261007031000' },
  scripts: { check: 'tsc --noEmit', test: 'node --test', 'test:integration': 'node --test', 'test:browser': 'playwright test', e2e: 'playwright test' } });

function exampleFiles(root, id, kind = 'example') {
  const folder = join(root, id);
  mkdirSync(join(folder, 'tests'), { recursive: true });
  for (const [name, content] of Object.entries({ 'example.json': JSON.stringify(fixture(id, kind)),
    'package.json': JSON.stringify(packageFixture()), 'package-lock.json': '{}', '.env.example': 'FLINT_API_KEY=\n', 'README.md': 'Example\n' })) {
    writeFileSync(join(folder, name), content);
  }
}

test('discovers self-contained examples and harnesses without reading private context or dependencies', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flint-manifest-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  exampleFiles(root, 'headless/storefront');
  exampleFiles(root, 'headless/account');
  exampleFiles(root, 'headless/e2e', 'e2e');
  for (const directory of ['.context', 'node_modules']) {
    mkdirSync(join(root, directory));
    writeFileSync(join(root, directory, 'example.json'), 'private and invalid');
  }
  const examples = discoverExamples(root);
  assert.deepEqual(examples.map((item) => item.id), ['headless/account', 'headless/e2e', 'headless/storefront']);
  const matrix = matrices(examples);
  assert.equal(matrix.static.include.length, 3);
  assert.equal(matrix.integration.include.length, 2);
  assert.deepEqual(matrix.e2e.include, [{ id: 'headless/e2e', kind: 'e2e', port: 4100 }]);
});

test('rejects manifest paths that can escape the checkout or inject CI commands', () => {
  for (const id of ['../private', 'headless/storefront;printenv', 'headless/$(printenv)', 'headless/storefront\nmalicious', '/headless/storefront']) {
    assert.throws(() => validateManifest(fixture(id), id, packageFixture(), 'FLINT_API_KEY=\n'), /kebab-case/);
  }
});

test('rejects SDK drift, unlisted environment names, private guides and shared runtime dependencies', () => {
  const manifest = fixture();
  const packageJson = packageFixture();
  packageJson.dependencies['@flintpay/node'] = '^3.0.0';
  assert.throws(() => validateManifest(manifest, manifest.id, packageJson, 'FLINT_API_KEY=\n'), /exact manifest pin/);
  assert.throws(() => validateManifest(manifest, manifest.id, packageFixture(), ''), /environment name/);
  manifest.guides[0].url = 'https://developers.withflintpay.com/private?token=private';
  assert.throws(() => validateManifest(manifest, manifest.id, packageFixture(), 'FLINT_API_KEY=\n'), /public Flint guides/);
  const local = packageFixture();
  local.dependencies.shared = 'file:../../shared';
  assert.throws(() => validateManifest(fixture(), 'headless/storefront', local, 'FLINT_API_KEY=\n'), /shared local package/);
});

test('generates a deterministic index, preserves prose, and rejects malformed marker pairs', () => {
  const examples = [fixture('headless/storefront'), fixture('headless/account'), fixture('headless/e2e', 'e2e')];
  assert.equal(renderIndex(examples), renderIndex([...examples].reverse()));
  const source = '# Flint examples\n\nIntroduction.\n<!-- examples:index:start -->\nstale\n<!-- examples:index:end -->\n\nClosing prose.\n';
  const generated = updateIndex(source, examples);
  assert.ok(generated.startsWith('# Flint examples\n\nIntroduction.\n'));
  assert.ok(generated.endsWith('\n\nClosing prose.\n'));
  assert.match(generated, /### Acceptance/);
  assert.notEqual(generated, source);
  assert.equal(updateIndex(generated, examples), generated);
  assert.throws(() => updateIndex('no markers', examples), /index markers/);
});

test('rejects identity divergence instead of importing runtime helpers across examples', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flint-identity-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const id of ['storefront', 'account']) {
    const folder = join(root, 'headless', id, 'src/identity');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'auth.ts'), 'export const auth = true;\n');
  }
  assert.equal(checkIdentityCopies(root), 1);
  writeFileSync(join(root, 'headless/account/src/identity/auth.ts'), 'export const auth = false;\n');
  assert.throws(() => checkIdentityCopies(root), /byte for byte/);
});

test('checks literal punctuation in public text and skips binary files', () => {
  assert.equal(punctuationViolations([{ bytes: Buffer.from('Plain prose.') }]), 0);
  assert.equal(punctuationViolations([{ bytes: Buffer.from('Two clauses' + String.fromCodePoint(0x2014) + 'joined.') }]), 1);
  assert.equal(punctuationViolations([{ bytes: Buffer.from([0, 1, 2]) }]), 0);
});
