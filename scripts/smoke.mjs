import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const userData = await mkdtemp(join(tmpdir(), 'agentic-smoke-'));
const executablePath = process.env.AGENTIC_PACKAGED_EXE || electronPath;
const launchEnv = { ...process.env, AGENTIC_USER_DATA: userData, AGENTIC_SMOKE: '1' };
delete launchEnv.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath,
  args: process.env.AGENTIC_PACKAGED_EXE ? [] : ['.'],
  env: launchEnv,
});
app.process().stderr?.on('data', (chunk) => process.stderr.write(chunk));
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => console.error('Renderer:', error.message));
  await page.getByRole('heading', { name: 'Get your agents working' }).waitFor();
  await page.getByRole('heading', { name: 'Add a Git repository' }).waitFor();
  await page.getByRole('button', { name: 'Add repository', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const snapshot = await page.evaluate(() => window.desktop.request({ type: 'snapshot' }));
  assert.deepEqual(snapshot.workspaces, []);
  // Exercise navigation at the minimum supported window size, as on CI runners.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1000, 650);
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1450, 960);
  });
  await page.getByRole('heading', { name: 'GitHub Copilot', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Headroom context compression', exact: true }).waitFor();
  const cancelDialog = app.waitForEvent('window');
  await page.getByLabel('Automatically approve verified workflow plans').click();
  const cancelled = await cancelDialog;
  await cancelled.getByRole('heading', { name: 'Enable automatic approvals' }).waitFor();
  assert.equal(await cancelled.evaluate(() => document.activeElement?.id), 'cancel');
  await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(
    (await page.evaluate(() => window.desktop.request({ type: 'snapshot' }))).settings
      .autoApprovePlans,
    false,
  );
  const approveDialog = app.waitForEvent('window');
  await page.getByLabel('Automatically approve verified workflow plans').click();
  const approved = await approveDialog;
  await approved.getByRole('heading', { name: 'Enable automatic approvals' }).waitFor();
  await mkdir('test-results', { recursive: true });
  await approved.screenshot({ path: 'test-results/confirmation.png' });
  await approved.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(
    async () => (await window.desktop.request({ type: 'snapshot' })).settings.autoApprovePlans,
  );
  await page.evaluate(async () => {
    const settings = (await window.desktop.request({ type: 'snapshot' })).settings;
    await window.desktop.request({ type: 'settings', ...settings, autoApprovePlans: false });
  });
  const rememberDialog = app.waitForEvent('window');
  await page
    .getByLabel('Automatically continue when observed tokens pass the plan threshold')
    .click();
  const remembered = await rememberDialog;
  await remembered.getByRole('heading', { name: 'Enable automatic approvals' }).waitFor();
  await remembered.screenshot({ path: 'test-results/confirmation-remember.png' });
  await remembered.getByRole('button', { name: "Approve & don't ask again" }).click();
  await page.waitForFunction(
    async () =>
      (await window.desktop.request({ type: 'snapshot' })).rememberedApprovals.length === 1,
  );
  await page.getByRole('heading', { name: 'Remembered approvals' }).waitFor();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForFunction(
    async () =>
      (await window.desktop.request({ type: 'snapshot' })).rememberedApprovals.length === 0,
  );
  await page.evaluate(async () => {
    const settings = (await window.desktop.request({ type: 'snapshot' })).settings;
    await window.desktop.request({ type: 'settings', ...settings, autoContinueTokens: false });
  });
  assert.equal(await page.getByLabel('Enable Headroom for new plans').isChecked(), false);
  const headroomFixture = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        messages: body.messages,
        tokens_before: 10,
        tokens_after: 10,
        ccr_hashes: [],
      }),
    );
  });
  await new Promise((resolve) => headroomFixture.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${headroomFixture.address().port}`;
    await page.getByLabel('Headroom local URL').fill(baseUrl);
    await page.getByLabel('Enable Headroom for new plans').check();
    await page.getByRole('button', { name: 'Save Headroom settings', exact: true }).click();
    await page.waitForFunction(
      async () => (await window.desktop.request({ type: 'snapshot' })).headroom.config.enabled,
    );
    await page.getByLabel('Enable Headroom for new plans').uncheck();
    await page.getByRole('button', { name: 'Save Headroom settings', exact: true }).click();
    await page.waitForFunction(
      async () => !(await window.desktop.request({ type: 'snapshot' })).headroom.config.enabled,
    );
  } finally {
    await new Promise((resolve) => {
      headroomFixture.close(resolve);
      headroomFixture.closeAllConnections();
    });
  }
  await page.getByLabel('Appearance').selectOption('light');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.getByLabel('Appearance').selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  // This validates packaged runtime discovery as well as the renderer and SQLite.
  const runtime = await page.evaluate(() => window.desktop.request({ type: 'runtime' }));
  assert.equal(runtime.version, '1.0.105', runtime.error);
  assert.ok(['connected', 'needs-auth'].includes(runtime.state));
  const encryptedRoundTrip = await app.evaluate(async ({ safeStorage }) => {
    for (let i = 0; i < 30 && !(await safeStorage.isAsyncEncryptionAvailable()); i++)
      await new Promise((r) => setTimeout(r, 100));
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
    const encrypted = await safeStorage.encryptStringAsync('agentic-smoke-fixture');
    return (await safeStorage.decryptStringAsync(encrypted)).result === 'agentic-smoke-fixture';
  });
  assert.equal(encryptedRoundTrip, true, 'OS credential storage must be available');
  const backupPath = join(userData, 'smoke-backup.sqlite');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, backupPath);
  assert.equal(await page.evaluate(() => window.desktop.backup()), backupPath);
  const bypass = await page.evaluate(async () => {
    try {
      await window.desktop.request({
        type: 'execute',
        workspaceId: 'foreign',
        planId: 'unapproved',
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(bypass, true);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  console.log(
    'Electron smoke passed: renderer bridge, confirmation dialog, SQLite, navigation, theme, ownership gate, screenshot.',
  );
} finally {
  await app.close();
}
