/**
 * Browser tests for the authorization server's own pages.
 *
 * Why this exists: everything else in the suite drives the Workers through
 * fetch, which proves the HTTP contract but not that a browser can actually use
 * the pages. These tests cover real rendering, real cookie behaviour (including
 * `HttpOnly`), real form submission, and real escaping of user-supplied text.
 *
 * The Workers run in process via the same harness the integration tests use, so
 * there is no external web server to start and no port to configure.
 */

import { expect, test } from '@playwright/test';
import { startHarness, type Harness } from '../harness/index.js';

let harness: Harness;

test.beforeAll('start the Workers harness', async () => {
  harness = await startHarness();
});

test.afterAll('stop the Workers harness', async () => {
  await harness?.close();
});

test.describe('authorization server pages in a browser', () => {
  test('serves a landing page that links to sign in and sign up', async ({ page }) => {
    await page.goto(`${harness.url}/`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Bludit Wizard MCP');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible();
  });

  test('creates an account, keeps the session in an HttpOnly cookie, and lands on the sites page', async ({
    page,
    context
  }) => {
    const email = `browser-${Date.now()}@example.test`;

    await page.goto(`${harness.url}/signup`);
    await page.fill('#displayName', 'Browser Tester');
    await page.fill('#email', email);
    await page.fill('#password', 'a-sufficiently-long-password');
    await page.getByRole('button', { name: 'Create an account' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Connected sites');
    await expect(page.getByText(email)).toBeVisible();

    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name.includes('bw_session'));
    expect(session, 'a session cookie should have been set').toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');

    // HttpOnly means the page's own script cannot read it.
    expect(String(await page.evaluate('document.cookie'))).not.toContain('bw_session');
  });

  test('walks the pairing challenge through the browser form', async ({ page }) => {
    const email = `challenge-${Date.now()}@example.test`;
    await signUp(page, email);

    await page.fill('#label', 'My browser site');
    await page.fill('#baseUrl', 'https://browser.example.com');
    await page.getByRole('button', { name: 'Generate pairing challenge' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Finish connecting My browser site');

    const challenge = (await page.locator('code.token').first().innerText()).trim();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The connect form carries both the CSRF token and the challenge forward.
    const connectForm = page.locator('form[action="/sites/connect"]');
    await expect(connectForm.locator('input[name="challenge"]')).toHaveValue(challenge);
    await expect(connectForm.locator('input[name="csrf"]')).not.toHaveValue('');
    await expect(connectForm.locator('input[name="apiToken"]')).toBeVisible();
    await expect(connectForm.locator('select[name="edition"]')).toBeVisible();

    // Option B guidance names the exact well-known path for the site entered.
    await expect(page.getByText('https://browser.example.com/.well-known/bludit-wizard-challenge.txt')).toBeVisible();
  });

  test('escapes user-supplied labels rather than rendering markup', async ({ page }) => {
    const email = `escape-${Date.now()}@example.test`;
    await signUp(page, email);

    const payload = '"><img src=x onerror=alert(1)>';
    await page.fill('#label', payload);
    await page.getByRole('button', { name: 'Generate pairing challenge' }).click();

    // The markup must not have become an element, and no alert may have fired.
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Finish connecting');
    expect(await page.locator('body').innerText()).toContain('<img src=x onerror=alert(1)>');
  });

  test('sends an unauthenticated visitor to sign in instead of failing', async ({ page }) => {
    await page.goto(`${harness.url}/sites`);
    await expect(page).toHaveURL(/\/signin\?next=/);
    expect(await page.locator('body').innerText()).not.toContain('Internal Server Error');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign in');
  });

  test('returns to the attempted page after signing in', async ({ page }) => {
    const email = `redirect-${Date.now()}@example.test`;
    const password = 'a-sufficiently-long-password';

    // Create the account, then sign out.
    await signUp(page, email, password);
    await page.goto(`${harness.url}/signout`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Bludit Wizard MCP');

    // A protected page should remember the destination.
    await page.goto(`${harness.url}/sites`);
    await expect(page).toHaveURL(/\/signin\?next=%2Fsites/);
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/sites$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Connected sites');
  });

  test('rejects a bad password without leaking whether the account exists', async ({ page }) => {
    const email = `wrongpass-${Date.now()}@example.test`;
    await signUp(page, email, 'the-correct-password-value');
    await page.goto(`${harness.url}/signout`);

    await page.goto(`${harness.url}/signin`);
    await page.fill('#email', email);
    await page.fill('#password', 'definitely-the-wrong-one');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Email or password is incorrect.')).toBeVisible();

    // The same message for an account that does not exist.
    await page.goto(`${harness.url}/signin`);
    await page.fill('#email', `nobody-${Date.now()}@example.test`);
    await page.fill('#password', 'definitely-the-wrong-one');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
  });

  test('refuses a short password at sign-up', async ({ page }) => {
    await page.goto(`${harness.url}/signup`);
    await page.fill('#email', `short-${Date.now()}@example.test`);
    await page.fill('#password', 'too-short');
    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(page.getByText('Password must be at least 12 characters.')).toBeVisible();
  });

  test('protects the connected-clients page and shows an empty state when signed in', async ({ page }) => {
    await page.goto(`${harness.url}/clients`);
    await expect(page).toHaveURL(/\/signin/);

    await signUp(page, `clients-${Date.now()}@example.test`);
    await page.goto(`${harness.url}/clients`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Connected MCP clients');
    await expect(page.getByText('No clients have been authorized yet.')).toBeVisible();
  });
});

async function signUp(page: import('@playwright/test').Page, email: string, password = 'a-sufficiently-long-password'): Promise<void> {
  await page.goto(`${harness.url}/signup`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Connected sites');
}
