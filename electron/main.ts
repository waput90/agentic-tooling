import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  shell,
  Menu,
  powerMonitor,
} from 'electron';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { commandSchema, type Command, type Snapshot } from '../src/shared';
import { configureUpdater, type UpdateState } from './updater';

if (process.env.AGENTIC_USER_DATA) app.setPath('userData', process.env.AGENTIC_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow,
  backend: Worker,
  quitting = false,
  stopping = false,
  pendingDialogs = 0;
let updateState: UpdateState = { state: 'unchecked' };
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const request = <T = unknown>(command: Command): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve: (v) => resolve(v as T), reject });
    backend.postMessage({ id, command });
  });
const changed = () => {
  if (window && !window.isDestroyed()) window.webContents.send('changed');
};
async function confirm(title: string, detail: string) {
  pendingDialogs++;
  try {
    return await new Promise<boolean>((resolve) => {
      const modal = new BrowserWindow({
        parent: window,
        modal: true,
        width: 620,
        height: 440,
        minWidth: 520,
        minHeight: 380,
        resizable: false,
        frame: false,
        show: false,
        backgroundColor: '#101215',
        webPreferences: {
          preload: fileURLToPath(new URL('./confirmation-preload.cjs', import.meta.url)),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        ipcMain.removeListener('confirmation-choice', onChoice);
        if (!modal.isDestroyed()) modal.close();
        resolve(approved);
      };
      const onChoice = (event: Electron.IpcMainEvent, choice: unknown) => {
        if (event.sender !== modal.webContents || event.senderFrame !== modal.webContents.mainFrame)
          return;
        if (choice === 'approve' || choice === 'cancel') finish(choice === 'approve');
      };
      ipcMain.on('confirmation-choice', onChoice);
      modal.on('closed', () => finish(false));
      modal.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      modal.webContents.on('will-navigate', (event) => event.preventDefault());
      modal.webContents.on('did-finish-load', () => {
        const destructive = /delete|discard|remove|clear|restore/i.test(title);
        modal.webContents.send('confirmation-data', {
          title,
          detail,
          actionLabel: destructive
            ? 'Confirm action'
            : /approv/i.test(title)
              ? 'Approve'
              : 'Continue',
          destructive,
        });
        modal.show();
        modal.focus();
      });
      void modal
        .loadFile(fileURLToPath(new URL('./confirmation.html', import.meta.url)))
        .catch(() => finish(false));
    });
  } finally {
    pendingDialogs--;
  }
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await request({ type: 'shutdown' }).catch(() => {});
  await backend.terminate();
}
async function boot() {
  const dataDir = app.getPath('userData');
  await mkdir(dataDir, { recursive: true });
  backend = new Worker(new URL('./backend.js', import.meta.url), { workerData: { dataDir } });
  backend.on('message', async (m) => {
    if (m.type === 'changed') {
      changed();
      return;
    }
    if (m.type === 'response') {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error));
      else p?.resolve(m.data);
      return;
    }
    if (m.type === 'host')
      try {
        let data: unknown;
        if (m.action === 'confirm') data = await confirm(m.data.title, m.data.detail);
        if (m.action === 'encrypt') {
          if (!(await safeStorage.isAsyncEncryptionAvailable()))
            throw new Error('OS-protected credential storage is unavailable');
          data = (await safeStorage.encryptStringAsync(m.data)).toString('base64');
        }
        if (m.action === 'decrypt')
          data = (await safeStorage.decryptStringAsync(Buffer.from(m.data, 'base64'))).result;
        if (m.action === 'openOAuth') {
          const url = new URL(m.data);
          if (url.protocol !== 'https:' || url.username || url.password)
            throw new Error('Invalid OAuth browser destination');
          if (await confirm('Open sign-in', `Continue to ${url.origin} in your browser?`))
            await shell.openExternal(url.toString());
          else throw new Error('Sign-in cancelled');
        }
        backend.postMessage({ type: 'hostResult', id: m.id, data });
      } catch (e) {
        backend.postMessage({ type: 'hostResult', id: m.id, error: (e as Error).message });
      }
  });
  backend.on('error', (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    void dialog.showErrorBox('Backend stopped', e.message);
  });
  const preload = fileURLToPath(new URL('./preload.cjs', import.meta.url));
  window = new BrowserWindow({
    width: 1450,
    height: 960,
    minWidth: 1000,
    minHeight: 650,
    backgroundColor: '#101215',
    title: 'Agentic Tooling',
    show: !process.env.AGENTIC_SMOKE,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  const dev = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
  const expected = dev ?? new URL('../dist/index.html', import.meta.url).href;
  const validate = (event: Electron.IpcMainInvokeEvent) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      (event.senderFrame.url !== expected && event.senderFrame.url !== expected + '/')
    )
      throw new Error('Untrusted IPC sender');
  };
  ipcMain.handle('command', async (event, input) => {
    validate(event);
    const command = commandSchema.parse(input);
    if (
      ['addWorkspace', 'backup', 'import', 'export', 'shutdown', 'prepareUpdate'].includes(
        command.type,
      )
    )
      throw new Error('Use the dedicated desktop action');
    const result = await request(command);
    return command.type === 'snapshot' ? { ...(result as Snapshot), update: updateState } : result;
  });
  ipcMain.handle('chooseRepository', async (event) => {
    validate(event);
    const selected = await dialog.showOpenDialog(window, {
      title: 'Select a Git repository — Graphify indexes it automatically',
      properties: ['openDirectory'],
    });
    if (selected.canceled) return null;
    const workspace = await request<{ id: string }>({
      type: 'addWorkspace',
      path: selected.filePaths[0],
    });
    return workspace.id;
  });
  ipcMain.handle('backup', async (event) => {
    validate(event);
    const selected = await dialog.showSaveDialog(window, {
      defaultPath: 'agentic-backup.sqlite',
      filters: [{ name: 'SQLite backup', extensions: ['sqlite'] }],
    });
    if (selected.canceled || !selected.filePath) return null;
    await request({ type: 'backup', path: selected.filePath });
    return selected.filePath;
  });
  ipcMain.handle('restore', async (event) => {
    validate(event);
    const state = await request<Snapshot>({ type: 'snapshot' });
    if (state.runs.some((r) => ['running', 'queued', 'paused'].includes(r.state)))
      throw new Error('Stop active runs before restoring.');
    const selected = await dialog.showOpenDialog(window, {
      filters: [{ name: 'SQLite backup', extensions: ['sqlite'] }],
      properties: ['openFile'],
    });
    if (selected.canceled) return false;
    const check = new DatabaseSync(selected.filePaths[0], { readOnly: true });
    try {
      if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw new Error('Backup integrity check failed');
      if (!check.prepare('SELECT version FROM schema_migrations WHERE version=1').get())
        throw new Error('Unsupported backup version');
    } finally {
      check.close();
    }
    if (
      !(await confirm(
        'Restore backup',
        'The application will save a recovery backup, replace its database, and restart. Worktree files are not included in database backups.',
      ))
    )
      return false;
    await request({ type: 'backup', path: join(dataDir, 'before-restore.sqlite') });
    await shutdown();
    const dbPath = join(dataDir, 'agentic.sqlite');
    await copyFile(selected.filePaths[0], dbPath + '.restore');
    await rm(dbPath + '-wal', { force: true });
    await rm(dbPath + '-shm', { force: true });
    await rename(dbPath + '.restore', dbPath);
    quitting = true;
    app.relaunch();
    app.quit();
    return true;
  });
  ipcMain.handle('exportDefinitions', async (event) => {
    validate(event);
    const selected = await dialog.showSaveDialog(window, {
      defaultPath: 'agentic-definitions.json',
    });
    if (!selected.filePath) return false;
    await writeFile(selected.filePath, JSON.stringify(await request({ type: 'export' }), null, 2));
    return true;
  });
  ipcMain.handle('importDefinitions', async (event, workspaceId?: string) => {
    validate(event);
    const selected = await dialog.showOpenDialog(window, {
      filters: [{ name: 'JSON definitions', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (selected.canceled) return false;
    const state = await request<Snapshot>({ type: 'snapshot' });
    const target = state.workspaces.find((w) => w.id === workspaceId);
    if (workspaceId && !target) throw new Error('Import workspace does not exist');
    if (
      !(await confirm(
        'Import definitions',
        target
          ? `Import agents and workflow templates, and explicitly copy context and disabled MCP definitions into ${target.name}? Imported agents remain archived and no approvals are imported.`
          : 'Import archived agents and workflow templates? Select a workspace first to also import context and disabled MCP definitions.',
      ))
    )
      return false;
    await request({
      type: 'import',
      data: JSON.parse(await readFile(selected.filePaths[0], 'utf8')),
      targetWorkspaceId: workspaceId,
    });
    return true;
  });
  const checkUpdates = configureUpdater(
    (state) => {
      updateState = state;
      changed();
    },
    async () => {
      const state = await request<Snapshot>({ type: 'snapshot' });
      return (
        pendingDialogs === 0 &&
        powerMonitor.getSystemIdleTime() >= 60 &&
        !state.runs.some((r) => ['running', 'queued', 'paused'].includes(r.state)) &&
        !state.workspaces.some((w) =>
          ['checking', 'installing', 'building'].includes(w.graph.state),
        )
      );
    },
    async () => {
      await request({ type: 'prepareUpdate' });
      await shutdown();
      quitting = true;
    },
  );
  ipcMain.handle('update', (event) => {
    validate(event);
    return checkUpdates();
  });
  ipcMain.handle('version', (event) => {
    validate(event);
    return app.getVersion();
  });
  if (dev) await window.loadURL(dev);
  else await window.loadFile(fileURLToPath(new URL('../dist/index.html', import.meta.url)));
  app.on('second-instance', () => {
    if (window.isMinimized()) window.restore();
    window.focus();
  });
}
app
  .whenReady()
  .then(boot)
  .catch((e) => {
    dialog.showErrorBox('Startup failed', String(e));
    app.exit(1);
  });
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void shutdown().finally(() => {
    quitting = true;
    app.quit();
  });
});
app.on('window-all-closed', () => app.quit());
