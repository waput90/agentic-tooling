import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
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
  await page.getByText('A clear view of the work.').waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const snapshot = await page.evaluate(() => window.desktop.request({ type: 'snapshot' }));
  assert.deepEqual(snapshot.workspaces, []);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'GitHub Copilot', exact: true }).waitFor();
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
    'Electron smoke passed: renderer bridge, SQLite, navigation, theme, ownership gate, screenshot.',
  );
} finally {
  await app.close();
}
