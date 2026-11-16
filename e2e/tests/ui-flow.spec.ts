import { expect, test, type Page, type Request } from '@playwright/test';
import http from 'node:http';

/**
 * Must-cover scenario 12 (qa-engineer.md):
 * create channel → start → send test message → appears live in the log → detail shows HL7/JSON → resend.
 *
 * Two channels are created through the UI: an inbound MLLP listener (with a webhook) and an outbound
 * channel that targets that listener on 127.0.0.1 (the API process hosts both). The test send on the
 * outbound page therefore produces one outbound message (AA from our own listener) and one inbound
 * message (delivered to the webhook receiver). Everything is cleaned up at the end.
 *
 * Env: BASE_URL, QA_EMAIL, QA_PASSWORD, optional MLLP_PORT (default 6061), optional WEBHOOK_URL.
 * On the local stack a webhook receiver runs inside this test process (127.0.0.1:6099) so inbound
 * deliveries succeed. On the live site (API inside a container) pass WEBHOOK_URL or the inbound message
 * shows as failed (404), which does not affect the flow.
 */

const EMAIL = process.env.QA_EMAIL ?? 'admin@ackwell.test';
const PASSWORD = process.env.QA_PASSWORD ?? 'correct-horse-battery';
const MLLP_PORT = process.env.MLLP_PORT ?? '6061';
const RUN = Date.now().toString(36).toUpperCase();
const IN_NAME = `QA inbound ${RUN}`;
const OUT_NAME = `QA outbound ${RUN}`;
const CTRL = `QAUI${RUN}`;

const HL7 = [
  `MSH|^~\\&|QA|HOSP|LIS|LAB|||ADT^A01|${CTRL}||2.5.1`,
  'EVN|A01',
  'PID|1||MRN0001^^^HOSP^MR||DOE^JANE^A||19800101|F',
  'PV1|1|I|WARD1^101^A',
].join('\n');

interface Hit {
  headers: http.IncomingHttpHeaders;
  body: string;
}

let receiver: http.Server | undefined;
const hits: Hit[] = [];
let webhookUrl = process.env.WEBHOOK_URL;

test.beforeAll(async ({ baseURL }) => {
  if (webhookUrl) return;
  if (!/localhost|127\.0\.0\.1/.test(baseURL ?? '')) {
    webhookUrl = `${baseURL}/health`; // POST → 404: permanent failure, still visible in the log
    return;
  }
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => receiver!.listen(6099, '127.0.0.1', r));
  webhookUrl = 'http://127.0.0.1:6099/hl7';
});

test.afterAll(async () => {
  await new Promise<void>((r) => (receiver ? receiver.close(() => r()) : r()));
});

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Channels' }).first()).toBeVisible();
}

