import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { acquirePairLock, assertPairLock } from '../../support/lock.ts';
import type { Config } from '../../support/config.ts';

test('an existing private lock directory permits repeated acquisition and preserves pair exclusivity', async () => {
  const root = `/tmp/flint-headless-e2e-${process.getuid?.()}`;
  await mkdir(root, { mode: 0o700, recursive: true });
  const before = await stat(root), id = randomUUID();
  const config = {
    run: '20000101T000000Z-00000000',
    pins: {
      A: { merchantId: `mer_UNIT_${id}`, sandboxId: 'test_UNIT_A' },
      B: { merchantId: `mer_UNIT_${id}`, sandboxId: 'test_UNIT_B' },
    },
  } as Config;
  const first = await acquirePairLock(config);
  try {
    await assertPairLock(config);
    await assert.rejects(() => acquirePairLock(config), { code: 'SANDBOX_PAIR_ALREADY_LOCKED' });
    await assertPairLock(config);
  } finally { await first(); }
  const second = await acquirePairLock(config);
  try { await assertPairLock(config); } finally { await second(); }
  const after = await stat(root);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
});
