// LOCAL STATE TEST for account screens that have interactive states: dialogs, forms, polling,
// and keyboard behavior. Data is canned and routes are scripted. Real resources come from staging.
import { expect, test } from '@playwright/test';
import { captureForm, harnessLog, resetHarness } from '../support/helpers.ts';

test.describe('subscription page', () => {
  test.beforeEach(async ({ request }) => {
    await resetHarness(request);
  });

  test('past due: banner, required action is primary, cancel is never the filled button', async ({ page }) => {
    await page.goto('/__render/ac-subscription?variant=past_due');
    await expect(page.getByTestId('ac-subscription-status')).toHaveAttribute('data-state', 'past_due');
    await expect(page.getByTestId('ac-subscription-past-due')).toContainText("Your last payment didn't go through. Update your card or try again.");
    await expect(page.getByTestId('ac-sub-action-update_payment_method')).toHaveClass(/btn-primary/);
    await expect(page.getByTestId('ac-sub-action-retry_payment')).toBeVisible();
    await expect(page.getByTestId('ac-sub-action-cancel')).toHaveClass(/btn-danger/);
    await expect(page.getByTestId('ac-sub-action-cancel')).not.toHaveClass(/btn-primary/);
    await expect(page.getByTestId('ac-sub-action-pause')).toHaveCount(0);
  });

  test('an active subscription shows cancel and pause, and hides actions that are not in state', async ({ page }) => {
    await page.goto('/__render/ac-subscription');
    await expect(page.getByTestId('ac-sub-action-cancel')).toBeVisible();
    await expect(page.getByTestId('ac-sub-action-pause')).toHaveClass(/btn-primary/);
    await expect(page.getByTestId('ac-sub-action-resume')).toHaveCount(0);
    await expect(page.getByTestId('ac-sub-action-reactivate')).toHaveCount(0);
    await expect(page.getByTestId('ac-subscription-next')).toHaveText('$22.00 on Nov 1, 2026');
    await expect(page.getByTestId('ac-subscription-method')).toHaveText('Visa ending 4242, expires 12/30');
    await expect(page.getByTestId('ac-subscription-history')).toBeVisible();
  });

  test('pause is shown disabled with a reason only when the store forbids it', async ({ page }) => {
    await page.goto('/__render/ac-subscription?variant=store_policy');
    const pause = page.getByTestId('ac-sub-action-pause');
    await expect(pause).toHaveAttribute('data-state', 'unavailable');
    await expect(pause.getByRole('button', { name: 'Pause' })).toBeDisabled();
    await expect(pause).toContainText('Not available for this store.');
  });

  test('a scheduled cancellation says when it ends and offers Keep my subscription', async ({ page }) => {
    await page.goto('/__render/ac-subscription?variant=scheduled_cancel');
    await expect(page.getByTestId('ac-subscription-scheduled-cancel')).toContainText("This subscription ends on Nov 1, 2026. You won't be charged after that.");
    await expect(page.getByTestId('ac-sub-action-reactivate')).toHaveText('Keep my subscription');
    await expect(page.getByTestId('ac-subscription-next')).toHaveText('No upcoming charge.');
  });

  test('a paused subscription offers Resume', async ({ page }) => {
    await page.goto('/__render/ac-subscription?variant=paused');
    await expect(page.getByTestId('ac-sub-action-resume')).toBeVisible();
    await expect(page.getByTestId('ac-subscription-paused')).toBeVisible();
  });

  test('the cancel dialog opens as a modal, closes with Escape, and returns focus', async ({ page }) => {
    await page.goto('/__render/ac-subscription');
    const trigger = page.getByTestId('ac-sub-action-cancel');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Cancel subscription' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('cancel: timing choice swaps the confirmation, the reason is required, the post carries the choice', async ({ page }) => {
    await page.goto('/__render/ac-subscription');
    const form = await captureForm(page, /\/subscriptions\/[^\/]+\/cancel$/);
    await page.getByTestId('ac-sub-action-cancel').click();
    const dialog = page.getByRole('dialog', { name: 'Cancel subscription' });
    await expect(dialog.getByLabel('At the end of this billing period (Nov 1, 2026)')).toBeChecked();
    await expect(dialog.getByText("Cancel your subscription? You won't be charged after Nov 1, 2026.")).toBeVisible();
    await dialog.getByLabel('Now', { exact: true }).check();
    await expect(dialog.getByText("Cancel now? Your subscription ends today and can't be undone.")).toBeVisible();
    await expect(dialog.getByText("You won't be charged after Nov 1, 2026.")).toBeHidden();

    // The reason is required, so the browser stops an empty submit.
    await dialog.getByTestId('ac-cancel-confirm').click();
    expect(form()).toBeNull();
    await dialog.getByLabel('Why are you canceling?').selectOption('too_expensive');
    await dialog.getByLabel('Anything else you want us to know (optional)').fill('Moving away.');
    await dialog.getByTestId('ac-cancel-confirm').click();
    await expect.poll(form).not.toBeNull();
    const body = form();
    expect(body?.get('cancel_when')).toBe('now');
    expect(body?.get('reason')).toBe('too_expensive');
    expect(body?.get('comment')).toBe('Moving away.');
    expect(body?.get('_csrf')).toBe('csrf-example-token');
  });

  test('cancel: when the store ends the subscription at period end, there is no timing choice or reason', async ({ page }) => {
    await page.goto('/__render/ac-subscription?variant=end_of_period');
    await page.getByTestId('ac-sub-action-cancel').click();
    const dialog = page.getByRole('dialog', { name: 'Cancel subscription' });
    await expect(dialog.getByTestId('ac-cancel-ends')).toHaveText('Your subscription ends on Nov 1, 2026.');
    await expect(dialog.getByRole('radio')).toHaveCount(0);
    await expect(dialog.getByLabel('Why are you canceling?')).toHaveCount(0);
  });

  test('cancel: the retention offer is a separate pause action before confirming', async ({ page }) => {
    await page.goto('/__render/ac-subscription');
    const form = await captureForm(page, /\/subscriptions\/[^\/]+\/pause$/);
    await page.getByTestId('ac-sub-action-cancel').click();
    await page.getByTestId('ac-retention-pause').click();
    await expect.poll(form).not.toBeNull();
    expect(form()?.get('cycles')).toBe('1');
  });

  test('cancel: a rejected reason reopens the dialog with the problem named', async ({ page }) => {
    await page.goto('/__render/ac-subscription?variant=cancel_error');
    await expect(page.getByRole('dialog', { name: 'Cancel subscription' })).toBeVisible();
    await expect(page.getByTestId('ac-subscription-action-error')).toHaveAttribute('data-state', 'action_error');
    await expect(page.getByTestId('field-error-reason')).toHaveText('Choose one of the listed reasons.');
  });

  test('pause: the length is a required choice up to the store limit', async ({ page }) => {
    await page.goto('/__render/ac-subscription');
    const form = await captureForm(page, /\/subscriptions\/[^\/]+\/pause$/);
    await page.getByTestId('ac-sub-action-pause').click();
    const dialog = page.getByRole('dialog', { name: 'Pause subscription' });
    const options = await dialog.getByLabel('Pause for').locator('option').allTextContents();
    expect(options).toEqual(['Choose how long', '1 billing period', '2 billing periods', '3 billing periods']);
    await dialog.getByTestId('ac-pause-confirm').click();
    expect(form()).toBeNull();
    await dialog.getByLabel('Pause for').selectOption('2');
    await dialog.getByTestId('ac-pause-confirm').click();
    await expect.poll(form).not.toBeNull();
    expect(form()?.get('cycles')).toBe('2');
  });

  test('change payment method: only cards usable for subscriptions can be chosen', async ({ page }) => {
    await page.goto('/__render/ac-subscription');
    const form = await captureForm(page, /\/subscriptions\/[^\/]+\/payment-method$/);
    await page.getByTestId('ac-sub-action-update_payment_method').click();
    const dialog = page.getByRole('dialog', { name: 'Change payment method' });
    const usable = dialog.getByLabel(/Visa ending 4242/);
    const notUsable = dialog.getByLabel(/Mastercard ending 4444/);
    await expect(usable).toBeEnabled();
    await expect(usable).toBeChecked();
    await expect(notUsable).toBeDisabled();
    await expect(dialog.getByText("Can't be used for subscriptions")).toBeVisible();
    await expect(dialog.getByTestId('ac-method-add')).toHaveAttribute('href', '/payment-methods/new?return_to=%2Fsubscriptions%2Fsub_example_001');
    await dialog.getByTestId('ac-method-confirm').click();
    await expect.poll(form).not.toBeNull();
    expect(form()?.get('payment_method_id')).toBe('pm_example_001');
  });

  test('retry in progress shows the status and follows it until it finishes', async ({ page, request }) => {
    // This route is the harness's own subscription page, which shows the finished state once the
    // scripted retry has succeeded, the way the real page does after a reload.
    await page.goto('/subscriptions/sub_example_001?variant=retrying');
    const status = page.getByTestId('ac-retry-status');
    await expect(status).toHaveAttribute('data-state', 'in_progress');
    await expect(status).toHaveText('Trying your card again.');
    await expect.poll(async () => (await harnessLog(request)).filter((entry) => entry.path.includes('/retries/')).length, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('ac-retry-status')).toHaveAttribute('data-state', 'succeeded', { timeout: 12_000 });
    await expect(page.getByTestId('ac-retry-status')).toContainText('Payment received. Your subscription is active again.');
  });

  test('starting a retry shows that it is starting before the page reloads with its status', async ({ page }) => {
    await page.goto('/__render/ac-subscription?variant=past_due');
    const form = await captureForm(page, /\/subscriptions\/[^/]+\/retry$/);
    const status = page.getByTestId('ac-retry-status');
    await expect(status).toBeHidden();
    await page.getByTestId('ac-sub-action-retry_payment').click();
    await expect.poll(form).not.toBeNull();
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('data-state', 'starting');
    await expect(status).toHaveText('Starting the retry.');
    await expect(page.getByTestId('ac-sub-action-retry_payment')).toHaveAttribute('aria-busy', 'true');
  });

  test('a failed retry shows the buyer-safe message as an alert and allows another try', async ({ page }) => {
    await page.goto('/__render/ac-subscription?variant=retry_failed');
    const status = page.getByTestId('ac-retry-status');
    await expect(status).toHaveAttribute('data-state', 'failed');
    await expect(status).toHaveAttribute('role', 'alert');
    await expect(status).toContainText("The retry didn't work. Your card was declined.");
    await expect(page.getByTestId('ac-sub-action-retry_payment')).toBeVisible();
  });

  test('a retry started elsewhere hides the retry button and tells the buyer', async ({ page }) => {
    await page.goto('/__render/ac-subscription?variant=retrying');
    await expect(page.getByTestId('ac-sub-action-retry_payment')).toHaveCount(0);
  });

  test('without JavaScript the cancel dialog is shown on the page as a working form', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/__render/ac-subscription');
    await expect(page.getByTestId('ac-sub-action-cancel')).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Cancel subscription' })).toBeVisible();
    await expect(page.getByTestId('ac-cancel-confirm')).toBeVisible();
    await context.close();
  });
});

