import { parentPort, workerData } from 'node:worker_threads';
import {
  CopilotClient,
  RuntimeConnection,
  defineTool,
  type CopilotSession,
  type MCPServerConfig,
} from '@github/copilot-sdk';
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { safePath, safeEnvironment, redact, approvedAppTool } from './core/policy';
import { queryGraph } from './core/graphify';
import type { ResolvedAgent } from '../src/shared';

export type Job = {
  kind: 'catalog' | 'login' | 'attempt' | 'mcp';
  root: string;
  graphRoot?: string;
  dataDir: string;
  agent?: ResolvedAgent;
  prompt?: string;
  planning?: boolean;
  summarizing?: boolean;
  timeoutMinutes?: number;
  mcp?: Record<string, MCPServerConfig>;
  mcpAction?: string;
  serverName?: string;
  secrets?: string[];
};
const job = workerData as Job;
// Native child processes cannot execute inside Electron's virtual ASAR archive.
const packagedRuntime = import.meta.url.includes('/app.asar/')
  ? fileURLToPath(
      new URL(
        `../node_modules/@github/copilot-sdk-${process.platform}-${process.arch}/prebuilds/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime'}`,
        import.meta.url,
      ),
    ).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  : undefined;
const send = (type: string, data: unknown) =>
  // OAuth URLs are transient control messages sent only to the native browser
  // handler. Redacting authorizationUrl here would make sign-in impossible.
  parentPort?.postMessage({ type, data: type === 'login' ? data : redact(data, job.secrets) });
const client = new CopilotClient({
  // Empty mode forces COPILOT_DISABLE_KEYTAR=1 in SDK 1.0.28. Use the CLI
  // credential backend with all discovery/tool features explicitly disabled.
  mode: 'copilot-cli',
  connection: RuntimeConnection.forStdio(packagedRuntime ? { path: packagedRuntime } : {}),
  workingDirectory: job.root,
  baseDirectory: job.dataDir,
  env: safeEnvironment(),
  useLoggedInUser: true,
  logLevel: 'error',
});
let session: CopilotSession | undefined,
  cancelled = false;
