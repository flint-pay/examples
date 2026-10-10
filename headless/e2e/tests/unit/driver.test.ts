import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { Driver } from '../../support/driver.ts';

type Field = { tagName: string; type?: string; value: string };
function formPage() {
  const fields: Record<string, Field> = {
    country: { tagName: 'INPUT', type: 'hidden', value: 'US' },
    label: { tagName: 'INPUT', type: 'text', value: '' },
    purpose: { tagName: 'SELECT', value: 'shipping' },
  };
  const submissions: Record<string, string>[] = [];
  class Locator {
    readonly field?: Field;
    constructor(field?: Field) { this.field = field; }
    first() { return this; }
    locator(selector: string) {
      const name = /^\[name="([^"]+)"\]$/.exec(selector)?.[1];
      return new Locator(name ? fields[name] : undefined);
    }
    async evaluate(fn: (element: Field) => unknown) { return fn(this.field!); }
    async getAttribute(name: string) { return name === 'type' ? this.field?.type ?? null : null; }
    async fill(value: string) {
      assert.notEqual(this.field?.type, 'hidden', 'a browser cannot fill a hidden input');
      assert.equal(this.field?.tagName, 'INPUT'); this.field!.value = value;
    }
    async selectOption(value: string) { assert.equal(this.field?.tagName, 'SELECT'); this.field!.value = value; }
    async click() { submissions.push(Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value]))); }
    async _expect(expression: string, options: { expectedText?: { string: string }[] }) {
      if (expression === 'to.be.visible') return { matches: true, log: [] };
      assert.equal(expression, 'to.have.value');
      return { matches: this.field?.value === options.expectedText![0].string, received: this.field?.value, log: [] };
    }
  }
  const page = {
    locator: (selector: string) => { assert.equal(selector, 'form[action="/addresses"]:visible'); return new Locator(); },
    waitForLoadState: async (state: string) => { assert.equal(state, 'domcontentloaded'); },
    waitForNavigation: async (options: { waitUntil: string }) => { assert.equal(options.waitUntil, 'domcontentloaded'); },
  } as unknown as Page;
  return { page, fields, submissions };
}

test('form submits the existing hidden country with edited input and select values', async () => {
  const { page, fields, submissions } = formPage();
  await Driver.prototype.form.call({} as Driver, page, '/addresses', { country: 'US', label: 'Acceptance address', purpose: 'billing' });
  assert.deepEqual(submissions, [{ country: 'US', label: 'Acceptance address', purpose: 'billing' }]);
  assert.equal(fields.country.value, 'US');
});

test('form refuses a hidden-value mismatch before changing it or submitting', async () => {
  const { page, fields, submissions } = formPage();
  await assert.rejects(() => Driver.prototype.form.call({} as Driver, page, '/addresses', { country: 'CA' }), /toHaveValue/);
  assert.equal(fields.country.value, 'US'); assert.deepEqual(submissions, []);
});

function challengeFrame(url: string, label: string, events: string[]) {
  return {
    url: () => url,
    getByRole: (role: string, options: { name: RegExp }) => {
      assert.equal(role, 'button');
      return { isVisible: async () => options.name.test(label), click: async () => { events.push(`click:${url}:${label}`); } };
    },
  };
}
for (const [outcome, label] of [['success', 'COMPLETE'], ['fail', 'FAIL'], ['success', 'Complete authentication'], ['fail', 'Fail authentication']] as const) {
  test(`challenge selects ${label} in a Stripe frame after the existing audits`, async () => {
    const events: string[] = [];
    const page = { frames: () => [challengeFrame('https://account.example.invalid', label, events), challengeFrame('https://hooks.stripe.com/3ds', label, events)] } as unknown as Page;
    const driver = { auditKnownStates: async (p: Page) => { assert.equal(p, page); events.push('audit'); } } as unknown as Driver;
    await Driver.prototype.challenge.call(driver, page, outcome);
    assert.deepEqual(events, ['audit', `click:https://hooks.stripe.com/3ds:${label}`]);
  });
}

test('challenge refuses merchant frames, lookalikes, insecure or credentialed origins, and inexact labels', async () => {
  const events: string[] = [];
  const credentialed = new URL('https://hooks.stripe.com'); credentialed.username = 'user';
  const frames = ['about:blank', 'https://account.example.invalid', 'https://evilstripe.com', 'https://stripe.com.example.invalid', 'http://hooks.stripe.com', credentialed.href, 'https://hooks.stripe.com:444'].map(url => challengeFrame(url, 'COMPLETE', events));
  frames.push(challengeFrame('https://hooks.stripe.com/3ds', 'Complete authentication extra', events));
  let waits = 0;
  const page = { frames: () => frames, waitForTimeout: async (delay: number) => { assert.equal(delay, 100); waits++; } } as unknown as Page;
  const driver = { auditKnownStates: async () => { events.push('audit'); } } as unknown as Driver;
  await assert.rejects(() => Driver.prototype.challenge.call(driver, page, 'success'), { code: 'PROVIDER_CHALLENGE_CONTROL_MISSING' });
  assert.deepEqual(events, []); assert.equal(waits, 300);
});
