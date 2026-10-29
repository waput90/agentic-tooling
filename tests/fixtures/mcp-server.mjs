import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentic-test-fixture', version: '1.0.0' },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: process.argv[2] ?? 'read_fixture',
            description: 'Read a deterministic test value',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    else if (message.method === 'tools/call')
      result = { content: [{ type: 'text', text: 'fixture verified' }] };
    else if (message.method === 'ping') result = {};
    else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Unknown method' },
        }) + '\n',
      );
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  } catch {}
});
