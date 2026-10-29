import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  Agent,
  Attempt,
  Command,
  ContextItem,
  Mcp,
  Plan,
  Snapshot,
  Task,
  Workspace,
} from './shared';
import { toolNames } from './shared';

const pages = [
  'Overview',
  'Agents',
  'Workflows',
  'Approvals',
  'Runs',
  'Usage',
  'Context',
  'Connections',
  'Settings',
] as const;
type Page = (typeof pages)[number];
const icons = ['◫', '♧', '⑂', '◇', '▷', '▥', '▤', '⌘', '⚙'];
const count = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat().format(n);
const time = (v: string) => new Date(v).toLocaleString();
function Badge({ children }: { children: ReactNode }) {
  const s = String(children);
  return (
    <span
      className={`badge ${['approved', 'ready', 'connected', 'succeeded', 'Repository'].includes(s) ? 'good' : ['failed', 'stale', 'cancelled'].includes(s) ? 'bad' : ['queued', 'draft', 'paused', 'interrupted', 'partial', 'needs-auth'].includes(s) ? 'warn' : ''}`}
    >
      {children}
    </span>
  );
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  danger = false,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      className={`btn ${primary ? 'primary' : ''} ${danger ? 'danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function App() {
  const [data, setData] = useState<Snapshot>(),
    [page, setPage] = useState<Page>('Overview'),
    [selected, setSelected] = useState('all'),
    [toast, setToast] = useState(''),
    [busy, setBusy] = useState(false),
    [detail, setDetail] = useState<Attempt>();
  const refresh = useCallback(async () => {
    if (!window.desktop) return;
    try {
      const state = await window.desktop.request<Snapshot>({ type: 'snapshot' });
      setData(state);
      document.documentElement.dataset.theme = state.settings.theme;
    } catch (e) {
      setToast(String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    if (!window.desktop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.desktop.onChange(() => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void refresh();
        }, 120);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetail(undefined);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  useEffect(() => {
    if (
      data &&
      selected === 'all' &&
      data.settings.selectedWorkspace !== 'all' &&
      !data.workspaces.some((w) => w.id === selected)
    )
      setSelected(data.settings.selectedWorkspace);
  }, [!!data]);
  const action = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    try {
      const result = await fn();
      if (message) setToast(message);
      await refresh();
      return result;
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = (command: Command, message?: string) =>
    action(() => window.desktop.request(command), message);
  const add = () =>
    action(async () => {
      const id = await window.desktop.chooseRepository();
      if (id) {
        setSelected(id);
        setPage('Overview');
      }
    }, 'Workspace added. Graphify checks run in the background.');
  if (!window.desktop)
    return (
      <div className="panel m-12">
        <h1>Open the desktop app</h1>
        <p>
          This interface needs the Electron desktop bridge. Run <code>pnpm dev</code> from the
          project folder.
        </p>
      </div>
    );
  if (!data) return <div className="p-12 muted">Starting your workspace…</div>;
  const ws = data.workspaces.find((w) => w.id === selected);
  const scope = <T extends { workspaceId: string }>(rows: T[]) =>
    selected === 'all' ? rows : rows.filter((r) => r.workspaceId === selected);
  const attempts = scope(data.attempts),
    runs = scope(data.runs),
    plans = scope(data.plans).filter((p) => !p.id.startsWith('planning:')),
    usage = scope(data.usage).filter((u) => u.kind === 'delta');
  const running = attempts.filter((a) => a.state === 'running').length,
    queued = attempts.filter((a) => a.state === 'queued').length;
  const tokens = usage.some((u) => u.input !== null || u.output !== null)
    ? usage.reduce((n, u) => n + (u.input ?? 0) + (u.output ?? 0), 0)
    : null;
  const select = (id: string) => {
    setSelected(id);
    void send({ type: 'settings', ...data.settings, selectedWorkspace: id });
    if (id !== 'all')
      void window.desktop
        .request({ type: 'graphify', workspaceId: id, rebuild: false })
        .then(refresh);
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="flex items-center gap-3 px-2 mb-2">
          <div className="brand-mark">↗</div>
          <div>
            <div className="text-sm font-semibold tracking-tight">
              agentic<span className="muted font-normal"> tooling</span>
            </div>
            <div className="text-[10px] muted mt-1 tracking-widest">YOUR LOCAL CONTROL ROOM</div>
          </div>
        </div>
        <div className="section-label">Workspace</div>
        <button
          className={`workspace ${selected === 'all' ? 'selected' : ''}`}
          onClick={() => select('all')}
        >
          <span className="icon">▦</span>
          <span className="flex-1">All workspaces</span>
          <span className="muted text-xs">{data.workspaces.length}</span>
        </button>
        <div className="max-h-48 overflow-auto">
          {data.workspaces.map((w) => (
            <button
              className={`workspace ${selected === w.id ? 'selected' : ''}`}
              key={w.id}
              onClick={() => select(w.id)}
            >
              <span
                className={`dot ${data.attempts.some((a) => a.workspaceId === w.id && a.state === 'running') ? 'live' : ''}`}
              />
              <span className="truncate flex-1">{w.name}</span>
              {data.plans.some(
                (p) =>
                  p.workspaceId === w.id && p.state === 'draft' && !p.id.startsWith('planning:'),
              ) && <span className="accent">·</span>}
            </button>
          ))}
        </div>
        <button className="workspace muted" onClick={() => void add()}>
          ＋ <span>Add repository</span>
        </button>
        <div className="section-label">Control center</div>
        <nav className="space-y-1">
          {pages.map((p, i) => (
            <button
              key={p}
              aria-label={p}
              className={`nav ${page === p ? 'active' : ''}`}
              onClick={() => setPage(p)}
            >
              <span className="icon">{icons[i]}</span>
              {p}
              {p === 'Approvals' && plans.some((p) => p.state === 'draft') && (
                <span className="ml-auto text-xs">
                  {plans.filter((p) => p.state === 'draft').length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-auto pt-6">
          <div className="notice small">
            <span className={`dot ${data.runtime.state === 'connected' ? 'live' : ''}`} />{' '}
            <span className="ml-2">GitHub Copilot</span>
            <div className="muted mt-1">{data.runtime.login ?? 'Connect in settings'}</div>
          </div>
          <div className="mt-4 px-2 text-[10px] muted">Local data. Explicit approvals.</div>
        </div>
      </aside>
      <main className="content">
        <header className="topbar">
          <div className="text-xs muted">
            <span className="accent">●</span>{' '}
            <span className="ml-2">{ws?.name ?? 'All workspaces'}</span>
            <span className="mx-3 opacity-40">/</span>
            {page}
          </div>
          <div className="toolbar">
            <span className="text-xs muted mr-3">
              {running} active · {queued} queued
            </span>
            {busy && (
              <span className="text-xs accent" role="status">
                Working…
              </span>
            )}
            <Button
              onClick={() =>
                void send({ type: 'stopAll' }, 'Cancellation requested for all workspaces.')
              }
              disabled={!data.runs.some((r) => ['queued', 'running', 'paused'].includes(r.state))}
            >
              Stop all
            </Button>
          </div>
        </header>
        <div className="page-head">
          <div>
            <div className="eyebrow mb-2">
              {ws ? 'Repository workspace' : 'Workspace command center'}
            </div>
            <h1>{page === 'Overview' ? 'A clear view of the work.' : page}</h1>
            <p className="muted text-sm m-0">
              {page === 'Overview'
                ? 'Plan deliberately. Run independently. Review every result.'
                : (ws?.root ?? 'Across all of your local repositories.')}
            </p>
          </div>
          {page === 'Overview' && (
            <Button primary onClick={() => void add()}>
              ＋ Add repository
            </Button>
          )}
        </div>
        {page === 'Overview' && (
          <>
            <div className="metrics">
              {[
                ['Active agents', running, 'Across independent sessions'],
                [
                  'Waiting for approval',
                  plans.filter((p) => p.state === 'draft').length,
                  'Execution stays blocked',
                ],
                ['Observed tokens', count(tokens), 'Reported input + output only'],
                [
                  'Repository workspaces',
                  ws ? 1 : data.workspaces.length,
                  'Separate context and history',
                ],
              ].map(([label, value, sub]) => (
                <div className="panel metric" key={label}>
                  <div className="eyebrow">{label}</div>
                  <strong>{value}</strong>
                  <div className="text-xs muted">{sub}</div>
                </div>
              ))}
            </div>
            <div className="grid-main">
              <div className="stack">
                <section className="panel">
                  <div className="flex justify-between items-center">
                    <h2>Execution activity</h2>
                    <Badge>{running ? 'running' : 'idle'}</Badge>
                  </div>
                  {attempts.length ? (
                    attempts
                      .slice(-8)
                      .reverse()
                      .map((a) => (
                        <button
                          className="row w-full text-left"
                          key={a.id}
                          onClick={() => setDetail(a)}
                        >
                          <div>
                            <div className="text-sm">{a.taskId}</div>
                            <div className="text-xs muted mt-1">
                              {data.workspaces.find((w) => w.id === a.workspaceId)?.name} ·{' '}
                              {a.requestedModel}
                            </div>
                          </div>
                          <Badge>{a.state}</Badge>
                        </button>
                      ))
                  ) : (
                    <Empty title="Room for your next idea">
                      Add a repository, connect Copilot, and create your first plan.
                    </Empty>
                  )}
                </section>
                <section className="panel">
                  <h2>Your repositories</h2>
                  {(ws ? [ws] : data.workspaces).map((w) => (
                    <div className="row" key={w.id}>
                      <div className="min-w-0">
                        <h3>{w.name}</h3>
                        <div className="text-xs muted truncate mt-1">{w.root}</div>
                        <div className="text-xs muted mt-2">
                          ⑂ {w.branch} · Graphify <Badge>{w.graph.state}</Badge>
                          {w.graph.nodes !== undefined && ` · ${count(w.graph.nodes)} nodes`}
                        </div>
                        {w.graph.detail && (
                          <p className="text-xs muted max-w-xl">{w.graph.detail}</p>
                        )}
                      </div>
                      <div className="toolbar">
                        <Button onClick={() => select(w.id)}>Open</Button>
                        <Button
                          onClick={() =>
                            void send({ type: 'graphify', workspaceId: w.id, rebuild: true })
                          }
                        >
                          Rebuild graph
                        </Button>
                      </div>
                    </div>
                  ))}
                  {!data.workspaces.length && (
                    <Empty title="No repositories yet">
                      Select a Git repository. Graphify will check and index it automatically.
                    </Empty>
                  )}
                </section>
              </div>
              <div className="stack">
                <section className="panel">
                  <h2>Start with a plan</h2>
                  <p className="text-sm muted">
                    A planning session can read your project and graph. It cannot edit files or run
                    commands.
                  </p>
                  {ws ? (
                    <Planning
                      workspace={ws}
                      send={send}
                      disabled={busy || data.runtime.state !== 'connected'}
                    />
                  ) : (
                    <p className="notice">Select a repository in the sidebar to start planning.</p>
                  )}
                </section>
                <section className="panel">
                  <h2>Approval boundaries</h2>
                  <div className="stack text-sm muted">
                    <div>
                      01 <span className="ml-2">Review agents, models, and dependencies.</span>
                    </div>
                    <div>
                      02 <span className="ml-2">Approve the exact execution scope.</span>
                    </div>
                    <div>
                      03 <span className="ml-2">Inspect results before integration.</span>
                    </div>
                  </div>
                </section>
                <section className="panel">
                  <h2>Desktop updates</h2>
                  <Badge>{data.update?.state ?? 'unchecked'}</Badge>
                  <p className="text-xs muted">
                    New releases download automatically. Installation waits for idle workspaces.
                  </p>
                </section>
              </div>
            </div>
          </>
        )}
        {page === 'Agents' && <Agents data={data} workspace={ws} send={send} />}
        {page === 'Workflows' &&
          (ws ? (
            <Workflows workspace={ws} data={data} send={send} />
          ) : (
            <div className="panel">
              <Empty title="Choose a repository">
                Workflows and approvals belong to one workspace. Select it in the sidebar.
              </Empty>
            </div>
          ))}
        {page === 'Approvals' && (
          <div className="stack">
            {plans
              .slice()
              .reverse()
              .map((p) => (
                <PlanCard key={p.id} plan={p} send={send} />
              ))}
            {!plans.length && (
              <div className="panel">
                <Empty title="Nothing awaiting review">
                  Create a workflow to preview its resolved agents and permissions.
                </Empty>
              </div>
            )}
          </div>
        )}
        {page === 'Runs' && (
          <div className="stack">
            {runs
              .slice()
              .reverse()
              .map((run) => (
                <section className="panel" key={run.id}>
                  <div className="flex justify-between items-center gap-3">
                    <div>
                      <h2>{data.plans.find((p) => p.id === run.planId)?.title ?? run.mode}</h2>
                      <div className="text-xs muted">
                        {time(run.createdAt)} ·{' '}
                        {data.workspaces.find((w) => w.id === run.workspaceId)?.name} ·{' '}
                        {run.mode === 'plan' ? 'Read-only planning' : 'Approved execution'}
                      </div>
                    </div>
                    <div className="toolbar">
                      <Badge>{run.state}</Badge>
                      {['running', 'queued', 'paused'].includes(run.state) && (
                        <>
                          <Button
                            onClick={() =>
                              void send({
                                type: 'control',
                                workspaceId: run.workspaceId,
                                runId: run.id,
                                action: run.state === 'paused' ? 'resume' : 'pause',
                              })
                            }
                          >
                            {run.state === 'paused' ? 'Resume' : 'Pause'}
                          </Button>
                          <Button
                            danger
                            onClick={() =>
                              void send({
                                type: 'control',
                                workspaceId: run.workspaceId,
                                runId: run.id,
                                action: 'cancel',
                              })
                            }
                          >
                            Cancel
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {run.error && <p className="notice error">{run.error}</p>}
                  {attempts
                    .filter((a) => a.runId === run.id)
                    .map((a) => (
                      <button
                        className="row w-full text-left"
                        key={a.id}
                        onClick={() => setDetail(a)}
                      >
                        <div>
                          <div className="text-sm">{a.taskId}</div>
                          <div className="text-xs muted mt-1">
                            Requested: {a.requestedModel} · Reported:{' '}
                            {a.reportedModel ?? 'not reported'} · {a.coverage} usage
                          </div>
                        </div>
                        <Badge>{a.state}</Badge>
                      </button>
                    ))}
                </section>
              ))}
            {!runs.length && (
              <div className="panel">
                <Empty title="No runs yet">
                  Planning and implementation sessions appear here with their results and usage.
                </Empty>
              </div>
            )}
          </div>
        )}
        {page === 'Usage' && <UsageView key={selected} data={data} workspaceId={selected} />}
        {page === 'Context' &&
          (ws ? (
            <Context workspace={ws} data={data} send={send} />
          ) : (
            <div className="panel">
              <Empty title="Choose a repository">
                Decisions, constraints, and handoffs stay in their originating workspace.
              </Empty>
            </div>
          ))}
        {page === 'Connections' &&
          (ws ? (
            <Connections workspace={ws} data={data} send={send} />
          ) : (
            <div className="panel">
              <Empty title="Choose a repository">
                MCP connections are scoped to a workspace. Select one to configure its tools.
              </Empty>
            </div>
          ))}
        {page === 'Settings' && <Settings data={data} workspace={ws} send={send} action={action} />}
      </main>
      {toast && (
        <div className="toast" role="status">
          <div className="flex gap-5">
            <span>{toast}</span>
            <button
              className="muted"
              onClick={() => setToast('')}
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {detail && (
        <AttemptDetails
          canDraft={data.runs.some(
            (r) => r.id === detail.runId && r.mode === 'plan' && r.purpose !== 'summary',
          )}
          attempt={data.attempts.find((a) => a.id === detail.id) ?? detail}
          close={() => setDetail(undefined)}
          send={send}
        />
      )}
    </div>
  );
}
type Send = (command: Command, message?: string) => Promise<unknown>;
function Planning({
  workspace,
  send,
  disabled,
}: {
  workspace: Workspace;
  send: Send;
  disabled: boolean;
}) {
  const [prompt, setPrompt] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send(
          { type: 'plan', workspaceId: workspace.id, prompt, role: 'planner' },
          'Planning queued. View the result in Runs.',
        );
      }}
    >
      <label className="label" htmlFor="goal">
        What would you like to build?
      </label>
      <textarea
        id="goal"
        rows={4}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the outcome and constraints…"
        required
      />
      <p className="text-xs muted">Uses your planner role and consumes Copilot usage.</p>
      <button className="btn primary" disabled={disabled || !prompt}>
        Generate a plan ↗
      </button>
    </form>
  );
}
const blankAgent: Omit<Agent, 'id' | 'version'> = {
  name: '',
  role: 'developer',
  prompt:
    'Implement the approved task. Inspect the project graph and source first. Explain changes and validation.',
  model: '',
  tools: ['read_file', 'list_files', 'graph_query', 'write_file'],
  mcpIds: [],
  archived: false,
};
function Agents({ data, workspace, send }: { data: Snapshot; workspace?: Workspace; send: Send }) {
  const [form, setForm] = useState<Partial<Agent>>(blankAgent),
    [profiles, setProfiles] = useState<unknown>();
  return (
    <div className="grid-main">
      <div className="stack">
        <section className="panel">
          <h2>Custom agents</h2>
          <p className="text-xs muted">
            Used per role when the selected repository has no matching agent.
          </p>
          {data.agents.map((a) => (
            <div className="row" key={a.id}>
              <div>
                <h3>
                  {a.name} <Badge>{a.archived ? 'archived' : 'Custom'}</Badge>
                </h3>
                <div className="text-xs muted mt-2">
                  {a.role} · {a.model} · v{a.version}
                </div>
              </div>
              <div className="toolbar">
                <Button onClick={() => setForm(a)}>Edit</Button>
                <Button
                  onClick={() =>
                    setForm({ ...a, id: undefined, name: `${a.name} copy`, role: `${a.role}-copy` })
                  }
                >
                  Duplicate
                </Button>
                <Button
                  onClick={() =>
                    void send({ type: 'saveAgent', agent: { ...a, archived: !a.archived } })
                  }
                >
                  {a.archived ? 'Restore' : 'Archive'}
                </Button>
              </div>
            </div>
          ))}
          {!data.agents.length && (
            <Empty title="Give each role a purpose">
              Create a planner with read tools, a developer with write tools, and a reviewer.
            </Empty>
          )}
        </section>
        {workspace && (
          <section className="panel">
            <h2>Repository agent discovery</h2>
            <p className="text-xs muted">
              Profiles in .github/agents/*.agent.md take precedence per role. Invalid profiles are
              surfaced before execution.
            </p>
            <Button
              onClick={() =>
                void send({ type: 'previewAgents', workspaceId: workspace.id }).then(setProfiles)
              }
            >
              Inspect repository profiles
            </Button>
            {profiles !== undefined && (
              <pre className="code mt-4">{JSON.stringify(profiles, null, 2)}</pre>
            )}
          </section>
        )}
      </div>
      <section className="panel">
        <h2>{form.id ? 'Edit agent' : 'Create an agent'}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send({ type: 'saveAgent', agent: form as Agent }, 'Agent version saved.').then(
              () => setForm(blankAgent),
            );
          }}
        >
          <Field label="Name">
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Role / repository identity">
            <input
              required
              pattern="[\w-]+"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
          </Field>
          <Field label="Copilot model">
            <select
              required
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            >
              <option value="">Select an available model</option>
              {data.runtime.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Instructions">
            <textarea
              rows={6}
              required
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            />
          </Field>
          <span className="label">Allowed tools</span>
          <div className="space-y-2">
            {toolNames.map((t) => (
              <label className="flex items-center gap-2 text-xs" key={t}>
                <input
                  type="checkbox"
                  checked={form.tools?.includes(t)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      tools: e.target.checked
                        ? [...(form.tools ?? []), t]
                        : form.tools?.filter((x) => x !== t),
                    })
                  }
                />
                {t}
                {t === 'run_command' && <span className="muted">· separate confirmation</span>}
              </label>
            ))}
          </div>
          {workspace && (
            <>
              <span className="label">MCP bindings for {workspace.name}</span>
              {data.mcp
                .filter((s) => s.workspaceId === workspace.id && s.enabled)
                .map((s) => (
                  <label className="flex items-center gap-2 text-xs my-2" key={s.id}>
                    <input
                      type="checkbox"
                      checked={form.mcpIds?.includes(s.id)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          mcpIds: e.target.checked
                            ? [...(form.mcpIds ?? []), s.id]
                            : form.mcpIds?.filter((id) => id !== s.id),
                        })
                      }
                    />
                    {s.name}
                  </label>
                ))}
            </>
          )}
          <div className="toolbar mt-6">
            <button className="btn primary">Save agent</button>
            <Button onClick={() => setForm(blankAgent)}>Reset</Button>
          </div>
        </form>
      </section>
    </div>
  );
}
function Workflows({
  workspace,
  data,
  send,
}: {
  workspace: Workspace;
  data: Snapshot;
  send: Send;
}) {
  const [title, setTitle] = useState(''),
    [tasks, setTasks] = useState<Task[]>([
      { id: 'task-1', title: '', prompt: '', role: 'developer', dependsOn: [], source: 'auto' },
    ]),
    [concurrency, setConcurrency] = useState(2),
    [maxTokens, setMaxTokens] = useState(100000),
    [timeout, setTimeoutMinutes] = useState(15),
    [preview, setPreview] = useState<Plan>();
  const edit = (i: number, patch: Partial<Task>) => {
    setTasks(tasks.map((t, j) => (i === j ? { ...t, ...patch } : t)));
    setPreview(undefined);
  };
  return (
    <div className="stack">
      <section className="panel">
        <h2>Compose a workflow</h2>
        {data.templates.length > 0 && (
          <Field label="Portable workflow template">
            <select
              defaultValue=""
              onChange={(e) => {
                const template = data.templates.find((t) => t.id === e.target.value);
                if (template) {
                  setTitle(template.title);
                  setTasks(structuredClone(template.tasks));
                  setConcurrency(template.limits.concurrency);
                  setMaxTokens(template.limits.maxTokens);
                  setTimeoutMinutes(template.limits.timeoutMinutes);
                  setPreview(undefined);
                }
              }}
            >
              <option value="">Choose an imported template</option>
              {data.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        <p className="text-sm muted">
          Independent tasks can run together. Dependencies receive predecessor changes and selected
          context.
        </p>
        <Field label="Workflow title">
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setPreview(undefined);
            }}
            placeholder="Implement the workspace dashboard"
          />
        </Field>
        <div className="form-grid">
          <Field label="Parallel task limit">
            <input
              type="number"
              min={1}
              max={8}
              value={concurrency}
              onChange={(e) => {
                setConcurrency(+e.target.value);
                setPreview(undefined);
              }}
            />
          </Field>
          <Field label="Observed token dispatch limit">
            <input
              type="number"
              min={1}
              value={maxTokens}
              onChange={(e) => {
                setMaxTokens(+e.target.value);
                setPreview(undefined);
              }}
            />
          </Field>
          <Field label="Timeout per attempt (minutes)">
            <input
              type="number"
              min={1}
              max={120}
              value={timeout}
              onChange={(e) => {
                setTimeoutMinutes(+e.target.value);
                setPreview(undefined);
              }}
            />
          </Field>
        </div>
        <div className="toolbar mt-5">
          <Button
            onClick={() => {
              setTasks(tasks.map((t, i) => ({ ...t, dependsOn: i ? [tasks[i - 1].id] : [] })));
              setPreview(undefined);
            }}
          >
            Make sequential
          </Button>
          <Button
            onClick={() => {
              setTasks(tasks.map((t) => ({ ...t, dependsOn: [] })));
              setPreview(undefined);
            }}
          >
            Make parallel
          </Button>
        </div>
        <div className="stack mt-6">
          {tasks.map((task, i) => (
            <div className="task-line" key={task.id}>
              <div className="flex justify-between items-center">
                <h3>{task.id}</h3>
                <Button
                  onClick={() => {
                    setTasks(
                      tasks
                        .filter((_, j) => j !== i)
                        .map((t) => ({
                          ...t,
                          dependsOn: t.dependsOn.filter((d) => d !== task.id),
                        })),
                    );
                    setPreview(undefined);
                  }}
                  disabled={tasks.length === 1}
                >
                  Remove
                </Button>
              </div>
              <div className="form-grid">
                <Field label="Task title">
                  <input value={task.title} onChange={(e) => edit(i, { title: e.target.value })} />
                </Field>
                <Field label="Agent role">
                  <input
                    list="roles"
                    value={task.role}
                    onChange={(e) => edit(i, { role: e.target.value })}
                  />
                  <datalist id="roles">
                    {data.agents.map((a) => (
                      <option key={a.id} value={a.role} />
                    ))}
                  </datalist>
                </Field>
              </div>
              <Field label="Task instructions">
                <textarea
                  rows={3}
                  value={task.prompt}
                  onChange={(e) => edit(i, { prompt: e.target.value })}
                />
              </Field>
              <div className="form-grid">
                <Field label="Source precedence">
                  <select
                    value={task.source}
                    onChange={(e) => edit(i, { source: e.target.value as Task['source'] })}
                  >
                    <option value="auto">Repository first, custom fallback</option>
                    <option value="repository">Repository only</option>
                    <option value="custom">Explicit custom override</option>
                  </select>
                </Field>
                <Field label="Prerequisites (comma separated IDs)">
                  <input
                    value={task.dependsOn.join(', ')}
                    onChange={(e) =>
                      edit(i, {
                        dependsOn: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="task-1, task-2"
                  />
                </Field>
              </div>
            </div>
          ))}
        </div>
        <div className="toolbar mt-6">
          <Button
            onClick={() => {
              setTasks([
                ...tasks,
                {
                  id: `task-${Math.max(...tasks.map((t) => Number(t.id.split('-')[1]) || 0)) + 1}`,
                  title: '',
                  prompt: '',
                  role: 'developer',
                  dependsOn: [],
                  source: 'auto',
                },
              ]);
              setPreview(undefined);
            }}
          >
            ＋ Add task
          </Button>
          <Button
            primary
            disabled={!title || tasks.some((t) => !t.title || !t.prompt)}
            onClick={() =>
              void send({
                type: 'savePlan',
                workspaceId: workspace.id,
                title,
                tasks,
                limits: { concurrency, maxTokens, timeoutMinutes: timeout },
              }).then((p) => setPreview(p as Plan))
            }
          >
            Resolve and preview approval
          </Button>
        </div>
      </section>
      {preview && (
        <PlanCard plan={data.plans.find((p) => p.id === preview.id) ?? preview} send={send} />
      )}
    </div>
  );
}
function PlanCard({ plan, send }: { plan: Plan; send: Send }) {
  return (
    <section className="panel">
      <div className="flex justify-between items-start">
        <div>
          <h2>{plan.title}</h2>
          <div className="text-xs muted">
            Revision {plan.revision} · {time(plan.createdAt)}
          </div>
        </div>
        <Badge>{plan.state}</Badge>
      </div>
      <div className="text-xs muted mono mt-4">
        Base {plan.base.slice(0, 12)} · Scope {plan.hash.slice(0, 16)}
      </div>
      <div className="text-xs muted mt-2">
        Concurrency {plan.limits.concurrency} · {count(plan.limits.maxTokens)} token dispatch
        threshold · {plan.limits.timeoutMinutes} min / attempt
      </div>
      {plan.state === 'draft' && (
        <p className="text-sm muted mt-2">
          Drafts can be saved with local changes. Commit or stash them before approval. After a
          commit, create a fresh draft to capture the new repository base.
        </p>
      )}
      {plan.headroom?.enabled && (
        <p className="text-xs muted mt-2">
          Headroom: {plan.headroom.baseUrl} · compress read tool results above{' '}
          {count(plan.headroom.minCharacters)} characters; original results remain available.
        </p>
      )}
      {plan.tasks.map((t) => (
        <div className="row" key={t.id}>
          <div>
            <h3>{t.title}</h3>
            <div className="text-xs muted mt-2">
              <Badge>{t.agent.source === 'repository' ? 'Repository' : 'Custom'}</Badge>{' '}
              <span className="ml-2">
                {t.agent.name} · {t.agent.model}
              </span>
            </div>
            <div className="text-xs muted mt-2">
              Tools: {t.agent.tools.join(', ')} · Depends on: {t.dependsOn.join(', ') || 'none'}
            </div>
            <div className="text-xs muted mt-1 break-all">
              Source: {t.agent.sourcePath} · {t.agent.hash.slice(0, 12)}
            </div>
          </div>
        </div>
      ))}
      <details>
        <summary>Full immutable scope and selected context</summary>
        <pre className="code">{JSON.stringify(plan, null, 2)}</pre>
      </details>
      <div className="toolbar mt-4">
        {plan.state === 'draft' && (
          <>
            <Button
              primary
              onClick={() =>
                void send({
                  type: 'approve',
                  workspaceId: plan.workspaceId,
                  planId: plan.id,
                  hash: plan.hash,
                  decision: 'approve',
                })
              }
            >
              Review and approve
            </Button>
            <Button
              danger
              onClick={() =>
                void send({
                  type: 'approve',
                  workspaceId: plan.workspaceId,
                  planId: plan.id,
                  hash: plan.hash,
                  decision: 'reject',
                })
              }
            >
              Reject
            </Button>
          </>
        )}
        {plan.state === 'approved' && (
          <Button
            primary
            onClick={() =>
              void send(
                { type: 'execute', workspaceId: plan.workspaceId, planId: plan.id },
                'Execution queued.',
              )
            }
          >
            Start approved execution ↗
          </Button>
        )}
        {plan.state === 'stale' && (
          <span className="text-xs muted">
            Scope changed. Create a fresh workflow preview and approve it.
          </span>
        )}
      </div>
    </section>
  );
}
function UsageView({ data, workspaceId }: { data: Snapshot; workspaceId: string }) {
  const filterKey = `usage-filters:${workspaceId}`;
  const [saved] = useState<{ model?: string; query?: string; date?: string }>(() => {
    try {
      return JSON.parse(localStorage.getItem(filterKey) ?? '{}');
    } catch {
      return {};
    }
  });
  const [model, setModel] = useState(saved.model ?? ''),
    [query, setQuery] = useState(saved.query ?? ''),
    [date, setDate] = useState(saved.date ?? '');
  useEffect(() => {
    localStorage.setItem(filterKey, JSON.stringify({ model, query, date }));
  }, [filterKey, model, query, date]);
  const rows = data.usage.filter(
    (u) =>
      (workspaceId === 'all' || u.workspaceId === workspaceId) &&
      (!model || u.model === model) &&
      (!date || u.timestamp.slice(0, 10) >= date) &&
      (!query || [u.runId, u.taskId, u.agentId, u.attemptId].some((v) => v.includes(query))),
  );
  const sum = (field: 'input' | 'output' | 'reasoning' | 'cacheRead') => {
    const deltas = rows.filter((u) => u.kind === 'delta');
    return deltas.some((u) => u[field] !== null)
      ? deltas.reduce((n, u) => n + (u[field] ?? 0), 0)
      : null;
  };
  return (
    <div className="stack">
      <div className="metrics">
        {[
          ['Input tokens', sum('input')],
          ['Output tokens', sum('output')],
          ['Reasoning subset', sum('reasoning')],
          ['Cache read subset', sum('cacheRead')],
        ].map(([label, value]) => (
          <div className="panel metric" key={label}>
            <div className="eyebrow">{label}</div>
            <strong>{count(value as number | null)}</strong>
          </div>
        ))}
      </div>
      <div className="notice">
        Missing counters remain unknown. Reasoning and cache counters are displayed separately and
        are not added to input/output totals. Tokens are not a billing invoice.
      </div>
      <section className="panel">
        <div className="form-grid mb-4">
          <Field label="Model">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">All reported models</option>
              {[...new Set(data.usage.map((u) => u.model).filter(Boolean))].map((m) => (
                <option key={m} value={m!}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Run, task, agent, or attempt ID">
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </Field>
          <Field label="From date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Workspace / task</th>
                <th>Reported model</th>
                <th>Input</th>
                <th>Output</th>
                <th>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .slice(-200)
                .reverse()
                .map((u) => (
                  <tr key={u.id}>
                    <td>{time(u.timestamp)}</td>
                    <td>
                      {data.workspaces.find((w) => w.id === u.workspaceId)?.name}
                      <div className="muted">{u.taskId}</div>
                    </td>
                    <td>{u.model ?? 'Not reported'}</td>
                    <td>{count(u.input)}</td>
                    <td>{count(u.output)}</td>
                    <td>
                      <Badge>{u.coverage}</Badge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <Empty title="No usage observations">
            Usage appears when Copilot reports it. Interrupted streams may have incomplete coverage.
          </Empty>
        )}
        <p className="text-xs muted">
          Showing the latest 200 matching observations. All matching deltas are included in totals.
        </p>
      </section>
    </div>
  );
}
function Context({ workspace, data, send }: { workspace: Workspace; data: Snapshot; send: Send }) {
  const [text, setText] = useState(''),
    [kind, setKind] = useState<ContextItem['kind']>('constraint'),
    [target, setTarget] = useState('');
  return (
    <div className="grid-main">
      <section className="panel">
        <h2>Selected knowledge</h2>
        <Button
          disabled={!data.context.some((c) => c.workspaceId === workspace.id)}
          onClick={() =>
            void send(
              { type: 'summarizeContext', workspaceId: workspace.id },
              'Read-only Copilot summary queued. The completed handoff and its usage will be saved.',
            )
          }
        >
          Summarize context with Copilot
        </Button>
        <p className="text-xs muted">
          Current items are frozen into new plan snapshots. Transfers create explicit provenance.
        </p>
        {data.context
          .filter((c) => c.workspaceId === workspace.id)
          .map((c) => (
            <div className="row" key={c.id}>
              <div>
                <Badge>{c.kind}</Badge>
                <p className="text-sm whitespace-pre-wrap">{c.text}</p>
                <div className="text-xs muted">
                  {time(c.createdAt)}
                  {c.provenance && ` · From ${c.provenance}`}
                </div>
                {target && (
                  <Button
                    onClick={() =>
                      void send(
                        {
                          type: 'transferContext',
                          workspaceId: workspace.id,
                          targetWorkspaceId: target,
                          contextId: c.id,
                        },
                        'Context copied with provenance.',
                      )
                    }
                  >
                    Copy to selected workspace
                  </Button>
                )}
              </div>
            </div>
          ))}
        <Field label="Explicit transfer destination">
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">No transfer destination</option>
            {data.workspaces
              .filter((w) => w.id !== workspace.id)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </Field>
      </section>
      <section className="panel">
        <h2>Add context</h2>
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value as ContextItem['kind'])}>
            <option value="constraint">Constraint</option>
            <option value="decision">Decision</option>
            <option value="handoff">Handoff</option>
          </select>
        </Field>
        <Field label="Content">
          <textarea rows={9} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="mt-4">
          <Button
            primary
            disabled={!text}
            onClick={() =>
              void send({ type: 'addContext', workspaceId: workspace.id, text, kind }).then(() =>
                setText(''),
              )
            }
          >
            Save context
          </Button>
        </div>
      </section>
    </div>
  );
}
function Connections({
  workspace,
  data,
  send,
}: {
  workspace: Workspace;
  data: Snapshot;
  send: Send;
}) {
  const initial = {
    name: '',
    transport: 'stdio' as Mcp['transport'],
    endpoint: '',
    args: [] as string[],
    tools: [] as string[],
    auth: 'none' as Mcp['auth'],
    secretName: 'Authorization',
    enabled: false,
  };
  const [form, setForm] = useState<Partial<Mcp>>(initial),
    [args, setArgs] = useState('[]'),
    [secret, setSecret] = useState(''),
    [tools, setTools] = useState('');
  return (
    <div className="grid-main">
      <section className="panel">
        <h2>Workspace connections</h2>
        <p className="text-xs muted">
          Saving never launches a server. Test or authenticate explicitly, then enable and bind
          tools to an agent.
        </p>
        {data.mcp
          .filter((m) => m.workspaceId === workspace.id)
          .map((m) => (
            <div className="py-5 border-b border-[var(--line)]" key={m.id}>
              <div className="flex justify-between">
                <h3>{m.name}</h3>
                <Badge>{m.state}</Badge>
              </div>
              <p className="text-xs muted break-all">
                {m.transport} · {m.endpoint}
              </p>
              <div className="toolbar">
                <Button
                  onClick={() => {
                    setForm(m);
                    setArgs(JSON.stringify(m.args));
                    setTools(m.tools.join(', '));
                    setSecret('');
                  }}
                >
                  Edit
                </Button>
                <Button
                  onClick={() =>
                    void send({
                      type: 'mcpAction',
                      workspaceId: workspace.id,
                      serverId: m.id,
                      action: 'test',
                    })
                  }
                >
                  Test / list tools
                </Button>
                {m.auth === 'oauth' && (
                  <Button
                    onClick={() =>
                      void send({
                        type: 'mcpAction',
                        workspaceId: workspace.id,
                        serverId: m.id,
                        action: 'authenticate',
                      })
                    }
                  >
                    Authenticate
                  </Button>
                )}
                <Button
                  onClick={() =>
                    void send({
                      type: 'mcpAction',
                      workspaceId: workspace.id,
                      serverId: m.id,
                      action: 'disconnect',
                    })
                  }
                >
                  Disable
                </Button>
                <Button
                  onClick={() =>
                    void send({
                      type: 'mcpAction',
                      workspaceId: workspace.id,
                      serverId: m.id,
                      action: 'clear',
                    })
                  }
                >
                  Clear app secret
                </Button>
              </div>
              {m.diagnostic && (
                <details>
                  <summary>Last observed diagnostic</summary>
                  <pre className="code">{m.diagnostic}</pre>
                </details>
              )}
            </div>
          ))}
        {!data.mcp.some((m) => m.workspaceId === workspace.id) && (
          <Empty title="No connections configured">
            Connect an existing local MCP executable or an HTTPS endpoint.
          </Empty>
        )}
      </section>
      <section className="panel">
        <h2>{form.id ? 'Edit connection' : 'Add connection'}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            let parsed: string[];
            try {
              parsed = JSON.parse(args);
              if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string'))
                throw new Error();
            } catch {
              window.alert('Arguments must be a JSON array of strings.');
              return;
            }
            void send(
              {
                type: 'saveMcp',
                workspaceId: workspace.id,
                server: {
                  ...form,
                  args: parsed,
                  tools: tools
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                } as Mcp,
                secret: secret || undefined,
              },
              'Connection saved without launching.',
            ).then(() => setSecret(''));
          }}
        >
          <Field label="Connection name">
            <input
              required
              pattern="[\w-]+"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Transport">
            <select
              value={form.transport}
              onChange={(e) => setForm({ ...form, transport: e.target.value as Mcp['transport'] })}
            >
              <option value="stdio">Local executable (stdio)</option>
              <option value="http">Streamable HTTP</option>
              <option value="sse">Legacy SSE</option>
            </select>
          </Field>
          <Field
            label={form.transport === 'stdio' ? 'Executable (no shell string)' : 'Endpoint URL'}
          >
            <input
              required
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
            />
          </Field>
          {form.transport === 'stdio' && (
            <Field label="Arguments (JSON array)">
              <textarea
                rows={2}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={'["C:/tools/server.js"]'}
              />
            </Field>
          )}
          <Field label="Authentication">
            <select
              value={form.auth}
              onChange={(e) => setForm({ ...form, auth: e.target.value as Mcp['auth'] })}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="api-key">API key</option>
              <option value="oauth">Runtime-managed OAuth</option>
            </select>
          </Field>
          {['bearer', 'api-key'].includes(form.auth ?? '') && (
            <>
              <Field
                label={form.transport === 'stdio' ? 'Environment variable name' : 'Header name'}
              >
                <input
                  value={form.secretName}
                  onChange={(e) => setForm({ ...form, secretName: e.target.value })}
                />
              </Field>
              <Field label="Secret (stored with OS protection)">
                <input
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={form.secretRef ? 'Saved secret ••••••••' : 'Enter secret'}
                />
              </Field>
            </>
          )}
          <Field label="Allowed tools (comma separated, empty grants none)">
            <input value={tools} onChange={(e) => setTools(e.target.value)} />
          </Field>
          <label className="flex gap-2 items-center text-xs my-4">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            Enable for explicit agent bindings
          </label>
          <div className="toolbar">
            <button className="btn primary">Save connection</button>
            <Button
              onClick={() => {
                setForm(initial);
                setArgs('[]');
                setTools('');
                setSecret('');
              }}
            >
              New
            </Button>
          </div>
        </form>
        <p className="text-xs muted mt-5">
          Copilot sign-in and MCP authentication are separate. Figma access depends on its supported
          client and account policy.
        </p>
      </section>
    </div>
  );
}
function Settings({
  data,
  workspace,
  send,
  action,
}: {
  data: Snapshot;
  workspace?: Workspace;
  send: Send;
  action: (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;
}) {
  const [storage, setStorage] = useState<{
    databaseBytes: number;
    events: number;
    retentionDays: number;
    worktrees: number;
  }>();
  const [retention, setRetention] = useState(90);
  const [headroom, setHeadroom] = useState(data.headroom.config);
  const [checkingHeadroom, setCheckingHeadroom] = useState(false);
  useEffect(() => {
    void send({ type: 'checkHeadroom', baseUrl: data.headroom.config.baseUrl });
  }, []);
  useEffect(() => {
    void window.desktop
      .request<{ databaseBytes: number; events: number; retentionDays: number; worktrees: number }>(
        { type: 'storage' },
      )
      .then((s) => {
        setStorage(s);
        setRetention(s.retentionDays);
      });
  }, []);
  const [model, setModel] = useState(workspace?.model ?? ''),
    [cap, setCap] = useState(workspace?.concurrency ?? 2),
    [global, setGlobal] = useState(data.settings.globalConcurrency);
  useEffect(() => {
    setModel(workspace?.model ?? '');
    setCap(workspace?.concurrency ?? 2);
  }, [workspace?.id]);
  return (
    <div className="grid-main">
      <div className="stack">
        <section className="panel">
          <h2>GitHub Copilot</h2>
          <div className="toolbar">
            <Badge>{data.runtime.state}</Badge>
            {data.runtime.login && <span className="text-sm">{data.runtime.login}</span>}
          </div>
          <p className="text-sm muted">
            Uses your signed-in Copilot identity. Sign in with the Copilot CLI or{' '}
            <code>gh auth login</code>, then refresh the account model catalog.
          </p>
          {data.runtime.error && <p className="notice error">{data.runtime.error}</p>}
          <div className="toolbar">
            <Button primary onClick={() => void send({ type: 'login' })}>
              Sign in with GitHub
            </Button>
            <Button onClick={() => void send({ type: 'runtime' })}>
              Check connection and models
            </Button>
          </div>
          <div className="text-xs muted mt-4">
            Runtime: {data.runtime.version ?? 'not checked'} · {data.runtime.models.length}{' '}
            available models
          </div>
          <details>
            <summary>Available models</summary>
            <pre className="code">
              {data.runtime.models.map((m) => `${m.id} — ${m.name}`).join('\n') ||
                'Connect to discover account-available models.'}
            </pre>
          </details>
        </section>
        {workspace && (
          <section className="panel">
            <h2>{workspace.name} settings</h2>
            <Field label="Default model for repository agents without an explicit model">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Select a model</option>
                {data.runtime.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Workspace concurrency">
              <input
                type="number"
                min={1}
                max={8}
                value={cap}
                onChange={(e) => setCap(+e.target.value)}
              />
            </Field>
            <div className="mt-4">
              <Button
                onClick={() =>
                  void send(
                    {
                      type: 'workspaceSettings',
                      workspaceId: workspace.id,
                      model,
                      concurrency: cap,
                    },
                    'Workspace settings saved; existing approvals invalidated.',
                  )
                }
              >
                Save workspace settings
              </Button>
            </div>
          </section>
        )}
        <section className="panel">
          <h2>Backup and portability</h2>
          {storage && (
            <p className="text-xs muted">
              Database: {(storage.databaseBytes / 1024 / 1024).toFixed(1)} MB ·{' '}
              {count(storage.events)} persisted events · {storage.worktrees} retained worktree
              references
            </p>
          )}
          <p className="text-sm muted">
            SQLite backups use a consistent snapshot, including persisted plans, results, and
            encrypted secret records. Worktree directories remain on disk and are not included.
          </p>
          <div className="toolbar">
            <Button
              onClick={() => void action(() => window.desktop.backup(), 'Database backup saved.')}
            >
              Back up database
            </Button>
            <Button onClick={() => void action(() => window.desktop.restore())}>
              Restore database
            </Button>
            <Button
              onClick={() =>
                void action(
                  () => window.desktop.exportDefinitions(),
                  'Definitions exported without credentials.',
                )
              }
            >
              Export definitions
            </Button>
            <Button
              onClick={() =>
                void action(
                  () => window.desktop.importDefinitions(workspace?.id),
                  'Definitions imported with fresh IDs, archived agents, disabled connections, and no approvals.',
                )
              }
            >
              Import definitions
            </Button>
          </div>
          <Field label="Keep detailed history for at least this many days">
            <input
              type="number"
              min={1}
              max={3650}
              value={retention}
              onChange={(e) => setRetention(+e.target.value)}
            />
          </Field>
          <div className="mt-3">
            <Button
              onClick={() =>
                void send(
                  { type: 'pruneHistory', days: retention },
                  'Retention action completed. Run identities, plans, and source files are retained.',
                )
              }
            >
              Review eligible history cleanup
            </Button>
          </div>
        </section>
      </div>
      <div className="stack">
        <section className="panel">
          <h2>Headroom context compression</h2>
          <Badge>{data.headroom.status.state}</Badge>
          <p className="text-sm muted">
            Use a local Headroom server to compress large file reads, directory listings, and
            Graphify results. Copilot remains the model provider. If compression fails, the original
            result is used. The agent can request original results with raw=true.
          </p>
          <Field label="Headroom local URL">
            <input
              value={headroom.baseUrl}
              onChange={(e) => setHeadroom({ ...headroom, baseUrl: e.target.value })}
              placeholder="http://127.0.0.1:8787"
            />
          </Field>
          <label className="flex gap-2 items-center my-4">
            <input
              type="checkbox"
              checked={headroom.enabled}
              onChange={(e) => setHeadroom({ ...headroom, enabled: e.target.checked })}
            />
            Enable Headroom for new plans
          </label>
          <Field label="Compress results above this many characters">
            <input
              type="number"
              min={500}
              max={100000}
              value={headroom.minCharacters}
              onChange={(e) => setHeadroom({ ...headroom, minCharacters: +e.target.value })}
            />
          </Field>
          <Field label="Headroom timeout (milliseconds)">
            <input
              type="number"
              min={500}
              max={30000}
              value={headroom.timeoutMs}
              onChange={(e) => setHeadroom({ ...headroom, timeoutMs: +e.target.value })}
            />
          </Field>
          <div className="toolbar mt-4">
            <Button
              disabled={checkingHeadroom}
              onClick={() => {
                setCheckingHeadroom(true);
                void send({ type: 'checkHeadroom', baseUrl: headroom.baseUrl }).finally(() =>
                  setCheckingHeadroom(false),
                );
              }}
            >
              {checkingHeadroom ? 'Checking…' : 'Check Headroom'}
            </Button>
            <Button
              primary
              disabled={checkingHeadroom}
              onClick={() => {
                setCheckingHeadroom(true);
                void send(
                  { type: 'saveHeadroom', config: headroom },
                  'Headroom settings saved. Create fresh plans to use this configuration.',
                ).finally(() => setCheckingHeadroom(false));
              }}
            >
              Save Headroom settings
            </Button>
          </div>
          {data.headroom.status.detail && (
            <p className="notice">
              {data.headroom.status.baseUrl}: {data.headroom.status.detail}
            </p>
          )}
          <p className="text-xs muted mt-3">
            Start your installed service with <code>headroom proxy --port 8787</code>, then check
            and enable it here. Saving checks availability before enabling. Existing plans keep
            their configuration and require renewed approval after changes. Compression observations
            appear in run events; they are separate from Copilot usage.
          </p>
        </section>
        <section className="panel">
          <h2>Application preferences</h2>
          <Field label="Global concurrent agent limit">
            <input
              type="number"
              min={1}
              max={16}
              value={global}
              onChange={(e) => setGlobal(+e.target.value)}
            />
          </Field>
          <div className="mt-4">
            <Button
              onClick={() =>
                void send(
                  { type: 'settings', ...data.settings, globalConcurrency: global },
                  'Global limit saved. Existing plans are revalidated before dispatch.',
                )
              }
            >
              Save limit
            </Button>
          </div>
          <Field label="Appearance">
            <select
              value={data.settings.theme}
              onChange={(e) =>
                void send({
                  type: 'settings',
                  ...data.settings,
                  theme: e.target.value as 'dark' | 'light',
                })
              }
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </Field>
        </section>
        <section className="panel">
          <h2>Automatic desktop updates</h2>
          <Badge>{data.update?.state ?? 'unchecked'}</Badge>
          <p className="text-sm muted">
            Release updates download automatically and install silently at idle or on exit. Active,
            queued, or paused runs prevent an automatic restart.
          </p>
          {data.update?.detail && <p className="notice">{data.update.detail}</p>}
          <Button onClick={() => void action(() => window.desktop.update())}>
            Check for updates
          </Button>
        </section>
      </div>
    </div>
  );
}
function AttemptDetails({
  attempt,
  close,
  send,
  canDraft,
}: {
  attempt: Attempt;
  close: () => void;
  send: Send;
  canDraft?: boolean;
}) {
  const [events, setEvents] = useState<unknown[]>([]),
    [offset, setOffset] = useState(0);
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="panel modal"
        role="dialog"
        aria-modal="true"
        aria-label="Attempt details"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between">
          <h2>{attempt.taskId}</h2>
          <Button onClick={close}>Close</Button>
        </div>
        <div className="toolbar">
          <Badge>{attempt.state}</Badge>
          <Badge>{attempt.coverage}</Badge>
        </div>
        <p className="text-xs muted">
          Requested: {attempt.requestedModel} · Runtime reported:{' '}
          {attempt.reportedModel ?? 'not reported'}
        </p>
        <p className="text-xs muted break-all">
          {attempt.id}
          <br />
          {attempt.worktree}
        </p>
        {attempt.error && <p className="notice error">{attempt.error}</p>}
        <h3 className="my-4">Result</h3>
        <pre className="code">{attempt.output ?? 'No completed result yet.'}</pre>
        {canDraft && attempt.state === 'succeeded' && (
          <div className="mt-4">
            <Button
              primary
              onClick={() =>
                void send(
                  {
                    type: 'draftFromPlanning',
                    workspaceId: attempt.workspaceId,
                    attemptId: attempt.id,
                  },
                  'Draft workflow created. Open Approvals to review its exact scope.',
                )
              }
            >
              Create workflow draft from this plan
            </Button>
          </div>
        )}
        {attempt.diff && (
          <>
            <h3 className="my-4">File diff</h3>
            <pre className="code">{attempt.diff}</pre>
          </>
        )}
        <details>
          <summary>Exact context supplied to this attempt</summary>
          <pre className="code">{attempt.context ?? 'No context captured.'}</pre>
        </details>
        <details>
          <summary>Persisted events and tool evidence</summary>
          <Button
            onClick={() =>
              void send({
                type: 'events',
                workspaceId: attempt.workspaceId,
                attemptId: attempt.id,
                offset,
              }).then((result) => {
                if (Array.isArray(result)) {
                  setEvents([...events, ...result]);
                  setOffset(offset + result.length);
                }
              })
            }
          >
            Load next 100 events
          </Button>
          <pre className="code mt-3">{JSON.stringify(events, null, 2)}</pre>
        </details>
        {attempt.state === 'succeeded' && attempt.commit && (
          <div className="mt-5">
            <Button
              primary
              disabled={attempt.integrated}
              onClick={() =>
                void send(
                  { type: 'integrate', workspaceId: attempt.workspaceId, attemptId: attempt.id },
                  'Result integrated into the selected repository.',
                )
              }
            >
              {attempt.integrated ? 'Integrated' : 'Review and integrate changes'}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
