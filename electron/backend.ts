import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { Service } from './core/service';
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const service = new Service(
  workerData.dataDir,
  () => parentPort?.postMessage({ type: 'changed' }),
  (type, data) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      parentPort?.postMessage({ type: 'host', id, action: type, data });
    }),
);
parentPort?.on('message', async (m) => {
  if (m.type === 'hostResult') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(new Error(m.error));
    else p?.resolve(m.data);
    return;
  }
  if (m.type === 'desktopConfirm') {
    try {
      if (
        typeof m.data?.title !== 'string' ||
        typeof m.data?.detail !== 'string' ||
        m.data.title.length > 200 ||
        m.data.detail.length > 30000
      )
        throw new Error('Invalid desktop confirmation');
      const data = await service.confirm(m.data);
      parentPort?.postMessage({ type: 'response', id: m.id, data });
    } catch (e) {
      parentPort?.postMessage({ type: 'response', id: m.id, error: (e as Error).message });
    }
    return;
  }
  try {
    const data = await service.command(m.command);
    parentPort?.postMessage({ type: 'response', id: m.id, data });
  } catch (e) {
    parentPort?.postMessage({ type: 'response', id: m.id, error: (e as Error).message });
  }
});
