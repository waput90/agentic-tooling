import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../src/shared';
const api: DesktopAPI = {
  request: (command) => ipcRenderer.invoke('command', command),
  chooseRepository: () => ipcRenderer.invoke('chooseRepository'),
  backup: () => ipcRenderer.invoke('backup'),
  restore: () => ipcRenderer.invoke('restore'),
  exportDefinitions: () => ipcRenderer.invoke('exportDefinitions'),
  importDefinitions: (workspaceId) => ipcRenderer.invoke('importDefinitions', workspaceId),
  onChange: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('changed', handler);
    return () => ipcRenderer.removeListener('changed', handler);
  },
  update: () => ipcRenderer.invoke('update'),
  version: () => ipcRenderer.invoke('version'),
};
contextBridge.exposeInMainWorld('desktop', api);
