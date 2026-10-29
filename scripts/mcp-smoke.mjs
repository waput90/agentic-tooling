import { Worker } from 'node:worker_threads';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const root = await mkdtemp(join(tmpdir(), 'agentic-mcp-'));
const job = {
  kind: 'mcp',
  root,
  dataDir: join(root, 'runtime'),
  serverName: 'fixture',
  mcpAction: 'test',
  mcp: {
    fixture: {
      type: 'stdio',
      command: process.execPath,
      args: [resolve('tests/fixtures/mcp-server.mjs')],
      workingDirectory: root,
      tools: ['read_fixture'],
    },
  },
};
const probe = (job) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../dist-electron/copilot-worker.js', import.meta.url), {
      workerData: job,
    });
    let result, error;
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error('MCP smoke timed out'));
    }, 60000);
    worker.on('message', (m) => {
      if (m.type === 'result') result = m.data;
      if (m.type === 'error') error = new Error(m.data.message);
    });
    worker.on('error', reject);
    worker.on('exit', () => {
      clearTimeout(timeout);
      error ? reject(error) : resolve(result);
    });
  });
const result = await probe(job);
assert.ok(result.tools.tools.some((t) => t.name === 'read_fixture'));
console.log(
  'Bundled Copilot runtime connected to a local stdio fixture and discovered its tool without inference.',
);
const secret = 'fixture-only-api-key';
const server = createServer(async (req, res) => {
  if (req.headers['x-api-key'] !== secret) {
    res.writeHead(403);
    res.end('Authentication rejected');
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  let message;
  try {
    message = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (message.id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  let result = {};
  if (message.method === 'initialize')
    result = {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'http-fixture', version: '1' },
    };
  if (message.method === 'tools/list')
    result = {
      tools: [
        {
          name: 'read_http',
          description: 'Read fixture',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const remote = {
    ...job,
    serverName: 'remote',
    secrets: [secret],
    mcp: { remote: { type: 'http', url, headers: { 'X-Api-Key': secret }, tools: ['read_http'] } },
  };
  const observed = await probe(remote);
  assert.ok(observed.tools.tools.some((t) => t.name === 'read_http'));
  assert.ok(!JSON.stringify(observed).includes(secret));
  await assert.rejects(
    probe({
      ...remote,
      mcp: { remote: { ...remote.mcp.remote, headers: { 'X-Api-Key': 'wrong' } } },
    }),
  );
  console.log(
    'HTTP MCP fixture passed API-key success, rejection, and diagnostic redaction checks.',
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
