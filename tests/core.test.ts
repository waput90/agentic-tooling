import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/core/store';
import { validateDag, safePath, redact } from '../electron/core/policy';
import { resolveAgent } from '../electron/core/agents';
import { captureUsage, usageTotal } from '../electron/core/usage';
import { Graphify } from '../electron/core/graphify';
import { git, worktree, snapshotChanges } from '../electron/core/git';
import { Service } from '../electron/core/service';
import type { Agent, Attempt, Plan, Run, Task, Workspace } from '../src/shared';

const temp = () => mkdtemp(join(tmpdir(), 'agentic-test-'));
const task = (id: string, dependsOn: string[] = []): Task => ({
  id,
  title: id,
  prompt: 'Make the requested change',
  role: 'developer',
  dependsOn,
  source: 'auto',
});
const custom: Agent = {
  id: 'custom-dev',
  version: 1,
  name: 'Developer',
  role: 'developer',
  prompt: 'Implement carefully',
  model: 'model-a',
  tools: ['read_file', 'write_file'],
  mcpIds: [],
  archived: false,
};
const limits = { concurrency: 2, maxTokens: 10000, timeoutMinutes: 1 };
async function repo() {
  const root = await temp();
  await git(root, ['init']);
  await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
  await mkdir(join(root, 'graphify-out'));
  await writeFile(join(root, 'graphify-out/graph.json'), JSON.stringify({ nodes: [], links: [] }));
  await git(root, ['add', 'source.ts']);
  await git(root, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Initial',
  ]);
  return root;
}
async function waitFor(fn: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('DAG rejects duplicate IDs, missing prerequisites, and cycles', () => {
  assert.throws(() => validateDag([task('a'), task('a')]), /Duplicate/);
  assert.throws(() => validateDag([task('a', ['b'])]), /Missing/);
  assert.throws(() => validateDag([task('a', ['b']), task('b', ['a'])]), /cycle/);
  validateDag([task('a'), task('b'), task('c', ['a', 'b'])]);
});
test('workspace ownership and foreign keys reject mismatches; WAL backup restores', async () => {
  const root = await temp(),
    store = new Store(join(root, 'db.sqlite'));
  try {
    store.put('workspaces', 'one', { id: 'one' });
    store.put('workspaces', 'two', { id: 'two' });
    store.put('plans', 'plan', { x: 1 }, 'one');
    assert.throws(() => store.get('plans', 'plan', 'two'));
    assert.throws(() => store.put('plans', 'plan', { x: 2 }, 'two'), /ownership/);
    assert.throws(() => store.put('attempts', 'a', {}, 'missing'), /FOREIGN KEY/);
    await store.backup(join(root, 'backup.sqlite'));
    const restored = new Store(join(root, 'backup.sqlite'));
    assert.deepEqual(restored.get('plans', 'plan', 'one'), { x: 1 });
    restored.close();
  } finally {
    store.close();
  }
});
test('filesystem tools reject traversal, protected paths, and symlink escapes', async () => {
  const root = await temp(),
    outside = await temp();
  await writeFile(join(outside, 'secret'), 'private');
  await assert.rejects(safePath(root, '../secret', true), /outside/);
  await assert.rejects(safePath(root, '.git/config', true), /Protected/);
  await symlink(outside, join(root, 'linked'), 'junction');
  await assert.rejects(safePath(root, 'linked/secret'), /Symlink/);
  assert.equal(
    await safePath(root, 'new/file.ts', true),
    join(await realpath(root), 'new/file.ts'),
  );
});
test('repository role wins, absent role falls back, instructions accompany both, duplicates fail visibly', async () => {
  const root = await temp();
  await mkdir(join(root, '.github/agents'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'Follow repository rules');
  await writeFile(
    join(root, '.github/agents/reviewer.agent.md'),
    '---\nname: reviewer\nmodel: model-b\n---\nReview code',
  );
  const ws = { id: 'w', root, model: 'model-a' } as Workspace;
  const reviewer = await resolveAgent(ws, 'reviewer', [custom], ['model-a', 'model-b']);
  assert.equal(reviewer.source, 'repository');
  assert.equal(reviewer.model, 'model-b');
  const developer = await resolveAgent(ws, 'developer', [custom], ['model-a', 'model-b']);
  assert.equal(developer.source, 'custom');
  assert.match(developer.instructions, /Follow repository rules/);
  await writeFile(
    join(root, '.github/agents/other.agent.md'),
    '---\nname: reviewer\n---\nDuplicate',
  );
  await assert.rejects(resolveAgent(ws, 'developer', [custom], ['model-a']), /Ambiguous/);
});
test('model inheritance and explicit custom override preserve source and reject unavailable models', async () => {
  const root = await temp();
  await mkdir(join(root, '.github/agents'), { recursive: true });
  await writeFile(
    join(root, '.github/agents/developer.agent.md'),
    '---\nname: developer\n---\nRepository developer',
  );
  const ws = { id: 'w', root, model: 'model-b' } as Workspace;
  assert.equal(
    (await resolveAgent(ws, 'developer', [custom], ['model-a', 'model-b'])).model,
    'model-b',
  );
  assert.equal(
    (await resolveAgent(ws, 'developer', [custom], ['model-a', 'model-b'], 'custom')).model,
    'model-a',
  );
  await assert.rejects(resolveAgent(ws, 'developer', [custom], ['model-a']), /unavailable/);
});
test('usage replay deduplicates; unknown counters stay null; cache and reasoning never inflate totals', async () => {
  const store = new Store(join(await temp(), 'db.sqlite'));
  try {
    store.put('workspaces', 'w', { id: 'w' });
    const a: Attempt = {
      id: 'a',
      workspaceId: 'w',
      runId: 'r',
      taskId: 't',
      agentId: 'g',
      requestedModel: 'requested',
      state: 'running',
      coverage: 'unknown',
      startedAt: '',
    };
    store.put('attempts', a.id, a, 'w');
    const event = {
      id: 'event',
      type: 'assistant.usage',
      timestamp: '2026-10-29',
      data: {
        model: 'reported',
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 12,
        cacheReadTokens: 50,
      },
    };
    captureUsage(store, a, event);
    captureUsage(store, a, event);
    assert.equal(store.list('usage').length, 1);
    assert.deepEqual(usageTotal(store.list('usage')), { input: 10, output: 20, partial: false });
    assert.equal(store.get<Attempt>('attempts', 'a', 'w').reportedModel, 'reported');
    captureUsage(store, a, { ...event, id: 'missing', data: { model: 'reported' } });
    assert.equal(usageTotal(store.list('usage')).partial, true);
    assert.equal(usageTotal(store.list('usage')).output, 20);
    captureUsage(store, a, { ...event, id: 'occupancy', type: 'session.usage_info' });
    assert.equal(store.list('usage').length, 2);
  } finally {
    store.close();
  }
});
test('redaction covers secrets, nested headers, and provider tokens without hiding token counters', () => {
  const value = redact(
    {
      Authorization: 'Bearer aaa',
      nested: { password: 'hidden' },
      text: 'Bearer xyz ghp_test abc123',
      inputTokens: 12,
    },
    ['abc123'],
  );
  assert.deepEqual(value, {
    Authorization: '[REDACTED]',
    nested: { password: '[REDACTED]' },
    text: 'Bearer [REDACTED] [REDACTED] [REDACTED]',
    inputTokens: 12,
  });
});
test('Graphify reuses a valid graph and exposes corrupt graph without replacing it', async () => {
  const root = await temp();
  await mkdir(join(root, 'graphify-out'));
  const path = join(root, 'graphify-out/graph.json');
  await writeFile(path, JSON.stringify({ nodes: [{ id: 'a' }], links: [] }));
  const graph = new Graphify(await temp(), () => {});
  assert.equal((await graph.ensure('w', root)).nodes, 1);
  await writeFile(path, 'broken');
  assert.equal((await graph.ensure('w', root)).state, 'invalid');
  assert.equal(await readFile(path, 'utf8'), 'broken');
});
test('isolated worktree changes leave source checkout untouched and provide a reviewable commit', async () => {
  const root = await repo(),
    base = await git(root, ['rev-parse', 'HEAD']),
    path = join(await temp(), 'task');
  await worktree(root, path, base);
  await writeFile(join(path, 'source.ts'), 'export const value = 2;\n');
  const result = await snapshotChanges(path);
  assert.match(result.diff, /value = 2/);
  assert.notEqual(result.commit, base);
  assert.match(await readFile(join(root, 'source.ts'), 'utf8'), /value = 1/);
});
test('direct execution fails before approval; source edits invalidate an approved snapshot; recovery never replays work', async () => {
  const root = await repo(),
    dataDir = await temp();
  let service = new Service(
    dataDir,
    () => {},
    async () => true,
  );
  try {
    const ws = (await service.command({ type: 'addWorkspace', path: root })) as Workspace;
    await service.graphify.ensure(ws.id, root);
    service.runtime = { state: 'connected', models: [{ id: 'model-a', name: 'A' }] };
    await service.command({ type: 'saveAgent', agent: { ...custom, id: undefined } });
    const plan = (await service.command({
      type: 'savePlan',
      workspaceId: ws.id,
      title: 'Test',
      tasks: [task('a')],
      limits,
    })) as Plan;
    await assert.rejects(
      service.command({ type: 'execute', workspaceId: ws.id, planId: plan.id }),
      /approved/,
    );
    await assert.rejects(
      service.command({
        type: 'approve',
        workspaceId: ws.id,
        planId: plan.id,
        hash: 'wrong',
        decision: 'approve',
      }),
      /changed/,
    );
    await service.command({
      type: 'approve',
      workspaceId: ws.id,
      planId: plan.id,
      hash: plan.hash,
      decision: 'approve',
    });
    await writeFile(join(root, 'AGENTS.md'), 'Changed instructions');
    await assert.rejects(
      service.command({ type: 'execute', workspaceId: ws.id, planId: plan.id }),
      /changed/,
    );
    assert.equal(service.store.get<Plan>('plans', plan.id, ws.id).state, 'stale');
    service.store.put('runs', 'r', { id: 'r', workspaceId: ws.id, state: 'running' }, ws.id);
    service.store.put(
      'attempts',
      'a',
      { id: 'a', workspaceId: ws.id, state: 'running', coverage: 'observed' },
      ws.id,
    );
    await service.command({ type: 'shutdown' });
    service.store.put('runs', 'r', { id: 'r', workspaceId: ws.id, state: 'running' }, ws.id);
    service.store.put(
      'attempts',
      'a',
      { id: 'a', workspaceId: ws.id, state: 'running', coverage: 'observed' },
      ws.id,
    );
    service.store.close();
    service = new Service(
      dataDir,
      () => {},
      async () => true,
    );
    assert.equal(service.store.get<Attempt>('attempts', 'a', ws.id).state, 'interrupted');
    assert.equal(service.store.get<Attempt>('attempts', 'a', ws.id).coverage, 'partial');
    assert.equal(service.store.get<Run>('runs', 'r', ws.id).state, 'interrupted');
  } finally {
    await service.command({ type: 'shutdown' });
    service.store.close();
  }
});
test('fair scheduling overlaps two repositories, honors cap and dependency order, and hands off changes', async () => {
  const dataDir = await temp(),
    started: string[] = [],
    gates = new Map<string, () => void>();
  const service = new Service(
    dataDir,
    () => {},
    async () => true,
    async (job, a) => {
      assert.ok(a);
      started.push(`${a.workspaceId}:${a.taskId}`);
      await new Promise<void>((r) => gates.set(a.id, r));
      await writeFile(join(job.root, `${a.taskId}.txt`), 'result');
      return { output: `Result ${a.taskId}`, sessionId: a.id };
    },
  );
  try {
    service.runtime = { state: 'connected', models: [{ id: 'model-a', name: 'A' }] };
    await service.command({
      type: 'settings',
      globalConcurrency: 2,
      selectedWorkspace: 'all',
      theme: 'dark',
    });
    await service.command({ type: 'saveAgent', agent: { ...custom, id: undefined } });
    const workspaces: Workspace[] = [];
    for (let i = 0; i < 2; i++) {
      const root = await repo();
      const ws = (await service.command({ type: 'addWorkspace', path: root })) as Workspace;
      await service.graphify.ensure(ws.id, root);
      workspaces.push(ws);
      const p = (await service.command({
        type: 'savePlan',
        workspaceId: ws.id,
        title: 'Parallel',
        tasks: [task('a'), task('b', ['a']), task('c', ['b'])],
        limits,
      })) as Plan;
      await service.command({
        type: 'approve',
        workspaceId: ws.id,
        planId: p.id,
        hash: p.hash,
        decision: 'approve',
      });
      await service.command({ type: 'execute', workspaceId: ws.id, planId: p.id });
    }
    await service.tick();
    await waitFor(() => started.length === 2);
    assert.equal(new Set(started.map((s) => s.split(':')[0])).size, 2);
    assert.ok(started.every((s) => s.endsWith(':a')));
    await service.tick();
    assert.equal(started.length, 2);
    for (const resolve of gates.values()) resolve();
    await waitFor(
      () =>
        service.store.list<Attempt>('attempts').filter((a) => a.state === 'succeeded').length === 2,
    );
    await service.tick();
    await waitFor(() => started.length === 4);
    for (const a of service.store.list<Attempt>('attempts').filter((a) => a.taskId === 'b')) {
      assert.match(a.context!, /Result a/);
      assert.equal(await readFile(join(a.worktree!, 'a.txt'), 'utf8'), 'result');
    }
    for (const resolve of gates.values()) resolve();
    await waitFor(
      () =>
        service.store.list<Attempt>('attempts').filter((a) => a.state === 'succeeded').length === 4,
    );
    await service.tick();
    await waitFor(() => started.length === 6);
    for (const a of service.store.list<Attempt>('attempts').filter((a) => a.taskId === 'c')) {
      assert.equal(await readFile(join(a.worktree!, 'a.txt'), 'utf8'), 'result');
      assert.equal(await readFile(join(a.worktree!, 'b.txt'), 'utf8'), 'result');
    }
    for (const resolve of gates.values()) resolve();
    await waitFor(() =>
      service.store.list<Attempt>('attempts').every((a) => a.state === 'succeeded'),
    );
    await service.tick();
    assert.ok(service.store.list<Run>('runs').every((r) => r.state === 'succeeded'));
  } finally {
    for (const resolve of gates.values()) resolve();
    await service.command({ type: 'shutdown' });
    service.store.close();
  }
});

test('saving MCP does not execute a process; bindings cannot cross workspace boundaries', async () => {
  const dataDir = await temp();
  let invocations = 0;
  const service = new Service(
    dataDir,
    () => {},
    async () => true,
    async () => {
      invocations++;
      return {};
    },
  );
  try {
    service.runtime = { state: 'connected', models: [{ id: 'model-a', name: 'A' }] };
    const one = (await service.command({ type: 'addWorkspace', path: await repo() })) as Workspace;
    const two = (await service.command({ type: 'addWorkspace', path: await repo() })) as Workspace;
    await Promise.all([
      service.graphify.ensure(one.id, one.root),
      service.graphify.ensure(two.id, two.root),
    ]);
    const server = (await service.command({
      type: 'saveMcp',
      workspaceId: one.id,
      server: {
        name: 'fixture',
        transport: 'stdio',
        endpoint: 'node',
        args: ['server.js'],
        tools: ['read_fixture'],
        auth: 'none',
        secretName: 'TOKEN',
        enabled: true,
      },
    })) as { id: string };
    assert.equal(invocations, 0);
    await service.command({
      type: 'saveAgent',
      agent: { ...custom, id: undefined, mcpIds: [server.id] },
    });
    await assert.rejects(
      service.command({
        type: 'savePlan',
        workspaceId: two.id,
        title: 'Cross workspace',
        tasks: [task('a')],
        limits,
      }),
      /not found/,
    );
  } finally {
    await service.command({ type: 'shutdown' });
    service.store.close();
  }
});

test('a failed prerequisite blocks descendants; cancellation prevents queued dispatch', async () => {
  const service = new Service(
    await temp(),
    () => {},
    async () => true,
    async () => {
      throw new Error('Test failure');
    },
  );
  try {
    service.runtime = { state: 'connected', models: [{ id: 'model-a', name: 'A' }] };
    await service.command({ type: 'saveAgent', agent: { ...custom, id: undefined } });
    const ws = (await service.command({ type: 'addWorkspace', path: await repo() })) as Workspace;
    await service.graphify.ensure(ws.id, ws.root);
    const p = (await service.command({
      type: 'savePlan',
      workspaceId: ws.id,
      title: 'Failure propagation',
      tasks: [task('a'), task('b', ['a'])],
      limits,
    })) as Plan;
    await service.command({
      type: 'approve',
      workspaceId: ws.id,
      planId: p.id,
      hash: p.hash,
      decision: 'approve',
    });
    const r = (await service.command({ type: 'execute', workspaceId: ws.id, planId: p.id })) as Run;
    await service.tick();
    await waitFor(() => service.store.list<Attempt>('attempts').some((a) => a.state === 'failed'));
    await service.tick();
    assert.equal(service.store.get<Attempt>('attempts', `${r.id}:b`, ws.id).state, 'blocked');
    const p2 = (await service.command({
      type: 'savePlan',
      workspaceId: ws.id,
      title: 'Cancelled',
      tasks: [task('c')],
      limits,
    })) as Plan;
    await service.command({
      type: 'approve',
      workspaceId: ws.id,
      planId: p2.id,
      hash: p2.hash,
      decision: 'approve',
    });
    const r2 = (await service.command({
      type: 'execute',
      workspaceId: ws.id,
      planId: p2.id,
    })) as Run;
    await service.command({ type: 'control', workspaceId: ws.id, runId: r2.id, action: 'cancel' });
    await service.tick();
    assert.equal(service.store.get<Attempt>('attempts', `${r2.id}:c`, ws.id).state, 'cancelled');
  } finally {
    await service.command({ type: 'shutdown' });
    service.store.close();
  }
});

test('portable definitions redact secrets, preserve dependency graphs, and import inert workspace bindings', async () => {
  const service = new Service(
    await temp(),
    () => {},
    async (action, data) => (action === 'decrypt' ? 'private-api-value' : data),
  );
  try {
    const one = (await service.command({ type: 'addWorkspace', path: await repo() })) as Workspace;
    const two = (await service.command({ type: 'addWorkspace', path: await repo() })) as Workspace;
    await Promise.all([
      service.graphify.ensure(one.id, one.root),
      service.graphify.ensure(two.id, two.root),
    ]);
    await service.command({
      type: 'saveAgent',
      agent: { ...custom, id: undefined, prompt: 'Do not expose private-api-value' },
    });
    await service.command({
      type: 'saveMcp',
      workspaceId: one.id,
      server: {
        name: 'remote',
        transport: 'http',
        endpoint: 'https://example.test/mcp',
        args: [],
        tools: ['read'],
        auth: 'bearer',
        secretName: 'Authorization',
        enabled: true,
      },
      secret: 'private-api-value',
    });
    await service.command({
      type: 'addContext',
      workspaceId: one.id,
      text: 'Retain decisions',
      kind: 'decision',
    });
    const exported = (await service.command({ type: 'export' })) as Record<string, unknown>;
    assert.ok(!JSON.stringify(exported).includes('private-api-value'));
    const imported = (await service.command({
      type: 'import',
      targetWorkspaceId: two.id,
      data: {
        ...exported,
        workflows: [
          { id: 'template', title: 'Imported chain', tasks: [task('a'), task('b', ['a'])], limits },
        ],
      },
    })) as { mappings: Record<string, string> };
    assert.ok(imported.mappings.template);
    assert.equal(service.snapshot().templates[0].tasks[1].dependsOn[0], 'a');
    const server = service.store.list<{ enabled: boolean; secretRef?: string }>('mcp', two.id)[0];
    assert.equal(server.enabled, false);
    assert.equal(server.secretRef, undefined);
    assert.ok(service.store.list<Agent>('agents').some((a) => a.archived));
    assert.equal(
      service.store.list<{ text: string }>('context', two.id)[0].text,
      'Retain decisions',
    );
    assert.equal(service.store.list('approvals', two.id).length, 0);
  } finally {
    await service.command({ type: 'shutdown' });
    service.store.close();
  }
});

test('silent update preparation refuses queued work and fences new admissions when idle', async () => {
  const service = new Service(
    await temp(),
    () => {},
    async () => true,
  );
  try {
    const ws = (await service.command({ type: 'addWorkspace', path: await repo() })) as Workspace;
    await service.graphify.ensure(ws.id, ws.root);
    service.store.put(
      'runs',
      'queued',
      { id: 'queued', workspaceId: ws.id, state: 'queued' },
      ws.id,
    );
    await assert.rejects(service.command({ type: 'prepareUpdate' }), /deferred/);
    service.store.put(
      'runs',
      'queued',
      { id: 'queued', workspaceId: ws.id, state: 'cancelled' },
      ws.id,
    );
    await service.command({ type: 'prepareUpdate' });
    await assert.rejects(
      service.command({ type: 'saveAgent', agent: { ...custom, id: undefined } }),
      /closing/,
    );
  } finally {
    await service.command({ type: 'shutdown' });
    service.store.close();
  }
});

test('planning creates only an unapproved draft and context summaries retain provenance', async () => {
  const service = new Service(
    await temp(),
    () => {},
    async () => true,
    async (job, a) => ({
      output: job.summarizing
        ? 'Summary of selected constraints'
        : JSON.stringify({ title: 'Generated proposal', tasks: [task('implementation')] }),
      sessionId: a!.id,
    }),
  );
  try {
    service.runtime = { state: 'connected', models: [{ id: 'model-a', name: 'A' }] };
    await service.command({ type: 'saveAgent', agent: { ...custom, id: undefined } });
    await service.command({
      type: 'saveAgent',
      agent: {
        ...custom,
        id: undefined,
        name: 'Planner',
        role: 'planner',
        tools: ['read_file', 'graph_query'],
      },
    });
    const ws = (await service.command({ type: 'addWorkspace', path: await repo() })) as Workspace;
    await service.graphify.ensure(ws.id, ws.root);
    await service.command({
      type: 'addContext',
      workspaceId: ws.id,
      text: 'Keep the API contract',
      kind: 'constraint',
    });
    const run = (await service.command({
      type: 'plan',
      workspaceId: ws.id,
      prompt: 'Plan a change',
      role: 'planner',
    })) as Run;
    await service.tick();
    await waitFor(
      () =>
        service.store.get<Attempt>('attempts', `${run.id}:planning`, ws.id).state === 'succeeded',
    );
    const draft = (await service.command({
      type: 'draftFromPlanning',
      workspaceId: ws.id,
      attemptId: `${run.id}:planning`,
    })) as Plan;
    assert.equal(draft.state, 'draft');
    assert.equal(service.store.list('approvals', ws.id).length, 0);
    await assert.rejects(
      service.command({ type: 'execute', workspaceId: ws.id, planId: draft.id }),
      /approved/,
    );
    const summary = (await service.command({
      type: 'summarizeContext',
      workspaceId: ws.id,
    })) as Run;
    await service.tick();
    await waitFor(() =>
      service.store
        .list<{ provenance?: string }>('context', ws.id)
        .some((c) => c.provenance?.includes(summary.id)),
    );
    assert.ok(
      service.store
        .list<{ text: string }>('context', ws.id)
        .some((c) => c.text === 'Summary of selected constraints'),
    );
  } finally {
    await service.command({ type: 'shutdown' });
    service.store.close();
  }
});

test('retention removes only eligible completed detail and preserves replay-blocking identities', async () => {
  const service = new Service(
    await temp(),
    () => {},
    async () => true,
  );
  try {
    const ws = (await service.command({ type: 'addWorkspace', path: await repo() })) as Workspace;
    await service.graphify.ensure(ws.id, ws.root);
    for (const [id, integrated] of [
      ['old', true],
      ['unreviewed', false],
    ] as const) {
      service.store.put(
        'runs',
        id,
        { id, workspaceId: ws.id, state: 'succeeded', createdAt: '2020-01-01' },
        ws.id,
      );
      service.store.put(
        'attempts',
        `${id}:a`,
        {
          id: `${id}:a`,
          workspaceId: ws.id,
          runId: id,
          state: 'succeeded',
          diff: 'changes',
          integrated,
          output: 'evidence',
        },
        ws.id,
      );
      service.store.put('events', `${id}:event`, { attemptId: `${id}:a`, data: 'detail' }, ws.id);
    }
    await service.command({ type: 'pruneHistory', days: 90 });
    assert.equal(service.store.get<Run>('runs', 'old', ws.id).state, 'pruned');
    assert.equal(service.store.get<Attempt>('attempts', 'old:a', ws.id).output, undefined);
    assert.equal(service.store.get<Attempt>('attempts', 'unreviewed:a', ws.id).output, 'evidence');
    assert.equal(service.store.list('events', ws.id).length, 1);
  } finally {
    await service.command({ type: 'shutdown' });
    service.store.close();
  }
});