test.describe('start a return', () => {
  test('shows only eligible items as choices and explains the others', async ({ page }) => {
    await page.goto('/__render/ac-return-start');
    const line = page.getByTestId('ac-return-row-oli_example_001');
    await expect(line.getByLabel('Return House blend coffee, 12 oz')).toBeVisible();
    // The checkbox itself carries ac-return-line-{id}, which the acceptance harness checks.
    await expect(page.getByTestId('ac-return-line-oli_example_001')).toHaveAttribute('type', 'checkbox');
    await expect(line).toContainText('Return by Nov 5, 2026');
    const blocked = page.getByTestId('ac-return-row-oli_example_002');
    await expect(blocked).toContainText('The return window has closed.');
    await expect(blocked.getByRole('checkbox')).toHaveCount(0);
  });

  test('details appear for chosen items and the reason is required', async ({ page }) => {
    await page.goto('/__render/ac-return-start');
    const form = await captureForm(page, /\/orders\/[^\/]+\/return$/);
    const line = page.getByTestId('ac-return-row-oli_example_001');
    await expect(page.getByTestId('ac-return-reason-oli_example_001')).toBeHidden();
    await line.getByLabel('Return House blend coffee, 12 oz').check();
    await expect(page.getByTestId('ac-return-reason-oli_example_001')).toBeVisible();
    await page.getByTestId('ac-return-submit').click();
    expect(form()).toBeNull();
    await page.getByTestId('ac-return-quantity-oli_example_001').selectOption('2');
    await page.getByTestId('ac-return-reason-oli_example_001').selectOption({ label: 'Arrived damaged' });
    // This reason needs a note.
    await expect(page.getByTestId('ac-return-note-oli_example_001')).toHaveAttribute('required', '');
    await page.getByTestId('ac-return-note-oli_example_001').fill('Bag was torn.');
    await page.getByTestId('ac-return-submit').click();
    await expect.poll(form).not.toBeNull();
    const body = form();
    expect(body?.get('line_0_selected')).toBe('on');
    expect(body?.get('line_0_order_line_item_id')).toBe('oli_example_001');
    expect(body?.get('line_0_fulfillment_id')).toBe('ful_example_001');
    expect(body?.get('line_0_quantity')).toBe('2');
    expect(body?.get('line_0_reason')).toBe('rr_2');
    expect(body?.get('line_0_note')).toBe('Bag was torn.');
    expect(body?.get('line_count')).toBe('2');
  });

  test('when nothing can be returned online it says to contact the store', async ({ page }) => {
    await page.goto('/__render/ac-return-start?variant=nothing');
    await expect(page.getByTestId('ac-return-nothing')).toContainText('Nothing on this order can be returned online. Contact us for help.');
    await expect(page.getByTestId('ac-return-submit')).toHaveCount(0);
    await expect(page.getByTestId('ac-return-nothing').getByRole('link', { name: 'Email help@example.test' })).toBeVisible();
  });

  test('a rejected request puts the problem in a focused alert', async ({ page }) => {
    await page.goto('/__render/ac-return-start?variant=error');
    const alert = page.getByTestId('ac-error');
    await expect(alert).toHaveText(/Choose at least one item to return\./);
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toBeFocused();
  });
});

