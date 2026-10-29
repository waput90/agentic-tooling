import { CopilotClient } from '@github/copilot-sdk';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeEnvironment } from '../electron/core/policy';
const root = await mkdtemp(join(tmpdir(), 'agentic-capabilities-'));
const client = new CopilotClient({
  mode: 'copilot-cli',
  workingDirectory: root,
  baseDirectory: join(root, 'runtime'),
  env: safeEnvironment(),
  useLoggedInUser: true,
  logLevel: 'error',
});
try {
  await mkdir(root, { recursive: true });
  await client.start();
  const status = await client.getStatus(),
    auth = await client.getAuthStatus();
  const models = auth.isAuthenticated ? await client.listModels() : [];
  console.log(
    JSON.stringify(
      {
        sdk: '1.0.28',
        runtime: status,
        auth,
        models: models.map((m) => ({ id: m.id, name: m.name })),
        inference: 'not requested',
      },
      null,
      2,
    ),
  );
  if (process.argv.includes('--inference') && models.length) {
    const selected = models.filter((m) => !m.id.includes('auto')).slice(0, 2);
    await Promise.all(
      selected.map(async (model) => {
        const events: { id: string; type: string }[] = [];
        const session = await client.createSession({
          model: model.id,
          allowedModels: [model.id],
          availableTools: [],
          enableConfigDiscovery: false,
          skipCustomInstructions: true,
          onPermissionRequest: () => ({ kind: 'reject' }),
          onEvent: (e) => {
            events.push({ id: e.id, type: e.type });
            if (e.type === 'assistant.usage')
              console.log(JSON.stringify({ model: model.id, usage: e.data }));
          },
        });
        try {
          const result = await session.sendAndWait(
            { prompt: 'Reply with exactly: connection verified. Do not call tools.' },
            120000,
          );
          console.log(
            JSON.stringify({
              model: model.id,
              session: session.sessionId,
              result: result?.data.content,
              startupEvent: events.some((e) => e.type === 'session.start'),
              usageEvents: events.filter((e) => e.type === 'assistant.usage').length,
            }),
          );
        } finally {
          await session.disconnect();
        }
      }),
    );
  }
} finally {
  await client.stop();
}
