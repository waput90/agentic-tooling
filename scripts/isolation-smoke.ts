import { CopilotClient, defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { safeEnvironment, approvedAppTool } from '../electron/core/policy';

const root = await mkdtemp(join(tmpdir(), 'agentic-isolation-'));
const identity = join(root, 'identity');
const clients: CopilotClient[] = [];
try {
  const observations = await Promise.all(
    ['one', 'two'].map(async (name) => {
      const cwd = join(root, name);
      await mkdir(join(cwd, '.github/agents'), { recursive: true });
      await writeFile(
        join(cwd, '.github/agents/approved-agent.agent.md'),
        '---\nname: approved-agent\ndescription: Wrong repository profile\n---\nWrong discovered prompt',
      );
      const client = new CopilotClient({
        mode: 'copilot-cli',
        workingDirectory: cwd,
        baseDirectory: identity,
        env: safeEnvironment(),
        logLevel: 'error',
      });
      clients.push(client);
      await client.start();
      const events: string[] = [];
      let writeInvocations = 0;
      const session = await client.createSession({
        availableTools: ['custom:agentic_read_file'],
        tools: [
          defineTool('agentic_read_file', {
            description: 'Read-only fixture',
            parameters: z.object({}),
            handler: () => `read ${name}`,
          }),
          defineTool('agentic_write_file', {
            description: 'Excluded mutation fixture',
            parameters: z.object({}),
            handler: () => {
              writeInvocations++;
              return 'unexpected';
            },
          }),
        ],
        enableConfigDiscovery: false,
        enableSkills: false,
        enableFileHooks: false,
        enableSessionStore: false,
        skipCustomInstructions: true,
        skipEmbeddingRetrieval: true,
        memory: { enabled: false },
        customAgentsLocalOnly: true,
        disabledMcpServers: ['github'],
        customAgents: [
          {
            name: 'approved-agent',
            description: `Approved source ${name}`,
            prompt: `Approved ${name}`,
            infer: false,
          },
        ],
        agent: 'approved-agent',
        mcpServers: {
          shared: {
            type: 'stdio',
            command: process.execPath,
            args: [resolve('tests/fixtures/mcp-server.mjs'), `read_${name}`],
            workingDirectory: cwd,
            tools: [`read_${name}`],
          },
        },
        onPermissionRequest: (request) =>
          approvedAppTool(request, ['read_file'], true)
            ? { kind: 'approve-once' }
            : { kind: 'reject' },
        onEvent: (event) => events.push(event.type),
      });
      try {
        await session.rpc.mcp.removeGitHub();
        const servers = await session.rpc.mcp.list();
        console.log(JSON.stringify({ workspace: name, servers: servers.servers }));
        assert.deepEqual(
          servers.servers.filter((s) => s.name !== 'github').map((s) => s.name),
          ['shared'],
        );
        assert.ok(
          servers.servers
            .filter((s) => s.name === 'github')
            .every((s) => String(s.status) !== 'connected'),
        );
        const readResult = await session.rpc.tools.execute({
          name: 'agentic_read_file',
          arguments: {},
        });
        assert.match(JSON.stringify(readResult), new RegExp(`read ${name}`));
        await session.rpc.tools
          .execute({ name: 'agentic_write_file', arguments: {} })
          .catch(() => null);
        assert.equal(writeInvocations, 0, 'Excluded write tool must never execute');
        const selected = await session.rpc.agent.getCurrent();
        assert.equal(selected.agent?.description, `Approved source ${name}`);
        const tools = await session.rpc.mcp.listTools({ serverName: 'shared' });
        assert.deepEqual(
          tools.tools.map((t) => t.name),
          [`read_${name}`],
        );
        const agents = await session.rpc.agent.list();
        console.log(
          JSON.stringify({
            workspace: name,
            selected,
            agents: agents.agents.map((a) => ({ name: a.name, source: a.source })),
            startupCaptured: events.includes('session.start'),
            servers: servers.servers.map((s) => s.name),
          }),
        );
        assert.match(JSON.stringify(selected), /approved-agent/);
        assert.ok(events.includes('session.start'));
        return session.sessionId;
      } finally {
        await session.disconnect();
      }
    }),
  );
  assert.notEqual(observations[0], observations[1]);
  console.log(
    'Two concurrent runtimes kept distinct session and MCP scopes with config discovery disabled.',
  );
} finally {
  await Promise.all(clients.map((c) => c.stop()));
}