/** Fills the create form; returns the new channel id from the URL after save. */
async function createChannel(page: Page, direction: 'inbound' | 'outbound', name: string) {
  await page.goto(`/channels/new?direction=${direction}`);
  await expect(page.getByRole('radio', { name: new RegExp(`^${direction}`, 'i') })).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Name').fill(name);
  if (direction === 'inbound') {
    await page.getByLabel('Listen port').fill(MLLP_PORT);
    await page.getByLabel('Webhook URL').fill(webhookUrl!);
  } else {
    await page.getByLabel('Host').fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(MLLP_PORT);
  }
  await page.getByRole('button', { name: 'Create channel' }).click();
  if (direction === 'inbound') {
    // Inbound channels show their one-time webhook secret before leaving the form.
    const dialog = page.getByRole('dialog', { name: 'Your webhook signing secret' });
    await expect(dialog.getByText(/^whsec_/)).toBeVisible();
    await dialog.getByRole('button', { name: 'I have stored the secret' }).click();
  }
  await page.waitForURL(/\/channels\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  return page.url().split('/').pop()!;
}

async function startChannel(page: Page, id: string) {
  await page.goto(`/channels/${id}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
}

async function deleteChannel(page: Page, id: string, name: string) {
  await page.goto(`/channels/${id}`);
  const toggle = page.getByRole('button', { name: /^(Start|Stop)$/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.textContent())?.trim() === 'Stop') {
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete channel' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete channel' }).click();
  await page.waitForURL(/\/channels$/);
  await expect(page.getByRole('link', { name })).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test('UI flow: create → start → test send → live log → HL7/JSON detail → resend', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).host;
  const external: string[] = [];
  const messageListFetches: string[] = [];
  page.on('request', (r: Request) => {
    const u = new URL(r.url());
    if (u.host !== origin && u.protocol.startsWith('http')) external.push(r.url());
    if (/\/api\/channels\/[^/]+\/messages/.test(u.pathname) || u.pathname === '/api/messages') messageListFetches.push(u.pathname + u.search);
  });

  await signIn(page);

  const inId = await createChannel(page, 'inbound', IN_NAME);
  await startChannel(page, inId);
  await expect(page.getByText(`port ${MLLP_PORT}`).first()).toBeVisible();

  const outId = await createChannel(page, 'outbound', OUT_NAME);
  await startChannel(page, outId);

  // The live feed must be open before the send so the new row can arrive without polling.
  const events = page.waitForResponse((r) => r.url().includes('/api/events') && r.status() === 200, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  const eventsResponse = await events;
  expect(eventsResponse.headers()['content-type']).toContain('text/event-stream');
  await page.waitForTimeout(1500); // let the stream settle so polling stops
  const fetchesBeforeSend = messageListFetches.length;

  // Test send from the outbound page.
  const textarea = page.getByLabel('Message to send');
  await textarea.fill(HL7);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/Queued ADT\^A01/)).toBeVisible();

  // The row appears in the channel log without a reload, with the AA ack from our listener.
  const row = page.getByRole('row').filter({ hasText: CTRL });
  await expect(row).toBeVisible();
  await expect(row).toContainText('AA', { timeout: 20_000 });
  await expect(row).toContainText(/sent/i);
  const liveNote = `message list refetches between stream open and row visible: ${messageListFetches.length - fetchesBeforeSend}`;
  test.info().annotations.push({ type: 'live-feed', description: liveNote });
  console.log(`[ui-flow] live-feed: ${liveNote}`);

  // Detail dialog: Monaco panes with the raw HL7 and the typed JSON, then resend.
  await row.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: new RegExp(`ADT\\^A01.*${CTRL}`) })).toBeVisible();
  const editors = dialog.locator('.monaco-editor');
  // In dev mode Vite transforms the lazy Monaco chunk on first use, which can take well over 30 s cold.
  const t0 = Date.now();
  await expect(editors).toHaveCount(2, { timeout: 120_000 });
  const monacoNote = `editors visible after ${Date.now() - t0} ms`;
  test.info().annotations.push({ type: 'monaco', description: monacoNote });
  console.log(`[ui-flow] monaco: ${monacoNote}`);
  await expect(editors.nth(0).locator('.view-lines')).toContainText('MSH|^~\\&|QA|HOSP');
  await expect(editors.nth(1).locator('.view-lines')).toContainText('"msh_12"');
  await expect(dialog.getByRole('radio', { name: /typed/i })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('radio', { name: /lossless/i }).click();
  await expect(editors.nth(1).locator('.view-lines')).toContainText('"segments"');
  await expect(dialog.getByText('#1')).toBeVisible();
  await dialog.getByRole('button', { name: 'Resend' }).click();
  await expect(dialog.getByText('#2')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('li', { hasText: '#2' })).toContainText('success');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A resend re-sends the same outbound row (attempt #2), so the listener received two frames:
  // 1 outbound row + 2 inbound rows, all on the global page.
  await page.goto(`/channels/${inId}`);
  await expect(page.getByRole('row').filter({ hasText: CTRL })).toHaveCount(2);
  await page.goto('/messages');
  const globalRows = page.getByRole('row').filter({ hasText: CTRL });
  await expect(globalRows).toHaveCount(3);
  await expect(globalRows.filter({ hasText: IN_NAME })).toHaveCount(2);
  await expect(globalRows.filter({ hasText: OUT_NAME })).toHaveCount(1);
  await globalRows.first().click();
  await expect(page.getByRole('dialog').locator('.monaco-editor')).toHaveCount(2, { timeout: 30_000 });
  await page.keyboard.press('Escape');

  if (receiver) {
    await expect.poll(() => hits.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    const h = hits[0]!;
    expect(h.headers['webhook-id']).toBeTruthy();
    expect(h.headers['webhook-signature']).toMatch(/^v1,/);
    expect(JSON.parse(h.body).controlId ?? JSON.parse(h.body).id).toBeTruthy();
    await page.goto(`/channels/${inId}`);
    await expect(page.getByRole('row').filter({ hasText: CTRL }).first()).toContainText(/delivered/i);
  }

  // No CDN or other external request during the whole flow (Monaco is bundled locally).
  expect(external, 'external requests').toEqual([]);

  await deleteChannel(page, outId, OUT_NAME);
  await deleteChannel(page, inId, IN_NAME);
});
