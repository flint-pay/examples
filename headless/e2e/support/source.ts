import { spawnSync } from 'node:child_process';
import { checkoutRoot } from './private-files.ts';
import { invariant } from './safe.ts';
import type { Config } from './config.ts';

export function verifySourceCheckout(config: Config, git = (args: string[]) => spawnSync('git', args, { cwd: checkoutRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })): void {
  const head = git(['rev-parse', 'HEAD']), status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  invariant(head.status === 0 && head.stdout.trim() === config.targetCommit && status.status === 0 && status.stdout === '', 'REVIEWED_SOURCE_CHECKOUT_REQUIRED');
  for (const [name, app] of [['storefrontA', 'storefront'], ['storefrontB', 'storefront'], ['accountA', 'account']]) {
    invariant(config.builds[name] === `${config.targetCommit}:headless/${app}`, 'OWNED_SOURCE_ARTIFACT_REQUIRED');
  }
}
