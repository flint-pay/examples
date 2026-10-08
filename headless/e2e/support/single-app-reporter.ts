import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { join } from 'node:path';
import { writePrivate } from './private-files.ts';
import { invariant, emit } from './safe.ts';

export default class SingleAppReporter implements Reporter {
  counts = { passed: 0, failed: 0, notRun: 0 };
  onTestEnd(_test: TestCase, result: TestResult): void {
    if (result.status === 'passed') this.counts.passed++;
    else if (result.status === 'skipped' || result.status === 'interrupted') this.counts.notRun++;
    else this.counts.failed++;
  }
  async onEnd(): Promise<void> {
    const app = process.env.E2E_SINGLE_APP; invariant(app === 'storefront' || app === 'account', 'SINGLE_APP_REQUIRED');
    await writePrivate(join(process.env.E2E_PRIVATE_RUN_DIR ?? '', `single-app-${app}.json`), { schema_version: 1, run: process.env.E2E_RUN_ID, evidence_class: 'single_app_browser', ...this.counts, complete: this.counts.passed > 0 && this.counts.failed === 0 && this.counts.notRun === 0 });
    emit({ event: 'SINGLE_APP_BROWSER_FINISHED', count: this.counts.passed });
  }
  // No test titles, errors, stdout, attachments, paths or raw browser data are emitted.
  printsToStdio(): boolean { return false; }
}
