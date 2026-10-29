import { app } from 'electron';
import updater from 'electron-updater';
export type UpdateState = { state: string; version?: string; detail?: string };
export function configureUpdater(
  changed: (state: UpdateState) => void,
  isIdle: () => Promise<boolean>,
  prepare: () => Promise<void>,
) {
  const { autoUpdater } = updater;
  let downloaded = false,
    installing = false;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on('checking-for-update', () => changed({ state: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    changed({ state: 'downloading', version: info.version }),
  );
  autoUpdater.on('update-not-available', () =>
    changed({ state: 'current', version: app.getVersion() }),
  );
  autoUpdater.on('download-progress', (p) =>
    changed({ state: 'downloading', detail: `${Math.round(p.percent)}%` }),
  );
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true;
    changed({
      state: 'ready',
      version: info.version,
      detail: 'Installs silently when idle or on exit.',
    });
  });
  autoUpdater.on('error', (e) => changed({ state: 'failed', detail: e.message }));
  const check = async () => {
    if (!app.isPackaged) {
      changed({
        state: 'development',
        detail: 'Updates are enabled in the installed Windows build.',
      });
      return;
    }
    await autoUpdater.checkForUpdates().catch(() => {});
  };
  // Never restart an active or paused workflow; queued work is also preserved.
  setInterval(
    () => {
      void check();
    },
    4 * 60 * 60 * 1000,
  ).unref();
  setInterval(() => {
    void (async () => {
      if (downloaded && !installing && (await isIdle())) {
        installing = true;
        await prepare();
        autoUpdater.quitAndInstall(true, true);
      }
    })().catch((e) => {
      installing = false;
      changed({ state: 'failed', detail: String(e) });
    });
  }, 60000).unref();
  setTimeout(() => {
    void check();
  }, 15000).unref();
  return check;
}
