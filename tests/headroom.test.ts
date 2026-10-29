import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Headroom,
  checkHeadroom,
  headroomUrl,
  type CompressionObservation,
} from '../electron/core/headroom';
import { headroomSchema } from '../src/shared';
import { Service } from '../electron/core/service';

async function fixture() {
  let mode: 'ok' | 'invalid' | 'redirect' | 'slow' | 'marker' = 'ok';
  const bodies: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/compress' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    if (mode === 'redirect') {
      res.writeHead(302, { Location: 'http://example.com' }).end();
      return;
    }
    if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 800));
    const messages = body.messages.map((m: any) =>
      m.role === 'tool'
        ? {
            ...m,
            content: mode === 'marker' ? '<<ccr:123456789abc>>' : 'Compressed fixture result',
          }
        : m,
    );
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        mode === 'invalid'
          ? { messages: [] }
          : {
              messages,
              tokens_before: 400,
              tokens_after: 30,
              ccr_hashes: [],
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    bodies,
    mode: (value: typeof mode) => {
      mode = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}

test('Headroom accepts only local base URLs without credentials, paths, or query parameters', () => {
  assert.equal(headroomUrl('http://localhost:8787/'), 'http://127.0.0.1:8787');
  assert.equal(headroomUrl('http://[::1]:8787'), 'http://[::1]:8787');
  for (const value of [
    'https://example.com',
    'http://192.168.1.2',
    'http://127.0.0.1.attacker.test',
    'http://user:pass@localhost',
    'http://localhost/v1',
    'http://localhost?key=secret',
    'file:///tmp',
  ])
    assert.throws(() => headroomUrl(value), /local base URL/);
});

test('Headroom disabled, small, and original-result reads never send content; enabled compression is stateless', async () => {
  const api = await fixture();
  const observations: CompressionObservation[] = [];
  try {
    const content = 'large fixture output '.repeat(100);
    const config = headroomSchema.parse({
      enabled: true,
      baseUrl: api.baseUrl,
      minCharacters: 500,
    });
    const disabled = new Headroom({ ...config, enabled: false }, () => {});
    assert.equal(await disabled.compress('read_file', content, 'model-a'), content);
    const compressor = new Headroom(config, (e) => observations.push(e));
    assert.equal(await compressor.compress('read_file', 'small', 'model-a'), 'small');
    assert.equal(await compressor.compress('read_file', content, 'model-a', true), content);
    assert.equal(api.bodies.length, 0);
    const compressed = await compressor.compress('read_file', content, 'model-a');
    assert.match(compressed, /raw=true/);
    assert.ok(compressed.length < content.length);
    assert.equal(api.bodies[0].model, 'model-a');
    assert.equal(api.bodies[0].config.protect_recent, 0);
    assert.equal(api.bodies[0].config.session_id, undefined);
    assert.equal(api.bodies[0].config.mode, undefined);
    assert.equal(observations[0].state, 'compressed');
    assert.equal(observations[0].tokensBefore, 400);
    // Raw retrieval retains the original, with no further compression request.
    assert.equal(await compressor.compress('read_file', content, 'model-a', true), content);
    assert.equal(api.bodies.length, 1);
  } finally {
    await api.close();
  }
});

test('Headroom rejects invalid responses, retrieval markers, redirects, and timeouts with original-result fallback', async () => {
  const api = await fixture();
  try {
    for (const mode of ['invalid', 'marker', 'redirect', 'slow'] as const) {
      api.mode(mode);
      const observations: CompressionObservation[] = [];
      const compressor = new Headroom(
        headroomSchema.parse({
          enabled: true,
          baseUrl: api.baseUrl,
          minCharacters: 500,
          timeoutMs: 500,
        }),
        (e) => observations.push(e),
      );
      const content = 'original fixture '.repeat(100);
      assert.equal(await compressor.compress('read_file', content, 'model-a'), content);
      assert.equal(observations[0].state, 'fallback');
      const requests = api.bodies.length;
      assert.equal(await compressor.compress('read_file', content, 'model-a'), content);
      assert.equal(
        api.bodies.length,
        requests,
        'Failed service is not retried for every tool call',
      );
    }
  } finally {
    await api.close();
  }
});

test('Headroom cancellation propagates without treating cancellation as successful tool output', async () => {
  const api = await fixture();
  try {
    api.mode('slow');
    const abort = new AbortController();
    const compressor = new Headroom(
      headroomSchema.parse({ enabled: true, baseUrl: api.baseUrl, minCharacters: 500 }),
      () => {},
      abort.signal,
    );
    const pending = compressor.compress('read_file', 'fixture '.repeat(100), 'model-a');
    abort.abort();
    await assert.rejects(pending, /abort/i);
  } finally {
    await api.close();
  }
});

test('Headroom settings check availability before enabling, persist, and invalidate approved plans', async () => {
  const api = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'agentic-headroom-'));
  let service = new Service(
    dataDir,
    () => {},
    async () => true,
  );
  try {
    assert.equal(service.snapshot().headroom.config.enabled, false);
    const config = headroomSchema.parse({ enabled: true, baseUrl: api.baseUrl });
    service.store.put('workspaces', 'ws', { id: 'ws', graph: { state: 'ready' } });
    service.store.put('plans', 'plan', { id: 'plan', workspaceId: 'ws', state: 'approved' }, 'ws');
    assert.equal((await checkHeadroom(api.baseUrl)).state, 'available');
    api.mode('invalid');
    await assert.rejects(service.command({ type: 'saveHeadroom', config }), /unavailable/);
    assert.equal(service.snapshot().headroom.config.enabled, false);
    api.mode('ok');
    await service.command({ type: 'saveHeadroom', config });
    assert.equal(service.store.get<{ state: string }>('plans', 'plan', 'ws').state, 'stale');
    await service.command({ type: 'settings', ...service.settings(), theme: 'light' });
    assert.equal(
      service.snapshot().headroom.config.enabled,
      true,
      'Unrelated settings preserve Headroom',
    );
    await service.command({ type: 'shutdown' });
    service.store.close();
    service = new Service(
      dataDir,
      () => {},
      async () => true,
    );
    assert.deepEqual(service.snapshot().headroom.config, config);
    api.mode('invalid');
    await service.command({ type: 'saveHeadroom', config: { ...config, enabled: false } });
    assert.equal(
      service.snapshot().headroom.config.enabled,
      false,
      'Disabling never needs a running server',
    );
  } finally {
    await service.command({ type: 'shutdown' });
    service.store.close();
    await api.close();
  }
});
