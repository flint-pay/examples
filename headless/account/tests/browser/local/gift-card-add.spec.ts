// LOCAL STATE TEST for adding a gift card by code or by pasted link.
import { expect, test } from '@playwright/test';
import { captureForm, resetHarness } from '../support/helpers.ts';

const url = '/__render/ac-gift-card-add';
// Explicitly constructed so the sample is plainly synthetic: gcg_ plus 26 Crockford base 32 characters.
const grant = `gcg_${'0'.repeat(26)}`;

test.describe('add a gift card', () => {
  test.beforeEach(async ({ request }) => {
    await resetHarness(request);
  });

  test('tabs follow the keyboard pattern', async ({ page }) => {
    await page.goto(url);
    const codeTab = page.getByRole('tab', { name: 'Gift card code' });
    const linkTab = page.getByRole('tab', { name: 'Link from your gift card email' });
    await expect(codeTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('ac-gift-card-add-code')).toBeVisible();
    await codeTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(linkTab).toHaveAttribute('aria-selected', 'true');
    await expect(linkTab).toBeFocused();
    await expect(page.getByTestId('ac-gift-card-add-link')).toBeVisible();
    await expect(page.getByTestId('ac-gift-card-add-code')).toBeHidden();
    await page.keyboard.press('Home');
    await expect(codeTab).toHaveAttribute('aria-selected', 'true');
  });

  test('the code field is sensitive and never autofilled', async ({ page }) => {
    await page.goto(url);
    const code = page.getByTestId('ac-gift-card-add-code');
    await expect(code).toHaveAttribute('data-sensitive', 'true');
    await expect(code).toHaveAttribute('autocomplete', 'off');
    await expect(code).toHaveAttribute('spellcheck', 'false');
  });

  test('a code posts as a form with the code credential type', async ({ page }) => {
    await page.goto(url);
    const form = await captureForm(page, /\/gift-cards$/);
    await page.getByTestId('ac-gift-card-add-code').fill('EXAMPLE-CODE-1');
    await page.getByTestId('ac-gift-card-code-submit').click();
    await expect.poll(form).not.toBeNull();
    expect(form()?.get('credential_type')).toBe('code');
    expect(form()?.get('code')).toBe('EXAMPLE-CODE-1');
    expect(form()?.get('_csrf')).toBe('csrf-example-token');
  });

  test('a pasted link is read in the page and only the grant and token are sent', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(`${url}?variant=link`);
    const form = await captureForm(page, /\/gift-cards$/);
    const link = `https://example.test/gift-cards/${grant}?mode=test#token=tok_example_1`;
    await page.getByTestId('ac-gift-card-add-link').fill(link);
    await page.getByTestId('ac-gift-card-link-submit').click();
    await expect.poll(form).not.toBeNull();
    const params = form();
    expect(params?.get('credential_type')).toBe('recipient_access');
    expect(params?.get('grant_id')).toBe(grant);
    expect(params?.get('recipient_access_token')).toBe('tok_example_1');
    expect(params?.toString()).not.toContain('example.test');
    expect(params?.toString()).not.toContain('mode');
    expect(params?.has('link')).toBe(false);
    // The link was cleared and was never opened.
    await expect(page.getByTestId('ac-gift-card-add-link')).toHaveValue('');
    expect(requests.some((u) => u.includes('example.test/gift-cards'))).toBe(false);
  });

  test('a link that cannot be read is explained and nothing is sent', async ({ page }) => {
    await page.goto(`${url}?variant=link`);
    const form = await captureForm(page, /\/gift-cards$/);
    await page.getByTestId('ac-gift-card-add-link').fill('not a link');
    await page.getByTestId('ac-gift-card-link-submit').click();
    const error = page.getByTestId('ac-gift-card-link-error');
    await expect(error).toHaveText('Paste the full link from the gift card email, or enter the code instead.');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('ac-gift-card-add-link')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('ac-gift-card-add-link')).toBeFocused();
    expect(form()).toBeNull();
  });

  test('a rejected code shows the invalid message in the error summary', async ({ page }) => {
    await page.goto(`${url}?variant=invalid`);
    await expect(page.getByTestId('ac-error')).toContainText("That gift card code or link isn't valid.");
    await expect(page.getByTestId('ac-error')).toBeFocused();
  });

  test('without JavaScript the code form works and the link tab says what is needed', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.getByTestId('ac-gift-card-add-code')).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByText('JavaScript is needed to add a gift card from a link. Enter the code instead.')).toBeVisible();
    await expect(page.getByTestId('ac-gift-card-add-link')).toBeHidden();
    await context.close();
  });
});