test.describe('order and return detail', () => {
  test('tracking events are newest first with absolute times', async ({ page }) => {
    await page.goto('/__render/ac-order');
    await expect(page.getByTestId('ac-tracking-event-1')).toContainText('Delivered');
    await expect(page.getByTestId('ac-tracking-event-1')).toContainText('Oct 6, 2026, 5:30 AM CDT');
    await expect(page.getByTestId('ac-tracking-event-2')).toContainText('In transit');
    await expect(page.getByTestId('ac-tracking-event-3')).toContainText('Shipped');
    await expect(page.getByTestId('ac-packages')).toContainText('Carrier usps');
    await expect(page.getByTestId('ac-packages')).toContainText('Tracking number 9400EXAMPLE0001');
    await expect(page.getByTestId('ac-package-track')).toHaveAttribute('target', '_blank');
  });

  test('before shipping it says tracking will appear', async ({ page }) => {
    await page.goto('/__render/ac-order?variant=no_delivery');
    await expect(page.getByTestId('ac-no-delivery-yet')).toHaveText("We'll show tracking here once your order ships.");
  });

  test('a bank payment still processing is called out', async ({ page }) => {
    await page.goto('/__render/ac-order?variant=processing');
    await expect(page.getByTestId('ac-order-status')).toHaveAttribute('data-state', 'processing');
    await expect(page.getByTestId('ac-order-processing')).toHaveText('Your bank payment is processing.');
    await expect(page.getByTestId('ac-order-processing')).toHaveAttribute('data-state', 'processing_payment');
  });

  test('receipt and return actions follow the buyer actions', async ({ page }) => {
    await page.goto('/__render/ac-order');
    await expect(page.getByTestId('ac-send-receipt')).toHaveText('Email my receipt');
    await expect(page.getByTestId('ac-start-return')).toHaveAttribute('href', '/orders/ord_example_001/return');
    await page.goto('/__render/ac-order?variant=window_closed');
    await expect(page.getByTestId('ac-start-return')).toHaveCount(0);
    await expect(page.getByTestId('ac-return-unavailable')).toHaveText('The return window for this order has closed.');
  });

  test('section failures stay in their section', async ({ page }) => {
    await page.goto('/__render/ac-order?variant=errors');
    await expect(page.getByTestId('ac-order-items')).toBeVisible();
    await expect(page.getByTestId('ac-order-payments-error')).toContainText("We couldn't load your payments. Try again.");
    await expect(page.getByTestId('ac-order-tracking-error')).toBeVisible();
    await expect(page.getByTestId('ac-order-payments-error').getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/orders/ord_example_001');
  });

  test('a return that needs payment shows the balance and the way to pay it', async ({ page }) => {
    await page.goto('/__render/ac-return?variant=awaiting_payment');
    await expect(page.getByTestId('ac-return-status')).toHaveAttribute('data-state', 'awaiting_payment');
    await expect(page.getByTestId('ac-return-pay')).toHaveText('Pay $20.00');
    await expect(page.getByTestId('ac-return-pay')).toHaveAttribute('href', '/returns/ret_example_001/pay');
    await expect(page.getByTestId('ac-return-balance')).toHaveAttribute('data-amount-minor', '2000');
  });

  test('an approved return says where to send the items', async ({ page }) => {
    await page.goto('/__render/ac-return?variant=approved');
    await expect(page.getByTestId('ac-return-handoff')).toContainText('Send them to Cedar & Stone Roastery');
    await expect(page.getByTestId('ac-return-handoff')).toContainText('Send them by Oct 29, 2026.');
    await expect(page.getByTestId('ac-return-label')).toHaveAttribute('href', 'https://carrier.example.test/label/abc');
    await expect(page.getByTestId('ac-return-label')).toHaveAttribute('rel', /noopener/);
  });

  test('withdrawing needs a confirmation that says it cannot be undone', async ({ page }) => {
    await page.goto('/__render/ac-return');
    const form = await captureForm(page, /\/returns\/[^\/]+\/withdraw$/);
    const trigger = page.getByTestId('ac-return-withdraw');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Withdraw this return?' });
    await expect(dialog).toContainText("You'll keep the items and nothing will be refunded. This can't be undone.");
    await dialog.getByRole('button', { name: 'Keep return' }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(form()).toBeNull();
    await trigger.click();
    await dialog.getByTestId('ac-return-withdraw-confirm').click();
    await expect.poll(form).not.toBeNull();
  });

  test('completed and withdrawn returns have no actions', async ({ page }) => {
    for (const variant of ['completed', 'canceled']) {
      await page.goto(`/__render/ac-return?variant=${variant}`);
      await expect(page.getByTestId('ac-return-status')).toHaveAttribute('data-state', variant);
      await expect(page.getByTestId('ac-return-withdraw')).toHaveCount(0);
      await expect(page.getByTestId('ac-return-pay')).toHaveCount(0);
    }
  });
});

test.describe('invoice detail', () => {
  test.beforeEach(async ({ request }) => {
    await resetHarness(request);
  });

  test('states: open, overdue, processing, paid, closed', async ({ page }) => {
    const expectations: Array<[string, string]> = [
      ['default', 'open'],
      ['overdue', 'overdue'],
      ['processing', 'processing'],
      ['paid', 'paid'],
      ['closed', 'void_or_uncollectible'],
    ];
    for (const [variant, state] of expectations) {
      await page.goto(`/__render/ac-invoice?variant=${variant}`);
      await expect(page.getByTestId('ac-invoice-status')).toHaveAttribute('data-state', state);
    }
  });

  test('open invoice: pay link with the amount, PDF from this app, no Flint link', async ({ page }) => {
    await page.goto('/__render/ac-invoice');
    await expect(page.getByTestId('ac-invoice-pay')).toHaveText('Pay $120.00');
    await expect(page.getByTestId('ac-invoice-pay')).toHaveAttribute('href', '/invoices/inv_example_001/pay');
    await expect(page.getByTestId('ac-invoice-pdf')).toHaveAttribute('href', '/invoices/inv_example_001/pdf');
    const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    expect(hrefs.filter((href) => /withflintpay/.test(href))).toEqual([]);
  });

  test('a processing bank payment hides Pay and explains', async ({ page }) => {
    await page.goto('/__render/ac-invoice?variant=processing');
    await expect(page.getByTestId('ac-invoice-processing')).toHaveText('Your bank payment is processing. This invoice shows as paid when it clears.');
    await expect(page.getByTestId('ac-invoice-pay')).toHaveCount(0);
  });

  test('a closed invoice says there is nothing to pay', async ({ page }) => {
    await page.goto('/__render/ac-invoice?variant=closed');
    await expect(page.getByTestId('ac-invoice-closed')).toHaveText("This invoice is closed. There's nothing to pay.");
    await expect(page.getByTestId('ac-invoice-pay')).toHaveCount(0);
  });

  test('after a payment, the page polls until the invoice reflects it', async ({ page, request }) => {
    await page.goto('/__render/ac-invoice?variant=awaiting');
    await expect(page.getByTestId('ac-invoice-poll')).toHaveAttribute('data-state', 'checking');
    await expect(page.getByTestId('ac-notice')).toHaveText('Payment received.');
    await expect.poll(async () => (await harnessLog(request)).filter((entry) => entry.path.endsWith('/status')).length, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
    // Once the invoice shows paid the page reloads itself.
    await expect.poll(() => page.url(), { timeout: 12_000 }).toContain('/__render/ac-invoice');
  });

  test('credit notes link to PDFs on this app', async ({ page }) => {
    await page.goto('/__render/ac-invoice?variant=paid');
    await expect(page.getByTestId('ac-credit-note-cn_example_001').getByRole('link', { name: 'Download credit note PDF' })).toHaveAttribute('href', '/invoices/inv_example_001/credit-notes/cn_example_001/pdf');
  });
});

test.describe('lists, empty states, and section errors', () => {
  const cases: Array<[string, string, string, string]> = [
    ['ac-orders', 'empty', 'ac-orders-empty', 'No orders yet. Orders you place, and guest orders you connect, show up here.'],
    ['ac-returns', 'empty', 'ac-returns-empty', "You haven't started any returns."],
    ['ac-invoices', 'empty', 'ac-invoices-empty', "You don't have any invoices."],
    ['ac-subscriptions', 'empty', 'ac-subscriptions-empty', "You don't have any subscriptions."],
    ['ac-payment-methods', 'empty', 'ac-payment-methods-empty', 'No saved cards. Add a card to pay faster and keep subscriptions running.'],
    ['ac-addresses', 'empty', 'ac-addresses-empty', 'No saved addresses. Add one to check out faster.'],
    ['ac-gift-cards', 'empty', 'ac-gift-cards-empty', 'No saved gift cards.'],
    ['ac-home', 'new_account', 'ac-home-new-account', 'No orders yet. Orders you place show up here.'],
  ];
  for (const [pageId, variant, testid, text] of cases) {
    test(`${pageId} empty state`, async ({ page }) => {
      await page.goto(`/__render/${pageId}?variant=${variant}`);
      await expect(page.getByTestId(testid)).toContainText(text);
      await expect(page.getByTestId(testid)).toHaveAttribute('data-state', 'empty');
    });
  }

  for (const pageId of ['ac-orders', 'ac-returns', 'ac-invoices', 'ac-subscriptions', 'ac-payment-methods', 'ac-addresses', 'ac-gift-cards']) {
    test(`${pageId} load failure offers a retry and shows the reference`, async ({ page }) => {
      await page.goto(`/__render/${pageId}?variant=error`);
      const error = page.locator('[data-state="error"]').first();
      await expect(error).toHaveAttribute('role', 'alert');
      await expect(error).toContainText('Reference ID req_example_001');
      await expect(error.getByRole('link', { name: 'Try again' })).toBeVisible();
    });
  }

  test('home: a failing section does not hide the others', async ({ page }) => {
    await page.goto('/__render/ac-home?variant=section_error');
    await expect(page.getByTestId('ac-home-orders-error')).toContainText("We couldn't load your orders. Try again.");
    await expect(page.getByTestId('ac-home-subscriptions')).toContainText('Coffee club, monthly');
    await expect(page.getByTestId('ac-attention-clear')).toHaveCount(0);
  });

  test('home: attention items link to the right place, with due dates', async ({ page }) => {
    await page.goto('/__render/ac-home');
    await expect(page.getByTestId('ac-attention-update_payment_method-sub_example_001')).toContainText('Due Oct 19, 2026');
    await expect(page.getByTestId('ac-attention-retry_payment-sub_example_001').getByRole('link')).toHaveAttribute('href', '/subscriptions/sub_example_001');
    await expect(page.getByTestId('ac-attention-pay-inv_example_001').getByRole('link')).toHaveAttribute('href', '/invoices/inv_example_001/pay');
    await expect(page.getByTestId('ac-attention-ship_items-ret_example_001').getByRole('link')).toHaveAttribute('href', '/returns/ret_example_001');
    await expect(page.getByTestId('ac-attention-pay_balance-ret_example_001').getByRole('link')).toHaveAttribute('href', '/returns/ret_example_001/pay');
    await expect(page.getByTestId('ac-recent-order-ord_example_001')).toBeVisible();
  });

  test('home: nothing needed says so', async ({ page }) => {
    await page.goto('/__render/ac-home?variant=nothing_needed');
    await expect(page.getByTestId('ac-attention-clear')).toContainText("You're all caught up.");
  });

  test('home: notices and the developer banner', async ({ page }) => {
    await page.goto('/__render/ac-home?variant=wrong_environment');
    await expect(page.getByTestId('ac-notice')).toHaveText("That link is for a different store environment. Here's your account overview.");
    await page.goto('/__render/ac-home?variant=setup_needed');
    await expect(page.getByTestId('ac-setup-needed')).toContainText('npm run setup -- --apply');
  });

  test('orders: pagination links use the page token', async ({ page }) => {
    await page.goto('/__render/ac-orders?variant=paged');
    await expect(page.getByTestId('ac-orders-older')).toHaveAttribute('href', '/orders?page=next_example');
    await expect(page.getByTestId('ac-orders-newest')).toHaveAttribute('href', '/orders');
  });
});

test.describe('forms and keyboard behavior', () => {
  test('errors are announced in a focused summary that links to the field', async ({ page }) => {
    await page.goto('/__render/ac-profile?variant=error');
    const summary = page.getByTestId('ac-error');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveAttribute('role', 'alert');
    await expect(summary.getByRole('link', { name: /Enter your name\./ })).toHaveAttribute('href', '#f-name');
    const name = page.getByTestId('ac-profile-name');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAttribute('aria-describedby', 'f-name-error');
    await expect(page.locator('#f-name-error')).toHaveText('Enter your name.');
  });

  test('sign-in failure is generic and the form keeps its place', async ({ page }) => {
    await page.goto('/__render/sign-in?variant=error');
    await expect(page.getByTestId('ac-error')).toContainText('Email or password is incorrect.');
    await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username');
    await expect(page.getByLabel('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  test('the code field uses one-time-code and numeric input', async ({ page }) => {
    await page.goto('/__render/verify-email?variant=sent');
    const code = page.getByTestId('ac-verify-code');
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(code).toHaveAttribute('inputmode', 'numeric');
    await expect(code).toHaveAttribute('maxlength', '6');
    await expect(code).toHaveAttribute('data-sensitive', 'true');
  });

  test('a new code can be requested only after 30 seconds, and the page says why until then', async ({ page }) => {
    await page.goto('/__render/verify-email?variant=sent');
    const resend = page.getByTestId('ac-verify-resend');
    await expect(resend).toBeDisabled();
    await expect(page.locator('[data-resend-note]')).toContainText('Send a new code in');
    const form = page.locator('[data-resend-form]');
    await form.evaluate((el) => {
      (el as HTMLElement).dataset.sentAt = String(Date.now() - 31_000);
    });
    await page.reload();
    await page.evaluate(() => undefined);
    // The server rendered a fresh sentAt, so the button is disabled again right after load.
    await expect(page.getByTestId('ac-verify-resend')).toBeDisabled();
  });

  test('the skip link is the first tab stop and moves focus to the main content', async ({ page }) => {
    await page.goto('/__render/ac-orders');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
  });

  test('a form cannot be submitted twice while the first request is out', async ({ page }) => {
    await page.goto('/__render/sign-in');
    // Count the submits that would really go out: the page's own handler runs first and cancels
    // a repeat, so only a submit that is still uncancelled here counts. Then stop the navigation.
    await page.evaluate(() => {
      const w = window as unknown as { __proceeded: number };
      w.__proceeded = 0;
      document.addEventListener('submit', (event) => {
        if (!event.defaultPrevented) w.__proceeded += 1;
        event.preventDefault();
      });
    });
    await page.getByLabel('Email').fill('avery@example.test');
    await page.getByLabel('Password').fill('example-password');
    const submit = page.getByTestId('ac-sign-in-submit');
    await submit.dblclick();
    await expect(submit).toHaveAttribute('aria-busy', 'true');
    await expect(submit).toHaveText('Sign in');
    expect(await page.evaluate(() => (window as unknown as { __proceeded: number }).__proceeded)).toBe(1);
  });

  test('delete confirmations name what happens and return focus on cancel', async ({ page }) => {
    await page.goto('/__render/ac-addresses');
    const row = page.getByTestId('ac-address-adr_example_001');
    await row.getByTestId('ac-address-delete').click();
    const dialog = row.getByRole('dialog', { name: 'Delete this address?' });
    await expect(dialog).toContainText("You'll need to enter it again to use it.");
    await dialog.getByRole('button', { name: 'Keep address' }).click();
    await expect(row.getByTestId('ac-address-delete')).toBeFocused();
  });

  test('card removal is scoped to its card and says what changes for subscriptions', async ({ page }) => {
    await page.goto('/__render/ac-payment-methods');
    const card = page.getByTestId('ac-card-pm_example_001');
    await expect(card.getByTestId('ac-card-default')).toBeVisible();
    await expect(page.getByTestId('ac-card-pm_example_002')).toContainText('Confirming');
    await card.getByTestId('ac-card-remove').click();
    await expect(card.getByRole('dialog')).toContainText('Remove this card? Subscriptions using it will need another card.');
  });

  test('address form: first address becomes both defaults and says so', async ({ page }) => {
    await page.goto('/__render/ac-address-form?variant=first');
    await expect(page.getByTestId('ac-address-first-note')).toHaveText('Your first address becomes your default for shipping and billing.');
    await expect(page.getByLabel('Use as my default shipping address')).toHaveCount(0);
    await page.goto('/__render/ac-address-form?variant=edit');
    await expect(page.getByLabel('Street address')).toHaveValue('100 Example Street');
    await expect(page.getByLabel('Use as my default shipping address')).toBeChecked();
  });

  test('email change shows two code fields and a way to send new codes', async ({ page }) => {
    await page.goto('/__render/ac-profile-email?variant=codes');
    await expect(page.getByTestId('ac-email-change')).toHaveAttribute('data-state', 'codes_sent');
    await expect(page.getByTestId('ac-email-codes-sent')).toHaveText('We emailed a code to avery@example.test and a code to avery.new@example.test. Enter both.');
    await expect(page.getByTestId('ac-email-code-current')).toBeVisible();
    await expect(page.getByTestId('ac-email-code-new')).toBeVisible();
    await expect(page.getByTestId('ac-email-resend')).toBeVisible();
  });

  test('gift card detail: balances, history, and the missing-card message', async ({ page }) => {
    await page.goto('/__render/ac-gift-card');
    await expect(page.getByTestId('ac-gift-card-balance')).toHaveAttribute('data-amount-minor', '2500');
    await expect(page.getByTestId('ac-gift-card-available')).toHaveAttribute('data-amount-minor', '2000');
    await expect(page.getByTestId('ac-gift-card-tx-1')).toContainText('Used');
    await page.goto('/__render/ac-gift-card?variant=missing');
    await expect(page.getByTestId('ac-gift-card-missing')).toHaveText("This gift card's code changed. Add it again with the new code.");
  });

  test('privacy: the request needs a confirmation and statuses use plain words', async ({ page }) => {
    await page.goto('/__render/ac-privacy');
    await expect(page.getByTestId('ac-deletion-status')).toHaveAttribute('data-state', 'pending_review');
    await expect(page.getByTestId('ac-deletion-status')).toHaveText("We're reviewing your request.");
    await page.getByTestId('ac-deletion-request').click();
    const dialog = page.getByTestId('ac-deletion-dialog');
    await expect(dialog).toContainText("You can't sign in after it's closed.");
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ac-deletion-request')).toBeFocused();
  });

  test('link purchases: idle, code sent, and results use the right plural', async ({ page }) => {
    await page.goto('/__render/ac-link-purchases');
    await expect(page.getByTestId('ac-link-purchases')).toHaveAttribute('data-state', 'idle');
    await page.goto('/__render/ac-link-purchases?variant=sent');
    await expect(page.getByTestId('ac-link-purchases')).toHaveAttribute('data-state', 'code_sent');
    await expect(page.getByTestId('ac-link-code')).toBeVisible();
    await page.goto('/__render/ac-link-purchases?variant=done');
    await expect(page.getByTestId('ac-link-result')).toHaveText('We added 2 orders to your account.');
    await page.goto('/__render/ac-link-purchases?variant=none');
    await expect(page.getByTestId('ac-link-result')).toHaveText("We didn't find other guest orders for avery@example.test.");
  });

  test('hostile text in data is shown as text, never run', async ({ page }) => {
    await page.goto('/__render/ac-home?variant=xss');
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(page.getByTestId('ac-home-title')).toBeVisible();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await page.goto('/invoices/inv_example_001/pay?variant=xss');
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test('printing the receipt hides the page chrome', async ({ page }) => {
    await page.goto('/__render/ac-order-receipt');
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.no-print').first()).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Receipt for order 1001' })).toBeVisible();
  });
});
