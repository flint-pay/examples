import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkPublicFile, checkPublication, readSnapshot } from './check-publication.mjs';

test('rejects captured credentials and private artifacts, including forced tracked files', () => {
  for (const path of ['.context/acceptance.json', '.env', 'app/.env.local', 'app/traces/payment.zip',
    'app/playwright-report/index.html', 'app/storage-state.json', 'merchant.key', 'app/results.har',
    'app/node_modules/dependency/index.js', 'app/reports/acceptance.json',
    'playwright/.auth/buyer.json', '.ssh/config', '.DS_Store', 'screenshot-payment.png',
    'headless/account/data/opaque-runtime-file', 'headless/storefront/session.sqlite-wal',
    'app/session.sqlite-shm', 'app/session.sqlite-journal', 'app/session.db-wal', 'app/session.db-shm']) {
    assert.ok(checkPublicFile(path, Buffer.from('innocuous')).length > 0);
  }
  assert.deepEqual(checkPublicFile('headless/storefront/.env.example', Buffer.from('FLINT_API_KEY=\n')), []);
});

test('rejects real-shaped fixtures and PII while permitting merchant placeholders', () => {
  for (const value of ['ord_' + '01JABCDE123456789ABCDEFGHJK', 'flint_test_' + 'abcdefghijklmnopqrstuvwxyz',
    '018f1234' + '-1234-7123-8123-123456789abc', 'buyer@' + 'mailprovider.com', '+' + '14165551234']) {
    assert.ok(checkPublicFile('example.json', Buffer.from(value)).length > 0);
  }
  assert.deepEqual(checkPublicFile('example.json', Buffer.from('buyer@example.com ord_example customer_id')), []);
});

test('permits TypeScript source helpers while rejecting captures and credential paths', () => {
  for (const path of ['headless/e2e/support/results.ts', 'support/trace.ts', 'support/report.test.ts']) {
    assert.deepEqual(checkPublicFile(path, Buffer.from('export const value = 1;')), []);
  }
  for (const path of ['support/results.json', 'support/result.html', 'support/results.har',
    'support/trace.json', 'support/trace.html', 'support/trace.har', 'support/screenshot.png',
    'support/report.json', 'support/credentials.ts', 'support/storage-state.ts',
    '.auth/results.ts', '.ssh/trace.ts', 'test-results/results.ts', 'screenshots/helper.ts']) {
    assert.ok(checkPublicFile(path, Buffer.from('innocuous')).includes('credential or captured artifact') ||
      checkPublicFile(path, Buffer.from('innocuous')).includes('private or generated artifact'));
  }
  assert.deepEqual(checkPublicFile('support/results.ts', Buffer.from('flint_test_' + 'abcdefghijklmnopqrstuvwxyz')),
    ['Flint credential']);
});

test('permits only the reserved NANP 555-0100 through 555-0199 phone range', () => {
  for (const area of ['202', '512', '416']) {
    for (const subscriber of ['0100', '0123', '0199']) {
      assert.deepEqual(checkPublicFile('fixture.ts', Buffer.from('+' + '1' + area + '555' + subscriber)), []);
    }
  }
  for (const value of ['12025550099', '12025550200', '12025551234', '15125559999',
    '11005550100', '12025560100', '442025550100', '120255501990']) {
    assert.deepEqual(checkPublicFile('fixture.ts', Buffer.from('+' + value)), ['personal phone number']);
  }
  assert.deepEqual(checkPublicFile('fixture.ts', Buffer.from('+' + '12025550100, +' + '14165551234')),
    ['personal phone number']);
});

test('rejects links and submodules instead of following unpublished content', () => {
  assert.ok(checkPublicFile('app/config', Buffer.from('../private'), '120000').length > 0);
  assert.ok(checkPublicFile('app/sdk', Buffer.from('object'), '160000').length > 0);
});

test('reads exact index bytes rather than a sanitized worktree or untracked private files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flint-index-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args]);
    assert.equal(result.status, 0);
  };
  run('init', '--quiet');
  const original = 'flint_test_' + 'abcdefghijklmnopqrstuvwxyz';
  writeFileSync(join(root, 'config.txt'), original);
  run('add', 'config.txt');
  writeFileSync(join(root, 'config.txt'), 'sanitized');
  writeFileSync(join(root, '.env'), 'must never be read');
  const files = readSnapshot(root);
  assert.equal(files.length, 1);
  assert.equal(files[0].bytes.toString(), original);
  assert.deepEqual(checkPublicFile(files[0].path, files[0].bytes), ['Flint credential']);
});

test('Gitleaks blocks secrets even when repository ignore and inline suppressions try to hide them', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flint-gitleaks-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => assert.equal(spawnSync('git', ['-C', root, ...args]).status, 0);
  run('init', '--quiet');
  const value = ['gh', 'p_', randomBytes(64).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 36)].join('');
  writeFileSync(join(root, 'config.js'), `const token = '${value}'; // gitleaks:allow\n`);
  writeFileSync(join(root, '.gitleaksignore'), '*\n');
  writeFileSync(join(root, '.gitleaks.toml'), '[allowlist]\npaths = [".*"]\n');
  run('add', '.');
  assert.throws(() => checkPublication(root), /Gitleaks failed or detected a secret/);
});

test('Gitleaks accepts a clean public snapshot without reading the worktree private environment', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flint-clean-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => assert.equal(spawnSync('git', ['-C', root, ...args]).status, 0);
  run('init', '--quiet');
  writeFileSync(join(root, 'config.js'), 'export const apiKey = process.env.FLINT_API_KEY;\n');
  run('add', 'config.js');
  writeFileSync(join(root, '.env'), ['gh', 'p_', '0123456789abcdefghijklmnopqrstuvwxyz'].join(''));
  assert.equal(checkPublication(root), 1);
});