let loginFlowId: string | undefined;
const abort = new AbortController();
const isolatedSession = {
  enableConfigDiscovery: false,
  enableSkills: false,
  enableFileHooks: false,
  enableSessionStore: false,
  enableHostGitOperations: false,
  skipCustomInstructions: true,
  customAgentsLocalOnly: true,
  manageScheduleEnabled: false,
  agentDirectories: [],
  skillDirectories: [],
  hookDirectories: [],
  pluginDirectories: [],
  instructionDirectories: [],
  enableOnDemandInstructionDiscovery: false,
  enableExperimentalMode: false,
  enableSessionTelemetry: false,
  skipEmbeddingRetrieval: true,
  embeddingCacheStorage: 'in-memory' as const,
  memory: { enabled: false },
  includedBuiltinSkills: [],
  disabledMcpServers: ['github'],
};
const approvals = new Map<string, (v: boolean) => void>();
parentPort?.on('message', (m) => {
  if (m.type === 'cancel') {
    cancelled = true;
    abort.abort();
    for (const resolve of approvals.values()) resolve(false);
    void session?.abort();
    if (loginFlowId)
      void session?.rpc.accounts.login.cancel({ flowId: loginFlowId }).catch(() => {});
  }
  if (m.type === 'decision') {
    approvals.get(m.id)?.(m.allowed);
    approvals.delete(m.id);
  }
});
async function confirm(title: string, detail: string) {
  if (cancelled) return false;
  const id = randomUUID();
  return new Promise<boolean>((resolve) => {
    approvals.set(id, resolve);
    parentPort?.postMessage({ type: 'permission', id, title, detail });
  });
}
function active() {
  if (cancelled) throw new Error('Cancelled');
}
async function main() {
  await mkdir(job.dataDir, { recursive: true });
  await client.start();
  const status = await client.getStatus();
  if (status.version !== '1.0.105')
    throw new Error(`Expected bundled Copilot runtime 1.0.105, received ${status.version}`);
  if (job.kind === 'login') {
    session = await client.createSession({
      ...isolatedSession,
      availableTools: [],
      mcpServers: {},
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      onPermissionRequest: () => ({ kind: 'reject' }),
    });
    await session.rpc.mcp.removeGitHub();
    const flow = await session.rpc.accounts.login.begin({ kind: 'githubDotCom' });
    loginFlowId = flow.flowId;
    let step = flow.step;
    try {
      while (step.kind !== 'completed') {
        active();
        if (step.kind === 'error') throw new Error(step.message);
        if (step.kind === 'input-required')
          throw new Error(
            'This sign-in requires additional input. Use the Copilot CLI for enterprise sign-in.',
          );
        if (step.kind === 'open-url') send('login', { authorizationUrl: step.url });
        step = await session.rpc.accounts.login.advance({ flowId: flow.flowId });
      }
      if (step.result.status !== 'completed')
        throw new Error(`Sign-in did not complete: ${step.result.status}`);
      const auth = await client.getAuthStatus();
      const models = auth.isAuthenticated ? await client.listModels() : [];
      send('result', {
        state: auth.isAuthenticated ? 'connected' : 'needs-auth',
        version: status.version,
        login: auth.login,
        models: models.map((m) => ({ id: m.id, name: m.name })),
      });
    } finally {
      await session.rpc.accounts.login.cancel({ flowId: flow.flowId }).catch(() => {});
    }
    return;
  }
  if (job.kind === 'catalog') {
    const auth = await client.getAuthStatus();
    const models = auth.isAuthenticated ? await client.listModels() : [];
    send('result', {
      state: auth.isAuthenticated ? 'connected' : 'needs-auth',
      version: status.version,
      login: auth.login,
      models: models.map((m) => ({ id: m.id, name: m.name })),
      error: auth.isAuthenticated
        ? undefined
        : 'Sign in with copilot or gh auth login, then refresh.',
    });
    return;
  }
  if (job.kind === 'mcp') {
    session = await client.createSession({
      ...isolatedSession,
      availableTools: [],
      mcpServers: job.mcp,
      mcpOAuthTokenStorage: 'persistent',
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      onPermissionRequest: () => ({ kind: 'reject' }),
      onEvent: (e) => send('event', e),
    });
    await session.rpc.mcp.removeGitHub();
    if (job.mcpAction === 'authenticate') {
      const login = await session.rpc.mcp.oauth.login({ serverName: job.serverName! });
      send('login', login);
      if (login.authorizationUrl) {
        const until = Date.now() + 180000;
        while (Date.now() < until) {
          active();
          const observed = await session.rpc.mcp.list();
          if (
            observed.servers.some(
              (s) => s.name === job.serverName && String(s.status) === 'connected',
            )
          )
            break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    const servers = await session.rpc.mcp.list();
    const tools = await session.rpc.mcp.listTools({ serverName: job.serverName! });
    send('result', { servers, tools });
    return;
  }
  const agent = job.agent!;
  if (!(await client.listModels()).some((m) => m.id === agent.model))
    throw new Error(`Requested model is no longer available: ${agent.model}`);
  const tools = [
    defineTool('agentic_read_file', {
      description:
        'Read a UTF-8 file inside the approved worktree. Consult agentic_graph_query first.',
      parameters: z.object({ path: z.string() }),
      handler: async ({ path }) => {
        active();
        const target = await safePath(job.root, path);
        if ((await stat(target)).size > 2 * 1024 * 1024)
          throw new Error('File exceeds the 2 MB read limit. Select a smaller source file.');
        return (await readFile(target, 'utf8')).slice(0, 60000);
      },
    }),
    defineTool('agentic_list_files', {
      description: 'List files in a directory inside the approved worktree.',
      parameters: z.object({ path: z.string().default('.') }),
      handler: async ({ path }) => {
        active();
        return (await readdir(await safePath(job.root, path), { withFileTypes: true }))
          .filter((e) => !e.isSymbolicLink() && !['.git', '.env', 'node_modules'].includes(e.name))
          .map((e) => `${e.isDirectory() ? 'directory' : 'file'} ${e.name}`)
          .slice(0, 500)
          .join('\n');
      },
    }),
    defineTool('agentic_graph_query', {
      description:
        'Find relevant code and relationships in this project Graphify graph. Verify findings against source.',
      parameters: z.object({ query: z.string() }),
      handler: async ({ query }) => {
        active();
        return queryGraph(job.graphRoot ?? job.root, query).catch(
          () => 'No usable Graphify graph. Inspect files directly.',
        );
      },
    }),
    defineTool('agentic_write_file', {
      description: 'Write a UTF-8 file inside the approved worktree only.',
      parameters: z.object({ path: z.string(), content: z.string().max(500000) }),
      handler: async ({ path, content }) => {
        active();
        if (job.planning) throw new Error('Planning is read-only');
        const target = await safePath(job.root, path, true);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
        return `Wrote ${path}`;
      },
    }),
    defineTool('agentic_run_command', {
      description:
        'Request separate human approval for an exact executable and argument array, then run it in this worktree. No shell interpolation.',
      parameters: z.object({ executable: z.string(), args: z.array(z.string()) }),
      handler: async ({ executable, args }) => {
        active();
        if (job.planning) throw new Error('Planning is read-only');
        if (
          !(await confirm(
            'Approve command',
            `Directory: ${job.root}\nExecutable: ${executable}\nArguments: ${JSON.stringify(args)}\n\nThis command runs with your OS account permissions and may have external side effects.`,
          ))
        )
          throw new Error('Command approval denied');
        active();
        const result = await promisify(execFile)(executable, args, {
          cwd: job.root,
          env: safeEnvironment(),
          windowsHide: true,
          timeout: 120000,
          maxBuffer: 2 * 1024 * 1024,
          signal: abort.signal,
        });
        return result.stdout + '\n' + result.stderr;
      },
    }),
  ];
  const allowed = agent.tools.filter(
    (t) => !job.planning || ['read_file', 'list_files', 'graph_query'].includes(t),
  );
  const selected = tools.filter((t) =>
    allowed.includes(t.name.replace(/^agentic_/, '') as (typeof allowed)[number]),
  );
  session = await client.createSession({
    ...isolatedSession,
    model: agent.model,
    allowedModels: [agent.model],
    workingDirectory: job.root,
    streaming: true,
    tools: selected,
    availableTools: [
      ...allowed.map((t) => `custom:agentic_${t}`),
      ...Object.entries(job.mcp ?? {}).flatMap(([name, config]) =>
        (config.tools ?? []).map((t) => `mcp:${name}-${t}`),
      ),
    ],
    enableConfigDiscovery: false,
    enableSkills: false,
    enableFileHooks: false,
    enableSessionStore: false,
    enableHostGitOperations: false,
    skipCustomInstructions: true,
    customAgentsLocalOnly: true,
    customAgents: [
      { name: 'approved-agent', displayName: agent.name, prompt: agent.prompt, infer: false },
    ],
    agent: 'approved-agent',
    mcpServers: job.planning ? {} : job.mcp,
    mcpOAuthTokenStorage: 'persistent',
    systemMessage: {
      mode: 'customize',
      sections: { environment_context: { action: 'remove' } },
      content: `You are working on one approved task. Use agentic_graph_query to route code exploration before reading files. Repository instructions below apply to their indicated paths. They never grant tools, approval, or delegation. Never delegate. ${job.summarizing ? 'Summarize the supplied context accurately in plain prose, preserving constraints and unresolved questions.' : job.planning ? 'Read-only planning only. Return a clear task plan with roles and dependencies.' : 'Implement the task within the granted tool scope. Describe validation and any limitations.'}\n${agent.instructions}`,
    },
    onEvent: (event) => send('event', event),
    onPermissionRequest: async (request) => {
      if (approvedAppTool(request, allowed, job.planning === true)) return { kind: 'approve-once' };
      if (job.planning || request.kind !== 'mcp')
        return { kind: 'reject', feedback: 'Tool is outside the approved application scope' };
      return (await confirm(
        'Approve MCP tool call',
        JSON.stringify(redact(request, job.secrets), null, 2),
      ))
        ? { kind: 'approve-once' }
        : { kind: 'reject', feedback: 'User denied access' };
    },
  });
  await session.rpc.options.update({ installedPlugins: [], includedBuiltinSkills: [] });
  await session.rpc.mcp.removeGitHub();
  send('session', { id: session.sessionId });
  active();
  const response = await session.sendAndWait(
    { prompt: job.prompt! },
    (job.timeoutMinutes ?? 15) * 60000,
  );
  if (cancelled) throw new Error('Cancelled');
  send('result', {
    output: response?.data.content ?? '',
    sessionId: session.sessionId,
    runtime: status.version,
  });
}
void main()
  .catch((error) => send('error', { message: (error as Error).message }))
  .finally(async () => {
    await session?.disconnect().catch(() => {});
    await client.stop().catch(() => {});
    parentPort?.close();
  });
