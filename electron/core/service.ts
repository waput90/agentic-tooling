import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Worker } from 'node:worker_threads';
import { join, resolve, relative } from 'node:path';
import { mkdir, stat, realpath } from 'node:fs/promises';
import type { MCPServerConfig } from '@github/copilot-sdk';
import {
  agentSchema,
  mcpSchema,
  taskSchema,
  workflowTemplateSchema,
  commandSchema,
  limitsSchema,
  headroomSchema,
  type Agent,
  type Attempt,
  type Command,
  type ContextItem,
  type Mcp,
  type Plan,
  type Run,
  type Snapshot,
  type Task,
  type Workspace,
  type Usage,
  type WorkflowTemplate,
} from '../../src/shared';
import { Store } from './store';
import { hash, redact, validateDag, prerequisiteOrder, contained } from './policy';
import { baseline, git, repository, snapshotChanges, worktree } from './git';
import { discover, resolveAgent } from './agents';
import { Graphify } from './graphify';
import { captureUsage } from './usage';
import type { Job } from '../copilot-worker';
import { checkHeadroom, headroomUrl } from './headroom';
import { searchMcpDirectory } from './mcp-directory';

type Host = (type: string, data: unknown) => Promise<unknown>;
export class Service {
  readonly store: Store;
  readonly graphify: Graphify;
  runtime: Snapshot['runtime'] = { state: 'unchecked', models: [] };
  private headroomStatus: Snapshot['headroom']['status'] = {
    state: 'unchecked',
    baseUrl: 'http://127.0.0.1:8787',
  };
  private active = new Map<string, Worker>();
  private locks = new Map<string, Promise<unknown>>();
  private ticking = false;
  private cursor = 0;
  private closing = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    readonly dataDir: string,
    private changed: () => void,
    private host: Host,
    private testRunner?: (job: Job, attempt?: Attempt) => Promise<unknown>,
  ) {
    this.store = new Store(join(dataDir, 'agentic.sqlite'));
    for (const workspace of this.store.list<Workspace>('workspaces'))
      if (['checking', 'building', 'installing'].includes(workspace.graph.state))
        this.store.put('workspaces', workspace.id, {
          ...workspace,
          graph: {
            state: 'interrupted',
            detail: 'Indexing was interrupted. Select the workspace to check or rebuild its graph.',
          },
        });
    for (const attempt of this.store.list<Attempt>('attempts'))
      if (['running', 'queued'].includes(attempt.state))
        this.store.put(
          'attempts',
          attempt.id,
          {
            ...attempt,
            state: 'interrupted',
            coverage: 'partial',
            error: 'Application stopped. Review worktree and create a new approved run.',
          },
          attempt.workspaceId,
        );
    for (const run of this.store.list<Run>('runs'))
      if (['running', 'queued', 'paused'].includes(run.state))
        this.store.put('runs', run.id, { ...run, state: 'interrupted' }, run.workspaceId);
    this.graphify = new Graphify(dataDir, (id, graph) => {
      const ws = this.ws(id);
      this.store.put('workspaces', id, { ...ws, graph });
      this.changed();
    });
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 600);
  }
  ws(id: string) {
    return this.store.get<Workspace>('workspaces', id);
  }
  settings(): Snapshot['settings'] {
    try {
      const stored = this.store.get<Partial<Snapshot['settings']>>('settings', 'app');
      return {
        globalConcurrency: stored.globalConcurrency ?? 3,
        selectedWorkspace: stored.selectedWorkspace ?? 'all',
        theme: stored.theme ?? 'dark',
        autoApprovePlans: stored.autoApprovePlans ?? false,
        autoContinueTokens: stored.autoContinueTokens ?? false,
      };
    } catch {
      return {
        globalConcurrency: 3,
        selectedWorkspace: 'all',
        theme: 'dark',
        autoApprovePlans: false,
        autoContinueTokens: false,
      };
    }
  }
  snapshot(): Snapshot {
    return {
      headroom: { config: this.headroomConfig(), status: this.headroomStatus },
      templates: this.templates(),
      workspaces: this.store.list('workspaces'),
      agents: this.store.list('agents'),
      plans: this.store.list('plans'),
      runs: this.store.list('runs'),
      attempts: this.store.list('attempts'),
      mcp: this.store.list('mcp'),
      context: this.store.list('context'),
      usage: this.store.list('usage'),
      settings: this.settings(),
      runtime: this.runtime,
    };
  }
  private headroomConfig() {
    try {
      return headroomSchema.parse(this.store.get('settings', 'headroom'));
    } catch {
      return headroomSchema.parse({});
    }
  }
  private templates(): WorkflowTemplate[] {
    try {
      return this.store.get<WorkflowTemplate[]>('settings', 'templates');
    } catch {
      return [];
    }
  }
  async command(input: Command): Promise<unknown> {
    const command = commandSchema.parse(input);
    if (this.closing && command.type !== 'shutdown' && command.type !== 'snapshot')
      throw new Error('Application is closing; new work is not accepted.');
    if ('workspaceId' in command) this.ws(command.workspaceId);
    const result = await this.dispatch(command);
    this.changed();
    return result;
  }
  private async dispatch(c: Command): Promise<unknown> {
    switch (c.type) {
      case 'checkHeadroom':
        this.headroomStatus = await checkHeadroom(c.baseUrl);
        return this.headroomStatus;
      case 'saveHeadroom': {
        const config = { ...c.config, baseUrl: headroomUrl(c.config.baseUrl) };
        if (config.enabled) {
          this.headroomStatus = await checkHeadroom(config.baseUrl);
          if (this.headroomStatus.state !== 'available') {
            this.changed();
            throw new Error(this.headroomStatus.detail);
          }
        }
        if (hash(config) !== hash(this.headroomConfig()))
          for (const ws of this.store.list<Workspace>('workspaces')) this.invalidate(ws.id);
        this.store.put('settings', 'headroom', config);
        return config;
      }
      case 'snapshot':
        return this.snapshot();
      case 'addWorkspace': {
        const repo = await repository(c.path),
          key = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
        const duplicate = this.store
          .list<Workspace>('workspaces')
          .find((w) => key(w.root) === key(repo.root));
        if (duplicate) {
          void this.graphify.ensure(duplicate.id, duplicate.root);
          return duplicate;
        }
        const ws: Workspace = {
          id: randomUUID(),
          name: repo.root.split(/[\\/]/).at(-1)!,
          ...repo,
          model: '',
          concurrency: 2,
          graph: { state: 'checking' },
        };
        this.store.put('workspaces', ws.id, ws);
        void this.graphify.ensure(ws.id, ws.root);
        return ws;
      }
      case 'workspaceSettings': {
        const ws = this.ws(c.workspaceId);
        this.store.put('workspaces', ws.id, { ...ws, model: c.model, concurrency: c.concurrency });
        this.invalidate(c.workspaceId);
        return;
      }
      case 'graphify':
        return this.graphify.ensure(c.workspaceId, this.ws(c.workspaceId).root, c.rebuild);
      case 'saveAgent': {
        const old = c.agent.id ? this.store.get<Agent>('agents', c.agent.id) : undefined;
        const agent = { ...c.agent, id: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1 };
        this.store.put('agents', agent.id, agent);
        for (const ws of this.store.list<Workspace>('workspaces')) this.invalidate(ws.id);
        return agent;
      }
      case 'previewAgents': {
        const ws = this.ws(c.workspaceId);
        return {
          repository: await discover(ws.root),
          custom: this.store.list<Agent>('agents').filter((a) => !a.archived),
        };
      }
      case 'login':
      case 'runtime': {
        this.runtime = { ...this.runtime, state: 'checking' };
        this.changed();
        try {
          this.runtime = (await this.worker({
            kind: c.type === 'login' ? 'login' : 'catalog',
            root: this.dataDir,
            dataDir: join(this.dataDir, 'runtime', 'identity'),
          })) as Snapshot['runtime'];
        } catch (e) {
          this.runtime = { state: 'failed', models: [], error: (e as Error).message };
        }
        return this.runtime;
      }
      case 'savePlan':
        return this.makePlan(c.workspaceId, c.title, c.tasks, c.limits);
      case 'reviseDraft': {
        const original = this.store.get<Plan>('plans', c.planId, c.workspaceId);
        if (original.deleted || original.state !== 'draft' || original.hash !== c.hash)
          throw new Error('Draft changed. Reopen the latest approval before editing.');
        if (this.store.list<Run>('runs', c.workspaceId).some((run) => run.planId === original.id))
          throw new Error('This draft already has a run. Create a new workflow.');
        const replacement = await this.makePlan(c.workspaceId, c.title, c.tasks, c.limits);
        const current = this.store.get<Plan>('plans', c.planId, c.workspaceId);
        if (current.deleted || current.state !== 'draft' || current.hash !== c.hash) {
          this.store.remove('plans', replacement.id, c.workspaceId);
          throw new Error('Draft changed during editing. Reopen the latest approval.');
        }
        this.store.put('plans', original.id, { ...current, deleted: true }, c.workspaceId);
        return replacement;
      }
      case 'approve': {
        const plan = this.store.get<Plan>('plans', c.planId, c.workspaceId);
        if (plan.deleted) throw new Error('This approval was deleted. Create a new workflow.');
        if (plan.state !== 'draft') throw new Error('Only a draft can be approved or rejected.');
        if (plan.hash !== c.hash) throw new Error('Plan changed. Review the latest preview.');
        if (c.decision === 'approve') {
          await this.verify(plan);
          const approved = await this.host('confirm', {
            title: 'Approve execution scope',
            detail: `Workspace: ${this.ws(c.workspaceId).root}\nPlan: ${plan.title}\nHash: ${plan.hash}\nBase: ${plan.base}\nConcurrency: ${plan.limits.concurrency}\nToken dispatch threshold: ${plan.limits.maxTokens}\n\n${plan.tasks.map((t) => `${t.id}: ${t.title}\n${t.agent.source}: ${t.agent.sourcePath}\nModel: ${t.agent.model}\nTools: ${t.agent.tools.join(', ')}\nDepends on: ${t.dependsOn.join(', ') || 'none'}`).join('\n\n')}\n\nCommands, MCP access, and integration will request separate approval.`,
          });
          if (!approved) throw new Error('Approval cancelled');
          await this.verify(plan);
        }
        const current = this.store.get<Plan>('plans', c.planId, c.workspaceId);
        if (current.deleted || current.state !== 'draft' || current.hash !== c.hash)
          throw new Error('Draft changed during review. Reopen the latest approval.');
        const approval = {
          id: randomUUID(),
          workspaceId: c.workspaceId,
          planId: plan.id,
          hash: plan.hash,
          decision: c.decision,
          createdAt: new Date().toISOString(),
        };
        this.store.transaction(() => {
          this.store.put('approvals', approval.id, approval, c.workspaceId);
          this.store.put(
            'plans',
            plan.id,
            { ...plan, state: c.decision === 'approve' ? 'approved' : 'rejected' },
            c.workspaceId,
          );
        });
        return;
      }
      case 'execute': {
        const plan = this.store.get<Plan>('plans', c.planId, c.workspaceId);
        if (plan.deleted) throw new Error('This approval was deleted. Create a new workflow.');
        if (plan.state !== 'approved') throw new Error('A matching approved plan is required');
        await this.verify(plan);
        const approvals = this.store.list<{ planId: string; hash: string; decision: string }>(
          'approvals',
          c.workspaceId,
        );
        if (
          this.store.get<Plan>('plans', plan.id, c.workspaceId).state !== 'approved' ||
          !approvals.some(
            (a) => a.planId === plan.id && a.hash === plan.hash && a.decision === 'approve',
          )
        )
          throw new Error('Approval record missing or revoked');
        if (this.store.list<Run>('runs', c.workspaceId).some((r) => r.planId === plan.id))
          throw new Error(
            'This plan has already run. Review results and create a new plan for an explicit retry.',
          );
        const run: Run = {
          id: randomUUID(),
          workspaceId: c.workspaceId,
          planId: plan.id,
          state: 'queued',
          mode: 'execute',
          createdAt: new Date().toISOString(),
        };
        this.store.transaction(() => {
          this.store.put('runs', run.id, run, c.workspaceId);
          for (const task of plan.tasks)
            this.store.put(
              'attempts',
              `${run.id}:${task.id}`,
              this.newAttempt(run, task),
              c.workspaceId,
            );
        });
        return run;
      }
      case 'restartRun': {
        const previous = this.store.get<Run>('runs', c.runId, c.workspaceId);
        if (previous.deleted || previous.mode !== 'execute' || previous.state !== 'failed')
          throw new Error('Only a failed execution can be restarted.');
        const plan = this.store.get<Plan>('plans', previous.planId, c.workspaceId);
        if (plan.deleted || plan.state !== 'approved')
          throw new Error('The original plan is no longer approved. Create a fresh draft.');
        if (
          this.store
            .list<Run>('runs', c.workspaceId)
            .some((r) => r.planId === plan.id && ['queued', 'running', 'paused'].includes(r.state))
        )
          throw new Error('This plan already has an active run.');
        await this.verify(plan);
        if (
          !this.store
            .list<{ planId: string; hash: string; decision: string }>('approvals', c.workspaceId)
            .some((a) => a.planId === plan.id && a.hash === plan.hash && a.decision === 'approve')
        )
          throw new Error('Approval record missing or revoked.');
        if (
          !(await this.host('confirm', {
            title: 'Restart failed execution',
            detail: `Repository: ${this.ws(c.workspaceId).root}\nPlan: ${plan.title}\nHash: ${plan.hash}\nAll ${plan.tasks.length} tasks will run again in new worktrees. Previous results remain for review, and Copilot usage may increase.`,
          }))
        )
          throw new Error('Restart cancelled');
        await this.verify(plan);
        const current = this.store.get<Run>('runs', c.runId, c.workspaceId);
        if (
          current.state !== 'failed' ||
          this.store.get<Plan>('plans', plan.id, c.workspaceId).state !== 'approved'
        )
          throw new Error('Run or approval changed during restart.');
        if (
          this.store
            .list<Run>('runs', c.workspaceId)
            .some((r) => r.planId === plan.id && ['queued', 'running', 'paused'].includes(r.state))
        )
          throw new Error('This plan already has an active run.');
        const run: Run = {
          id: randomUUID(),
          workspaceId: c.workspaceId,
          planId: plan.id,
          state: 'queued',
          mode: 'execute',
          createdAt: new Date().toISOString(),
          retryOf: previous.id,
        };
        this.store.transaction(() => {
          this.store.put('runs', run.id, run, c.workspaceId);
          for (const task of plan.tasks)
            this.store.put(
              'attempts',
              `${run.id}:${task.id}`,
              this.newAttempt(run, task),
              c.workspaceId,
            );
        });
        return run;
      }
      case 'plan': {
        const ws = this.ws(c.workspaceId),
          agent = await resolveAgent(
            ws,
            c.role,
            this.store.list('agents'),
            this.runtime.models.map((m) => m.id),
          );
        const run: Run = {
          id: randomUUID(),
          workspaceId: ws.id,
          planId: 'planning',
          state: 'queued',
          mode: 'plan',
          createdAt: new Date().toISOString(),
        };
        const task = {
          id: 'planning',
          title: 'Read-only planning',
          prompt: `${c.prompt}\n\nFor an executable planning proposal, return JSON only with shape {"title":"short title","tasks":[{"id":"task-1","title":"task title","prompt":"specific implementation instructions","role":"developer","dependsOn":[],"source":"auto"}]}. Roles available as custom fallbacks: ${this.store
            .list<Agent>('agents')
            .filter((a) => !a.archived)
            .map((a) => a.role)
            .join(
              ', ',
            )}. Repository roles may also be used. Never claim this proposal grants execution approval.`,
          role: c.role,
          dependsOn: [],
          source: 'auto' as const,
          agent,
          mcp: [],
        };
        const plan: Plan = {
          id: `planning:${run.id}`,
          workspaceId: ws.id,
          title: c.prompt.slice(0, 100),
          revision: 1,
          base: await baseline(ws.root),
          tasks: [task],
          limits: { concurrency: 1, maxTokens: 100000, timeoutMinutes: 15 },
          context: this.store.list('context', ws.id),
          hash: 'planning',
          headroom: this.headroomConfig().enabled ? this.headroomConfig() : undefined,
          state: 'draft',
          createdAt: run.createdAt,
        };
        run.planId = plan.id;
        this.store.transaction(() => {
          this.store.put('plans', plan.id, plan, ws.id);
          this.store.put('runs', run.id, run, ws.id);
          const attempt = this.newAttempt(run, task);
          this.store.put('attempts', attempt.id, attempt, ws.id);
        });
        return run;
      }
      case 'summarizeContext': {
        const run = (await this.dispatch({
          type: 'plan',
          workspaceId: c.workspaceId,
          role: 'planner',
          prompt:
            'Summarize the selected context below, preserving goals, constraints, decisions, unresolved questions, and provenance. Return a concise handoff, not implementation tasks.',
        })) as Run;
        const plan = this.store.get<Plan>('plans', run.planId, c.workspaceId);
        plan.tasks[0].prompt =
          'Summarize the selected context into a concise handoff. Preserve constraints, decisions, unresolved questions, and provenance. Return plain prose. Do not implement anything.';
        plan.title = 'Context summary';
        this.store.put('plans', plan.id, plan, c.workspaceId);
        this.store.put('runs', run.id, { ...run, purpose: 'summary' }, c.workspaceId);
        return run;
      }
      case 'draftFromPlanning': {
        const attempt = this.store.get<Attempt>('attempts', c.attemptId, c.workspaceId);
        const run = this.store.get<Run>('runs', attempt.runId, c.workspaceId);
        if (run.mode !== 'plan' || run.purpose === 'summary' || attempt.state !== 'succeeded')
          throw new Error('Select a completed planning attempt');
        const text = (attempt.output ?? '')
          .trim()
          .replace(/^```(?:json)?\s*/, '')
          .replace(/\s*```$/, '');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(
            'The planning response is not structured JSON. Compose its tasks in Workflows.',
          );
        }
        const draft = z
          .object({ title: z.string().min(1).max(200), tasks: z.array(taskSchema).min(1).max(50) })
          .parse(parsed);
        return this.makePlan(c.workspaceId, draft.title, draft.tasks, {
          concurrency: 2,
          maxTokens: 100000,
          timeoutMinutes: 15,
        });
      }
      case 'storage': {
        const sizes = await Promise.all(
          ['', '-wal', '-shm'].map((s) =>
            stat(this.store.path + s)
              .then((s) => s.size)
              .catch(() => 0),
          ),
        );
        let retentionDays = 90;
        try {
          retentionDays = this.store.get<number>('settings', 'retentionDays');
        } catch {}
        return {
          databaseBytes: sizes.reduce((a, b) => a + b, 0),
          events: Number(
            this.store.db.prepare('SELECT count(*) as count FROM events').get()!.count,
          ),
          retentionDays,
          worktrees: this.store.list<Attempt>('attempts').filter((a) => a.worktree).length,
        };
      }
      case 'pruneHistory': {
        const cutoff = Date.now() - c.days * 86400000;
        const candidates = this.store.list<Run>('runs').filter(
          (r) =>
            r.state === 'succeeded' &&
            Date.parse(r.createdAt) < cutoff &&
            !this.store
              .list<ContextItem>('context', r.workspaceId)
              .some((c) => c.provenance?.includes(r.id)) &&
            this.store
              .list<Attempt>('attempts', r.workspaceId)
              .filter((a) => a.runId === r.id)
              .every((a) => a.state === 'succeeded' && (!a.diff || a.integrated)),
        );
        if (
          !(await this.host('confirm', {
            title: 'Prune completed history',
            detail: `Remove messages, tool events, and usage detail for ${candidates.length} successful runs older than ${c.days} days? Only fully integrated/no-change results qualify. Run identities and plans remain to prevent re-execution. Repository and worktree files are preserved. Usage totals will cover retained observations only.`,
          }))
        )
          return;
        this.store.transaction(() => {
          for (const run of candidates) {
            for (const attempt of this.store
              .list<Attempt>('attempts', run.workspaceId)
              .filter((a) => a.runId === run.id)) {
              this.store.db
                .prepare(
                  "DELETE FROM events WHERE workspace_id=? AND json_extract(data,'$.attemptId')=?",
                )
                .run(run.workspaceId, attempt.id);
              this.store.db
                .prepare(
                  "DELETE FROM usage WHERE workspace_id=? AND json_extract(data,'$.attemptId')=?",
                )
                .run(run.workspaceId, attempt.id);
              this.store.put(
                'attempts',
                attempt.id,
                {
                  ...attempt,
                  output: undefined,
                  diff: undefined,
                  context: undefined,
                  state: 'pruned',
                },
                run.workspaceId,
              );
            }
            this.store.put(
              'runs',
              run.id,
              {
                ...run,
                state: 'pruned',
                error: 'Detailed history pruned by user retention action.',
              },
              run.workspaceId,
            );
          }
          this.store.put('settings', 'retentionDays', c.days);
        });
        return { pruned: candidates.length };
      }
      case 'control': {
        const run = this.store.get<Run>('runs', c.runId, c.workspaceId);
        if (!['queued', 'running', 'paused'].includes(run.state))
          throw new Error('Run is no longer active; create a new plan to retry.');
        if (c.action === 'resume')
          await this.verify(this.store.get<Plan>('plans', run.planId, c.workspaceId));
        if (
          c.action === 'resume' &&
          run.state === 'paused' &&
          run.error?.startsWith('Observed token dispatch limit')
        ) {
          const plan = this.store.get<Plan>('plans', run.planId, c.workspaceId);
          const tokens = this.store
            .list<Usage>('usage', c.workspaceId)
            .filter((u) => u.runId === run.id && u.kind === 'delta')
            .reduce((n, u) => n + (u.input ?? 0) + (u.output ?? 0), 0);
          const automatic = this.settings().autoContinueTokens;
          if (
            !automatic &&
            !(await this.host('confirm', {
              title: 'Continue past token threshold?',
              detail: `Run: ${run.id}\nObserved tokens: ${tokens}\nPlanned threshold: ${plan.limits.maxTokens}\nContinuing allows remaining agents to dispatch without this threshold. Copilot usage may increase.`,
            }))
          )
            return;
          run.tokenLimitApproved = true;
          run.tokenLimitApproval = automatic ? 'automatic' : 'manual';
        }
        this.store.put(
          'runs',
          run.id,
          {
            ...run,
            state: c.action === 'cancel' ? 'cancelled' : c.action === 'pause' ? 'paused' : 'queued',
            error: c.action === 'resume' ? undefined : run.error,
          },
          c.workspaceId,
        );
        if (c.action === 'cancel')
          for (const attempt of this.store
            .list<Attempt>('attempts', c.workspaceId)
            .filter((a) => a.runId === run.id)) {
            this.active.get(attempt.id)?.postMessage({ type: 'cancel' });
            if (attempt.state === 'queued')
              this.store.put(
                'attempts',
                attempt.id,
                { ...attempt, state: 'cancelled' },
                c.workspaceId,
              );
          }
        return;
      }
      case 'stopAll':
        for (const run of this.store
          .list<Run>('runs')
          .filter((r) => ['running', 'queued', 'paused'].includes(r.state)))
          await this.dispatch({
            type: 'control',
            workspaceId: run.workspaceId,
            runId: run.id,
            action: 'cancel',
          });
        return;
      case 'deleteHistory': {
        const ws = this.ws(c.workspaceId);
        if (c.kind === 'run') {
          const run = this.store.get<Run>('runs', c.recordId, ws.id);
          if (['queued', 'running', 'paused'].includes(run.state))
            throw new Error('Wait for this run to finish or cancel it before deleting history.');
          const attempts = this.store
            .list<Attempt>('attempts', ws.id)
            .filter((a) => a.runId === run.id);
          const unreviewed = attempts.filter((a) => a.diff && !a.integrated);
          const worktreeRoot = resolve(this.dataDir, 'worktrees');
          const worktrees = attempts.flatMap((attempt) => {
            if (!attempt.worktree) return [];
            if (!/^[\w-]+$/.test(run.id) || !/^[\w-]+$/.test(attempt.taskId))
              throw new Error('Run worktree identity is invalid; refusing to delete files.');
            const expected = resolve(worktreeRoot, run.id, attempt.taskId);
            const same =
              process.platform === 'win32'
                ? resolve(attempt.worktree).toLowerCase() === expected.toLowerCase()
                : resolve(attempt.worktree) === expected;
            if (!contained(worktreeRoot, expected) || !same)
              throw new Error(
                'Run worktree path is outside its owned directory; refusing to delete files.',
              );
            return [expected];
          });
          if (
            !(await this.host('confirm', {
              title: unreviewed.length
                ? 'Discard unreviewed changes and delete run?'
                : 'Delete run history?',
              detail: `Run: ${run.id}\nRepository: ${ws.root}\n${unreviewed.length} unreviewed result(s) will be discarded. ${worktrees.length} app-owned Git worktree(s) will be removed. Attempts, events, and usage will be deleted. Changes already integrated into the repository are kept. A minimal run identity remains to prevent replay.`,
            }))
          )
            return;
          const latest = this.store.get<Run>('runs', run.id, ws.id);
          if (latest.deleted || ['queued', 'running', 'paused'].includes(latest.state))
            throw new Error('Run changed during deletion. Reopen it and try again.');
          await this.locked(ws.commonDir, async () => {
            for (const path of worktrees) {
              const exists = await stat(path).then(
                () => true,
                (error: NodeJS.ErrnoException) => {
                  if (error.code === 'ENOENT') return false;
                  throw error;
                },
              );
              if (exists) {
                const canonicalRoot = await realpath(worktreeRoot);
                const actual = await realpath(path);
                const expected = resolve(canonicalRoot, relative(worktreeRoot, path));
                const same =
                  process.platform === 'win32'
                    ? actual.toLowerCase() === expected.toLowerCase()
                    : actual === expected;
                if (!same) throw new Error('Run worktree redirects outside its owned directory.');
                await git(ws.root, ['worktree', 'remove', '--force', path]);
              }
            }
          });
          this.store.transaction(() => {
            for (const attempt of attempts) {
              this.store.db
                .prepare(
                  "DELETE FROM events WHERE workspace_id=? AND json_extract(data,'$.attemptId')=?",
                )
                .run(ws.id, attempt.id);
              this.store.remove('attempts', attempt.id, ws.id);
            }
            for (const usage of this.store
              .list<Usage>('usage', ws.id)
              .filter((u) => u.runId === run.id))
              this.store.remove('usage', usage.id, ws.id);
            this.store.put('runs', run.id, { ...run, deleted: true, error: undefined }, ws.id);
          });
          return;
        }
        if (c.kind === 'plan') {
          const plan = this.store.get<Plan>('plans', c.recordId, ws.id);
          const hasRun = this.store.list<Run>('runs', ws.id).some((r) => r.planId === plan.id);
          if (
            !(await this.host('confirm', {
              title: 'Delete approval history?',
              detail: `Plan: ${plan.title}\nRepository: ${ws.root}\n${hasRun ? 'This removes it from Approvals. The plan and approval record remain for the completed run audit and replay protection.' : 'The plan and its approval records will be removed.'}`,
            }))
          )
            return;
          if (this.store.list<Run>('runs', ws.id).some((r) => r.planId === plan.id) !== hasRun)
            throw new Error('Run history changed during review. Try deleting this approval again.');
          this.store.transaction(() => {
            if (hasRun) this.store.put('plans', plan.id, { ...plan, deleted: true }, ws.id);
            else {
              for (const approval of this.store
                .list<{ id: string; planId: string }>('approvals', ws.id)
                .filter((a) => a.planId === plan.id))
                this.store.remove('approvals', approval.id, ws.id);
              this.store.remove('plans', plan.id, ws.id);
            }
          });
          return;
        }
        const usage = this.store.get<Usage>('usage', c.recordId, ws.id);
        const run = this.store.get<Run>('runs', usage.runId, ws.id);
        if (['queued', 'running', 'paused'].includes(run.state))
          throw new Error('Wait for the run to finish before deleting usage.');
        if (
          !(await this.host('confirm', {
            title: 'Delete usage observation?',
            detail: `Run: ${run.id}\nTask: ${usage.taskId}\nThis removes the selected usage row and changes displayed totals.`,
          }))
        )
          return;
        this.store.remove('usage', usage.id, ws.id);
        return;
      }
      case 'integrate':
        return this.integrate(c.workspaceId, c.attemptId);
      case 'saveMcp': {
        if (c.server.name.toLowerCase() === 'github')
          throw new Error(
            'The name github is reserved by Copilot. Choose another connection name.',
          );
        if (
          this.store
            .list<Mcp>('mcp', c.workspaceId)
            .some((s) => s.name === c.server.name && s.id !== c.server.id)
        )
          throw new Error('Connection names must be unique within a workspace');
        const old = c.server.id
          ? this.store.get<Mcp>('mcp', c.server.id, c.workspaceId)
          : undefined;
        if (c.server.transport !== 'stdio') {
          const url = new URL(c.server.endpoint);
          if (url.username || url.password || url.search)
            throw new Error(
              'Store credentials separately; endpoint URLs cannot contain credentials or query parameters',
            );
          if (
            url.protocol !== 'https:' &&
            !(
              url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
            )
          )
            throw new Error('Use HTTPS or a loopback HTTP server');
        }
        if (c.server.tools.includes('*'))
          throw new Error('Select individual MCP tools; wildcard grants are unsupported');
        const server: Mcp = {
          ...c.server,
          id: old?.id ?? randomUUID(),
          version: (old?.version ?? 0) + 1,
          secretRef: old?.secretRef,
          state: 'configured',
        };
        if (c.secret) {
          server.secretRef = server.id;
          const encrypted = await this.host('encrypt', c.secret);
          this.store.put('secrets', server.id, { cipher: encrypted }, c.workspaceId);
        }
        this.store.put('mcp', server.id, { ...server, workspaceId: c.workspaceId }, c.workspaceId);
        this.invalidate(c.workspaceId);
        return server;
      }
      case 'searchMcpDirectory':
        return searchMcpDirectory(c.query, c.cursor);
      case 'mcpAction':
        return this.mcpAction(c.workspaceId, c.serverId, c.action);
      case 'addContext': {
        const item = {
          id: randomUUID(),
          text: c.text,
          kind: c.kind,
          createdAt: new Date().toISOString(),
          workspaceId: c.workspaceId,
        };
        this.store.put('context', item.id, item, c.workspaceId);
        return item;
      }
      case 'transferContext': {
        this.ws(c.targetWorkspaceId);
        const item = this.store.get<ContextItem>('context', c.contextId, c.workspaceId);
        const copied = {
          ...item,
          id: randomUUID(),
          workspaceId: c.targetWorkspaceId,
          provenance: `${c.workspaceId}:${item.id}`,
          createdAt: new Date().toISOString(),
        };
        this.store.put('context', copied.id, copied, c.targetWorkspaceId);
        return copied;
      }
      case 'events':
        this.store.get<Attempt>('attempts', c.attemptId, c.workspaceId);
        return this.store.events(c.workspaceId, c.attemptId, c.offset);
      case 'settings': {
        const current = this.settings();
        const autoApprovePlans = c.autoApprovePlans ?? current.autoApprovePlans;
        const autoContinueTokens = c.autoContinueTokens ?? current.autoContinueTokens;
        if (
          (autoApprovePlans && !current.autoApprovePlans) ||
          (autoContinueTokens && !current.autoContinueTokens)
        ) {
          const accepted = await this.host('confirm', {
            title: 'Enable automatic approvals',
            detail: `Automatically approve verified workflow scopes: ${c.autoApprovePlans ? 'yes' : 'no'}\nAutomatically continue past observed token thresholds: ${c.autoContinueTokens ? 'yes' : 'no'}\n\nThis can start approved work and increase Copilot usage. Shell commands, MCP access, and result integration still require separate approval.`,
          });
          if (!accepted) throw new Error('Automatic approvals were not enabled.');
        }
        if (c.globalConcurrency !== current.globalConcurrency)
          for (const ws of this.store.list<Workspace>('workspaces')) this.invalidate(ws.id);
        this.store.put('settings', 'app', {
          globalConcurrency: c.globalConcurrency,
          selectedWorkspace: c.selectedWorkspace,
          theme: c.theme,
          autoApprovePlans,
          autoContinueTokens,
        });
        return;
      }
      case 'backup':
        await this.store.backup(c.path);
        return;
      case 'export': {
        const secretValues: string[] = [];
        for (const record of this.store.list<{ cipher: string }>('secrets'))
          secretValues.push((await this.host('decrypt', record.cipher)) as string);
        return redact(
          {
            schema: 1,
            agents: this.store.list<Agent>('agents'),
            mcp: this.store
              .list<Mcp>('mcp')
              .map((server) => mcpSchema.parse({ ...server, enabled: false })),
            workflows: [
              ...this.templates(),
              ...this.store
                .list<Plan>('plans')
                .filter((p) => !p.id.startsWith('planning:'))
                .map((p) => ({
                  id: p.id,
                  title: p.title,
                  tasks: p.tasks.map(({ agent: _, mcp: __, ...t }) => t),
                  limits: p.limits,
                })),
            ],
            context: this.store.list('context'),
          },
          secretValues,
        );
      }
      case 'import': {
        const data = z
          .object({
            schema: z.literal(1),
            agents: z.array(agentSchema).max(500),
            workflows: z.array(workflowTemplateSchema).max(500).default([]),
            mcp: z.array(mcpSchema).max(500).default([]),
            context: z
              .array(
                z.object({
                  id: z.string(),
                  workspaceId: z.string().optional(),
                  text: z.string().max(30000),
                  kind: z.enum(['decision', 'constraint', 'handoff']),
                }),
              )
              .max(2000)
              .default([]),
          })
          .parse(c.data);
        for (const workflow of data.workflows) validateDag(workflow.tasks);
        if (c.targetWorkspaceId) this.ws(c.targetWorkspaceId);
        const mappings: Record<string, string> = {};
        this.store.transaction(() => {
          if (c.targetWorkspaceId)
            for (const raw of data.mcp) {
              const id = randomUUID();
              if (raw.id) mappings[raw.id] = id;
              this.store.put(
                'mcp',
                id,
                {
                  ...raw,
                  id,
                  name: `${raw.name}-${id.slice(0, 6)}`,
                  version: 1,
                  enabled: false,
                  state: 'configured',
                  workspaceId: c.targetWorkspaceId,
                },
                c.targetWorkspaceId,
              );
            }
          for (const raw of data.agents) {
            const id = randomUUID();
            if (raw.id) mappings[raw.id] = id;
            const agent = {
              ...raw,
              id,
              version: 1,
              archived: true,
              mcpIds: raw.mcpIds.flatMap((id) => (mappings[id] ? [mappings[id]] : [])),
            };
            this.store.put('agents', agent.id, agent);
          }
          const templates = data.workflows.map((t) => {
            const id = randomUUID();
            if (t.id) mappings[t.id] = id;
            return { ...t, id };
          });
          this.store.put('settings', 'templates', [...this.templates(), ...templates]);
          if (c.targetWorkspaceId)
            for (const raw of data.context) {
              const id = randomUUID();
              mappings[raw.id] = id;
              this.store.put(
                'context',
                id,
                {
                  ...raw,
                  id,
                  workspaceId: c.targetWorkspaceId,
                  createdAt: new Date().toISOString(),
                  provenance: `import:${raw.workspaceId ?? 'global'}:${raw.id}`,
                },
                c.targetWorkspaceId,
              );
            }
        });
        return {
          agents: data.agents.length,
          mappings,
          note: 'Imported agents are archived, connections disabled, and workflows require fresh resolution and approval.',
        };
      }
      case 'prepareUpdate':
        if (
          this.active.size ||
          this.store
            .list<Run>('runs')
            .some((r) => ['running', 'queued', 'paused'].includes(r.state)) ||
          this.store
            .list<Workspace>('workspaces')
            .some((w) => ['checking', 'installing', 'building'].includes(w.graph.state))
        )
          throw new Error('Background work is still active; update installation is deferred.');
        this.closing = true;
        clearInterval(this.timer);
        return;
      case 'shutdown':
        this.closing = true;
        this.graphify.stop();
        clearInterval(this.timer);
        await this.dispatch({ type: 'stopAll' });
        await Promise.all(
          [...this.active.values()].map(
            (w) =>
              new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                  void w.terminate();
                  resolve();
                }, 10000);
                w.once('exit', () => {
                  clearTimeout(timer);
                  resolve();
                });
              }),
          ),
        );
        return;
    }
  }
  private invalidate(workspaceId: string) {
    for (const p of this.store.list<Plan>('plans', workspaceId))
      if (p.state === 'approved')
        this.store.put('plans', p.id, { ...p, state: 'stale' }, workspaceId);
  }
  private async makePlan(
    workspaceId: string,
    title: string,
    tasks: Task[],
    limits: Plan['limits'],
  ) {
    validateDag(tasks);
    const ws = this.ws(workspaceId);
    const resolved = [];
    for (const task of tasks) {
      const agent = await resolveAgent(
        ws,
        task.role,
        this.store.list('agents'),
        this.runtime.models.map((m) => m.id),
        task.source,
      );
      const mcp = agent.mcpIds.map((id) => this.store.get<Mcp>('mcp', id, workspaceId));
      if (mcp.some((s) => !s.enabled)) throw new Error('Agent binds a disabled MCP connection');
      resolved.push({ ...task, agent, mcp });
    }
    const payload = {
      workspaceId,
      root: ws.root,
      commonDir: ws.commonDir,
      base: await baseline(ws.root),
      tasks: resolved,
      limits: limitsSchema.parse(limits),
      context: this.store.list<ContextItem>('context', workspaceId),
      workspaceConcurrency: ws.concurrency,
      globalConcurrency: this.settings().globalConcurrency,
      ...(this.headroomConfig().enabled ? { headroom: this.headroomConfig() } : {}),
    };
    const plan: Plan = {
      id: randomUUID(),
      workspaceId,
      title,
      revision: this.store.list<Plan>('plans', workspaceId).length + 1,
      base: payload.base,
      tasks: resolved,
      limits,
      context: payload.context,
      headroom: payload.headroom,
      hash: hash(payload),
      state: 'draft',
      createdAt: new Date().toISOString(),
    };
    this.store.put('plans', plan.id, { ...plan, scope: payload }, workspaceId);
    if (this.settings().autoApprovePlans) {
      try {
        await this.verify(plan);
        const current = this.store.get<Plan>('plans', plan.id, workspaceId);
        if (
          this.settings().autoApprovePlans &&
          current.state === 'draft' &&
          current.hash === plan.hash
        ) {
          const approval = {
            id: randomUUID(),
            workspaceId,
            planId: plan.id,
            hash: plan.hash,
            decision: 'approve',
            createdAt: new Date().toISOString(),
            automatic: true,
          };
          this.store.transaction(() => {
            this.store.put('approvals', approval.id, approval, workspaceId);
            this.store.put('plans', plan.id, { ...current, state: 'approved' }, workspaceId);
          });
          return { ...plan, state: 'approved' as const };
        }
      } catch {
        // Keep the draft reviewable when its repository or scope cannot be verified.
      }
    }
    return plan;
  }
  async verify(plan: Plan) {
    if (plan.id.startsWith('planning:')) return;
    try {
      const stored = this.store.get<Plan & { scope: Record<string, unknown> }>(
          'plans',
          plan.id,
          plan.workspaceId,
        ),
        ws = this.ws(plan.workspaceId);
      const tasks = [];
      for (const task of plan.tasks) {
        const agent = await resolveAgent(
          ws,
          task.role,
          this.store.list('agents'),
          this.runtime.models.map((m) => m.id),
          task.source,
        );
        const mcp = agent.mcpIds.map((id) => this.store.get<Mcp>('mcp', id, ws.id));
        tasks.push({ ...task, agent, mcp });
      }
      const scope = {
        workspaceId: ws.id,
        root: ws.root,
        commonDir: ws.commonDir,
        base: await baseline(ws.root),
        tasks,
        limits: plan.limits,
        context: plan.context,
        workspaceConcurrency: ws.concurrency,
        globalConcurrency: this.settings().globalConcurrency,
        ...(plan.headroom || this.headroomConfig().enabled
          ? { headroom: this.headroomConfig() }
          : {}),
      };
      if (hash(scope) !== stored.hash)
        throw new Error(
          'Repository baseline, agent, instructions, connection, Headroom configuration, or limits changed. Create and approve a fresh plan.',
        );
    } catch (e) {
      this.store.put(
        'plans',
        plan.id,
        { ...this.store.get<Plan>('plans', plan.id, plan.workspaceId), state: 'stale' },
        plan.workspaceId,
      );
      throw e;
    }
    // Drafts may be saved with local edits, but worktrees execute the committed base.
    // Keep a blocked draft reviewable so stashing edits does not discard its scope.
    const root = this.ws(plan.workspaceId).root;
    const changes = await git(root, [
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--',
      '.',
      ':(exclude)graphify-out',
    ]);
    if (changes) {
      const files = changes.split(/\r?\n/).filter(Boolean);
      const sample = files.slice(0, 5).map((line) => line.trim());
      throw new Error(
        `Draft saved. Approval needs a clean repository at ${root}. Uncommitted files: ${sample.join(', ')}${files.length > sample.length ? `, and ${files.length - sample.length} more` : ''}. Commit or stash these changes before approving or executing. If you commit, create a fresh draft to capture the new base. Graphify output is excluded.`,
      );
    }
  }
  private newAttempt(run: Run, task: Plan['tasks'][number]): Attempt {
    return {
      id: `${run.id}:${task.id}`,
      workspaceId: run.workspaceId,
      runId: run.id,
      taskId: task.id,
      agentId: task.agent.id,
      requestedModel: task.agent.model,
      state: 'queued',
      coverage: 'unknown',
      startedAt: new Date().toISOString(),
    };
  }
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  async tick() {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      const workspaces = this.store.list<Workspace>('workspaces');
      if (!workspaces.length) return;
      const slots =
        this.settings().globalConcurrency -
        this.store.list<Attempt>('attempts').filter((a) => a.state === 'running').length;
      for (let i = 0, launched = 0; i < workspaces.length && launched < slots; i++) {
        const ws = workspaces[(this.cursor + i) % workspaces.length];
        if (
          this.store.list<Attempt>('attempts', ws.id).filter((a) => a.state === 'running').length >=
          ws.concurrency
        )
          continue;
        for (const run of this.store
          .list<Run>('runs', ws.id)
          .filter((r) => ['queued', 'running'].includes(r.state))) {
          const plan = this.store.get<Plan>('plans', run.planId, ws.id),
            attempts = this.store
              .list<Attempt>('attempts', ws.id)
              .filter((a) => a.runId === run.id);
          const terminal = ['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'];
          for (const a of attempts.filter((a) => a.state === 'queued')) {
            const task = plan.tasks.find((t) => t.id === a.taskId)!;
            if (
              task.dependsOn.some((id) =>
                attempts.some(
                  (p) => p.taskId === id && terminal.includes(p.state) && p.state !== 'succeeded',
                ),
              )
            ) {
              a.state = 'blocked';
              this.store.put('attempts', a.id, a, ws.id);
            }
          }
          if (attempts.every((a) => terminal.includes(a.state))) {
            this.store.put(
              'runs',
              run.id,
              {
                ...run,
                state: attempts.every((a) => a.state === 'succeeded') ? 'succeeded' : 'failed',
              },
              ws.id,
            );
            this.changed();
            continue;
          }
          if (attempts.filter((a) => a.state === 'running').length >= plan.limits.concurrency)
            continue;
          const tokens = this.store
            .list<Usage>('usage', ws.id)
            .filter((u) => u.runId === run.id && u.kind === 'delta')
            .reduce((n, u) => n + (u.input ?? 0) + (u.output ?? 0), 0);
          if (
            tokens >= plan.limits.maxTokens &&
            !run.tokenLimitApproved &&
            this.settings().autoContinueTokens
          ) {
            run.tokenLimitApproved = true;
            run.tokenLimitApproval = 'automatic';
            this.store.put('runs', run.id, run, ws.id);
          }
          if (tokens >= plan.limits.maxTokens && !run.tokenLimitApproved) {
            this.store.put(
              'runs',
              run.id,
              {
                ...run,
                state: 'paused',
                error: 'Observed token dispatch limit reached; in-flight calls may overshoot.',
              },
              ws.id,
            );
            continue;
          }
          const attempt = attempts.find(
            (a) =>
              a.state === 'queued' &&
              plan.tasks
                .find((t) => t.id === a.taskId)!
                .dependsOn.every((id) =>
                  attempts.some((p) => p.taskId === id && p.state === 'succeeded'),
                ),
          );
          if (!attempt) continue;
          this.store.put('attempts', attempt.id, { ...attempt, state: 'running' }, ws.id);
          this.store.put('runs', run.id, { ...run, state: 'running' }, ws.id);
          launched++;
          void this.executeAttempt(ws, run, plan, { ...attempt, state: 'running' });
          break;
        }
      }
      this.cursor = (this.cursor + 1) % workspaces.length;
    } finally {
      this.ticking = false;
    }
  }
  private async executeAttempt(ws: Workspace, run: Run, plan: Plan, attempt: Attempt) {
    try {
      if (run.mode === 'execute') {
        if (this.store.get<Plan>('plans', plan.id, ws.id).state !== 'approved')
          throw new Error('Plan approval is no longer valid');
        await this.verify(plan);
      }
      const task = plan.tasks.find((t) => t.id === attempt.taskId)!;
      const predecessors = prerequisiteOrder(plan.tasks, task.id).map((id) =>
        this.store.get<Attempt>('attempts', `${run.id}:${id}`, ws.id),
      );
      if (run.mode === 'execute') {
        attempt.worktree = join(this.dataDir, 'worktrees', run.id, task.id);
        await this.locked(ws.commonDir, async () => {
          await worktree(ws.root, attempt.worktree!, plan.base);
          for (const p of predecessors)
            if (p.commit && p.diff)
              await git(attempt.worktree!, [
                '-c',
                'user.name=Agentic Tooling',
                '-c',
                'user.email=agentic@localhost',
                '-c',
                'commit.gpgsign=false',
                'cherry-pick',
                p.commit,
              ]);
        });
      }
      if (this.store.get<Run>('runs', run.id, ws.id).state === 'cancelled')
        throw new Error('Cancelled');
      attempt.context = JSON.stringify({
        items: plan.context,
        predecessors: predecessors.map((p) => ({
          task: p.taskId,
          title: plan.tasks.find((item) => item.id === p.taskId)?.title,
          result: p.output,
          commit: p.commit,
        })),
      });
      this.store.put('attempts', attempt.id, attempt, ws.id);
      this.changed();
      const mcp = await this.mcpConfigs(ws, task.mcp);
      if (this.store.get<Run>('runs', run.id, ws.id).state === 'cancelled')
        throw new Error('Cancelled before session dispatch');
      if (
        run.mode === 'execute' &&
        this.store.get<Plan>('plans', plan.id, ws.id).state !== 'approved'
      )
        throw new Error('Approval was revoked before session dispatch');
      const result = (await this.worker(
        {
          kind: 'attempt',
          root: attempt.worktree ?? ws.root,
          graphRoot: ws.root,
          dataDir: join(this.dataDir, 'runtime', 'identity'),
          agent: task.agent,
          prompt: `${task.prompt}\n\nSelected context:\n${attempt.context}`,
          planning: run.mode === 'plan',
          summarizing: run.purpose === 'summary',
          headroom: plan.headroom,
          timeoutMinutes: plan.limits.timeoutMinutes,
          mcp: mcp.config,
          mcpOAuthServers: mcp.oauthServers,
          secrets: mcp.secrets,
        },
        attempt,
      )) as { output: string; sessionId: string };
      attempt = this.store.get<Attempt>('attempts', attempt.id, ws.id);
      if (this.store.get<Run>('runs', run.id, ws.id).state === 'cancelled')
        throw new Error('Cancelled');
      if (attempt.worktree)
        Object.assign(
          attempt,
          await this.locked(ws.commonDir, () => snapshotChanges(attempt.worktree!)),
        );
      attempt.state = 'succeeded';
      attempt.output = result.output;
      attempt.sessionId = result.sessionId;
      const currentRun = this.store.get<Run>('runs', run.id, ws.id);
      if (currentRun.purpose === 'summary') {
        const context: ContextItem = {
          id: randomUUID(),
          text: result.output,
          kind: 'handoff',
          createdAt: new Date().toISOString(),
          provenance: `summary:${run.id}:${attempt.id}`,
        };
        this.store.put('context', context.id, { ...context, workspaceId: ws.id }, ws.id);
      }
    } catch (error) {
      attempt = this.store.get<Attempt>('attempts', attempt.id, ws.id);
      attempt.state =
        this.store.get<Run>('runs', run.id, ws.id).state === 'cancelled' ? 'cancelled' : 'failed';
      attempt.error = (error as Error).message;
      attempt.coverage = 'partial';
      if (attempt.worktree)
        attempt.diff = await git(attempt.worktree, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          'HEAD',
        ]).catch(() => '');
    }
    attempt.endedAt = new Date().toISOString();
    this.store.put('attempts', attempt.id, attempt, ws.id);
    this.changed();
  }
  private worker(job: Job, attempt?: Attempt): Promise<unknown> {
    if (this.testRunner) return this.testRunner(job, attempt);
    return new Promise((resolve, reject) => {
      const key = attempt?.id ?? randomUUID();
      const worker = new Worker(new URL('./copilot-worker.js', import.meta.url), {
        workerData: job,
      });
      this.active.set(key, worker);
      let result: unknown, error: Error | undefined;
      const timeout = setTimeout(
        () => {
          worker.postMessage({ type: 'cancel' });
          setTimeout(() => {
            void worker.terminate();
          }, 5000).unref();
        },
        (job.timeoutMinutes ?? 5) * 60000,
      );
      worker.on('message', async (m) => {
        try {
          if (m.type === 'permission') {
            const allowed = await this.host('confirm', { title: m.title, detail: m.detail });
            if (attempt) {
              const approval = {
                id: randomUUID(),
                attemptId: attempt.id,
                decision: allowed ? 'approve' : 'reject',
                scope: redact(m.detail, job.secrets),
                at: new Date().toISOString(),
              };
              this.store.put('approvals', approval.id, approval, attempt.workspaceId);
            }
            worker.postMessage({ type: 'decision', id: m.id, allowed: !!allowed });
          }
          if (m.type === 'login' && m.data.authorizationUrl)
            await this.host('openOAuth', m.data.authorizationUrl);
          if (m.type === 'event' && attempt) {
            const current = this.store.get<Attempt>('attempts', attempt.id, attempt.workspaceId);
            captureUsage(this.store, current, m.data);
            if (
              m.data.type === 'assistant.message_delta' &&
              typeof m.data.data.deltaContent === 'string'
            ) {
              current.output = ((current.output ?? '') + m.data.data.deltaContent).slice(-200000);
              this.store.put('attempts', current.id, current, current.workspaceId);
            }
            if (!m.data.type.includes('delta'))
              this.store.put(
                'events',
                `${attempt.id}:${m.data.id}`,
                { ...m.data, attemptId: attempt.id },
                attempt.workspaceId,
              );
            this.changed();
          }
          if (m.type === 'session' && attempt) {
            const current = this.store.get<Attempt>('attempts', attempt.id, attempt.workspaceId);
            this.store.put(
              'attempts',
              attempt.id,
              { ...current, sessionId: m.data.id },
              attempt.workspaceId,
            );
          }
          if (m.type === 'result') result = m.data;
          if (m.type === 'error') error = new Error(m.data.message);
        } catch (e) {
          error = e as Error;
          worker.postMessage({ type: 'cancel' });
        }
      });
      worker.on('error', (e) => {
        error = e;
      });
      worker.on('exit', (code) => {
        clearTimeout(timeout);
        this.active.delete(key);
        if (error) reject(error);
        else if (code !== 0 || result === undefined)
          reject(new Error('Runtime interrupted; outcome may be unknown.'));
        else resolve(result);
      });
    });
  }
  private async mcpConfigs(ws: Workspace, servers: Mcp[]) {
    const config: Record<string, MCPServerConfig> = {},
      secrets: string[] = [],
      oauthServers = servers
        .filter((server) => server.auth === 'oauth')
        .map((server) => server.name);
    for (const server of servers) {
      let secret: string | undefined;
      if (server.secretRef) {
        const record = this.store.get<{ cipher: string }>('secrets', server.secretRef, ws.id);
        secret = (await this.host('decrypt', record.cipher)) as string;
        secrets.push(secret);
      }
      const value = server.auth === 'bearer' ? `Bearer ${secret}` : secret;
      config[server.name] =
        server.transport === 'stdio'
          ? {
              type: 'stdio',
              command: server.endpoint,
              args: server.args,
              workingDirectory: ws.root,
              env: value ? { [server.secretName]: value } : {},
              tools: server.tools,
            }
          : {
              type: server.transport,
              url: server.endpoint,
              headers: value ? { [server.secretName]: value } : {},
              tools: server.tools,
            };
    }
    return { config, secrets, oauthServers };
  }
  private async mcpAction(workspaceId: string, id: string, action: string) {
    const ws = this.ws(workspaceId),
      server = this.store.get<Mcp>('mcp', id, workspaceId);
    if (action === 'enable') {
      if (server.enabled) return server;
      if (['bearer', 'api-key'].includes(server.auth) && !server.secretRef)
        throw new Error('Add the connection secret before enabling it.');
      server.enabled = true;
      server.state = 'configured';
      server.version++;
      this.store.put('mcp', id, { ...server, workspaceId }, workspaceId);
      this.invalidate(workspaceId);
      return server;
    }
    if (action === 'delete') {
      if (
        this.store
          .list<Run>('runs', workspaceId)
          .some((r) => ['queued', 'running', 'paused'].includes(r.state))
      )
        throw new Error('Wait for workspace runs to finish before removing a connection.');
      const bound = this.store.list<Agent>('agents').filter((agent) => agent.mcpIds.includes(id));
      if (
        !(await this.host('confirm', {
          title: 'Remove MCP connection?',
          detail: `Connection: ${server.name}\nRepository: ${ws.root}\nThis removes the saved connection and its app secret, and unbinds it from ${bound.length} custom agent(s). Existing workflow approvals become stale.`,
        }))
      )
        return;
      if (
        this.store
          .list<Run>('runs', workspaceId)
          .some((r) => ['queued', 'running', 'paused'].includes(r.state))
      )
        throw new Error(
          'A workspace run started during review. Remove the connection after it ends.',
        );
      this.store.transaction(() => {
        for (const agent of bound)
          this.store.put('agents', agent.id, {
            ...agent,
            mcpIds: agent.mcpIds.filter((value) => value !== id),
            version: agent.version + 1,
          });
        if (server.secretRef) this.store.remove('secrets', server.secretRef, workspaceId);
        this.store.remove('mcp', id, workspaceId);
      });
      for (const workspace of this.store.list<Workspace>('workspaces'))
        this.invalidate(workspace.id);
      return;
    }
    if (action === 'disconnect' || action === 'clear') {
      server.enabled = false;
      server.state = 'stopped';
      server.version++;
      if (action === 'clear') {
        this.store.remove('secrets', server.secretRef ?? id, workspaceId);
        server.secretRef = undefined;
      }
      this.store.put('mcp', id, { ...server, workspaceId }, workspaceId);
      this.invalidate(workspaceId);
      return;
    }
    if (
      !(await this.host('confirm', {
        title: action === 'authenticate' ? 'Authenticate MCP connection' : 'Test MCP connection',
        detail: `${server.name}\n${server.endpoint}\nArguments: ${JSON.stringify(server.args)}\nDirectory: ${ws.root}\nSecret destination: ${server.secretName}\nThis explicitly starts the connection.`,
      }))
    )
      throw new Error('Connection action cancelled');
    server.state = 'starting';
    this.store.put('mcp', id, { ...server, workspaceId }, workspaceId);
    this.changed();
    try {
      const configs = await this.mcpConfigs(ws, [server]);
      const job: Job = {
        kind: 'mcp',
        root: ws.root,
        dataDir: join(this.dataDir, 'runtime', 'identity'),
        mcp: configs.config,
        mcpOAuthServers: configs.oauthServers,
        secrets: configs.secrets,
        mcpAction: action,
        serverName: server.name,
      };
      let result = await this.worker(job);
      if (action === 'authenticate' && server.auth === 'oauth')
        try {
          result = await this.worker({ ...job, mcpAction: 'test' });
        } catch (error) {
          throw new Error(
            `OAuth worked in the sign-in session, but a new session could not use its saved grant. ${(error as Error).message}`,
          );
        }
      server.state = 'stopped';
      const observed = result as { tools?: { tools?: unknown[] } };
      server.lastProbe = {
        status: 'connected',
        checkedAt: new Date().toISOString(),
        toolCount: Array.isArray(observed.tools?.tools) ? observed.tools.tools.length : undefined,
      };
      server.diagnostic =
        JSON.stringify(result, null, 2) +
        '\nProbe session closed. Connections start again for approved attempts.';
    } catch (e) {
      server.state = 'failed';
      server.lastProbe = { status: 'failed', checkedAt: new Date().toISOString() };
      server.diagnostic = (e as Error).message;
      if (
        server.auth === 'oauth' &&
        server.endpoint.replace(/\/$/, '') === 'https://mcp.figma.com/mcp'
      )
        server.diagnostic +=
          "\nFigma limits its remote MCP server to supported clients. If browser consent succeeds but this app cannot reuse the grant, use a client in Figma's MCP catalog or configure the Figma desktop server at http://127.0.0.1:3845/mcp with HTTP and no OAuth. The desktop server requires Figma desktop and an eligible seat.";
    }
    this.store.put('mcp', id, { ...server, workspaceId }, workspaceId);
    return server;
  }
  private async integrate(workspaceId: string, attemptId: string) {
    const ws = this.ws(workspaceId),
      attempt = this.store.get<Attempt>('attempts', attemptId, workspaceId);
    if (attempt.state !== 'succeeded' || !attempt.commit || attempt.integrated)
      throw new Error('No unintegrated successful result');
    const run = this.store.get<Run>('runs', attempt.runId, workspaceId);
    const plan = this.store.get<Plan>('plans', run.planId, workspaceId);
    const outstanding = prerequisiteOrder(plan.tasks, attempt.taskId)
      .map((id) => this.store.get<Attempt>('attempts', `${run.id}:${id}`, workspaceId))
      .filter((a) => a.diff && !a.integrated);
    if (outstanding.length)
      throw new Error(
        `Integrate prerequisites first: ${outstanding.map((a) => a.taskId).join(', ')}`,
      );
    if (
      !(await this.host('confirm', {
        title: 'Integrate reviewed result',
        detail: `Repository: ${ws.root}\nCommit: ${attempt.commit}\n\n${attempt.diff?.slice(0, 16000) || 'No changes'}\n\nCherry-pick this result into the current branch? No push is performed.`,
      }))
    )
      throw new Error('Integration cancelled');
    return this.locked(ws.commonDir, async () => {
      if (
        await git(ws.root, [
          'status',
          '--porcelain',
          '--untracked-files=normal',
          '--',
          '.',
          ':(exclude)graphify-out',
        ])
      )
        throw new Error('Commit or stash local changes before integration.');
      if (this.store.list<Attempt>('attempts', workspaceId).some((a) => a.state === 'running'))
        throw new Error('Wait for workspace attempts to finish before integration.');
      try {
        if (attempt.diff)
          await git(ws.root, [
            '-c',
            'user.name=Agentic Tooling',
            '-c',
            'user.email=agentic@localhost',
            '-c',
            'commit.gpgsign=false',
            'cherry-pick',
            attempt.commit!,
          ]);
      } catch (e) {
        throw new Error(
          `Integration stopped. Review and resolve the Git cherry-pick state in ${ws.root}. ${(e as Error).message}`,
        );
      }
      this.store.put('attempts', attempt.id, { ...attempt, integrated: true }, workspaceId);
      this.invalidate(workspaceId);
      return;
    });
  }
}
