import { ipcRenderer } from 'electron';

type ConfirmationData = {
  title: string;
  detail: string;
  actionLabel: string;
  destructive: boolean;
};

window.addEventListener('DOMContentLoaded', () => {
  const title = document.getElementById('title');
  const detail = document.getElementById('detail');
  const action = document.getElementById('action') as HTMLButtonElement | null;
  const cancel = document.getElementById('cancel');
  const close = document.getElementById('close');
  if (!title || !detail || !action || !cancel || !close) return;

  ipcRenderer.on('confirmation-data', (_event, data: ConfirmationData) => {
    title.textContent = data.title;
    detail.textContent = data.detail;
    action.textContent = data.actionLabel;
    action.classList.toggle('destructive', data.destructive);
  });
  action.addEventListener('click', () => ipcRenderer.send('confirmation-choice', 'approve'));
  cancel.addEventListener('click', () => ipcRenderer.send('confirmation-choice', 'cancel'));
  close.addEventListener('click', () => ipcRenderer.send('confirmation-choice', 'cancel'));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') ipcRenderer.send('confirmation-choice', 'cancel');
  });
});
