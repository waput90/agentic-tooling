import { ipcRenderer } from 'electron';

type ConfirmationData = {
  title: string;
  detail: string;
  actionLabel: string;
  destructive: boolean;
  rememberAllowed: boolean;
};

window.addEventListener('DOMContentLoaded', () => {
  const title = document.getElementById('title');
  const detail = document.getElementById('detail');
  const action = document.getElementById('action') as HTMLButtonElement | null;
  const cancel = document.getElementById('cancel');
  const close = document.getElementById('close');
  const remember = document.getElementById('remember') as HTMLButtonElement | null;
  const hint = document.getElementById('hint');
  if (!title || !detail || !action || !cancel || !close || !remember || !hint) return;

  ipcRenderer.on('confirmation-data', (_event, data: ConfirmationData) => {
    title.textContent = data.title;
    detail.textContent = data.detail;
    action.textContent = data.actionLabel;
    action.classList.toggle('destructive', data.destructive);
    remember.hidden = !data.rememberAllowed;
    remember.classList.toggle('destructive', data.destructive);
    hint.textContent = data.rememberAllowed
      ? 'Exact request only · Revoke in Settings'
      : 'Escape cancels this action';
  });
  action.addEventListener('click', () => ipcRenderer.send('confirmation-choice', 'approve'));
  cancel.addEventListener('click', () => ipcRenderer.send('confirmation-choice', 'cancel'));
  close.addEventListener('click', () => ipcRenderer.send('confirmation-choice', 'cancel'));
  remember.addEventListener('click', () => ipcRenderer.send('confirmation-choice', 'remember'));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') ipcRenderer.send('confirmation-choice', 'cancel');
  });
});
