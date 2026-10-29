import { z } from 'zod';

export const id = z.string().min(1).max(150);
export const toolNames = [
  'read_file',
  'list_files',
  'graph_query',
  'write_file',
  'run_command',
] as const;
export const agentSchema = z.object({
  id: id.optional(),
  name: z.string().min(1).max(100),
  role: z.string().regex(/^[\w-]+$/),
  prompt: z.string().min(1).max(50000),
  model: z.string().min(1),
  tools: z.array(z.enum(toolNames)),
  mcpIds: z.array(id).default([]),
  archived: z.boolean().default(false),
});
export type Agent = z.infer<typeof agentSchema> & { id: string; version: number };
export const taskSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(30000),
  role: z.string().min(1),
  dependsOn: z.array(id),
  source: z.enum(['auto', 'custom', 'repository']).default('auto'),
});
export type Task = z.infer<typeof taskSchema>;
export const limitsSchema = z.object({
  concurrency: z.number().int().min(1).max(8),
  maxTokens: z.number().int().min(1).max(10000000),
  timeoutMinutes: z.number().int().min(1).max(120),
});
export const workflowTemplateSchema = z.object({
  id: id.optional(),
  title: z.string().min(1).max(200),
  tasks: z.array(taskSchema).min(1).max(50),
  limits: limitsSchema,
});
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema> & { id: string };
export const mcpSchema = z.object({
  id: id.optional(),
  name: z.string().regex(/^[\w-]+$/),
  transport: z.enum(['stdio', 'http', 'sse']),
  endpoint: z.string().min(1).max(2000),
  args: z.array(z.string().max(2000)),
  tools: z.array(z.string().max(200)),
  auth: z.enum(['none', 'bearer', 'api-key', 'oauth']),
  secretName: z.string().max(100).default('Authorization'),
  enabled: z.boolean().default(false),
});
export type Mcp = z.infer<typeof mcpSchema> & {
  id: string;
  version: number;
  secretRef?: string;
  state: string;
  diagnostic?: string;
};
export type ResolvedAgent = Agent & {
  source: 'repository' | 'custom';
  sourcePath: string;
  hash: string;
  instructions: string;
  instructionHash: string;
};
export type Workspace = {
  id: string;
  name: string;
  root: string;
  commonDir: string;
  branch: string;
  model: string;
  concurrency: number;
  graph: { state: string; detail?: string; nodes?: number; updatedAt?: string };
};
export const headroomSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().max(2000).default('http://127.0.0.1:8787'),
  minCharacters: z.number().int().min(500).max(100000).default(4000),
  timeoutMs: z.number().int().min(500).max(30000).default(5000),
});
export type HeadroomConfig = z.infer<typeof headroomSchema>;
export type HeadroomStatus = {
  state: 'unchecked' | 'available' | 'unavailable';
  baseUrl: string;
  detail?: string;
};
export type Plan = {
  id: string;
  workspaceId: string;
  title: string;
  revision: number;
  base: string;
  tasks: (Task & { agent: ResolvedAgent; mcp: Mcp[] })[];
  limits: z.infer<typeof limitsSchema>;
  context: ContextItem[];
  headroom?: HeadroomConfig;
  hash: string;
  state: 'draft' | 'approved' | 'rejected' | 'stale';
  createdAt: string;
};
export type Run = {
  purpose?: 'summary';
  id: string;
  workspaceId: string;
  planId: string;
  state: string;
  mode: 'plan' | 'execute';
  createdAt: string;
  error?: string;
};
export type Attempt = {
  id: string;
  workspaceId: string;
  runId: string;
  taskId: string;
  agentId: string;
  requestedModel: string;
  reportedModel?: string;
  sessionId?: string;
  state: string;
  coverage: 'unknown' | 'partial' | 'observed';
  worktree?: string;
  output?: string;
  diff?: string;
  commit?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  context?: string;
  integrated?: boolean;
};
export type ContextItem = {
  id: string;
  text: string;
  kind: 'decision' | 'constraint' | 'handoff';
  createdAt: string;
  provenance?: string;
};
export type Usage = {
  id: string;
  workspaceId: string;
  runId: string;
  attemptId: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  model: string | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  timestamp: string;
  kind: 'delta' | 'checkpoint';
  coverage: string;
};
export type Snapshot = {
  headroom: { config: HeadroomConfig; status: HeadroomStatus };
  templates: WorkflowTemplate[];
  workspaces: Workspace[];
  agents: Agent[];
  plans: Plan[];
  runs: Run[];
  attempts: Attempt[];
  mcp: (Mcp & { workspaceId: string })[];
  context: (ContextItem & { workspaceId: string })[];
  usage: Usage[];
  settings: { globalConcurrency: number; selectedWorkspace: string; theme: 'dark' | 'light' };
  runtime: {
    state: string;
    version?: string;
    login?: string;
    error?: string;
    models: { id: string; name: string }[];
  };
  update?: { state: string; version?: string; detail?: string };
};

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('checkHeadroom'), baseUrl: z.string().url().max(2000) }),
  z.object({ type: z.literal('saveHeadroom'), config: headroomSchema }),
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('addWorkspace'), path: z.string().min(1) }),
  z.object({
    type: z.literal('workspaceSettings'),
    workspaceId: id,
    model: z.string(),
    concurrency: z.number().int().min(1).max(8),
  }),
  z.object({ type: z.literal('graphify'), workspaceId: id, rebuild: z.boolean().default(false) }),
  z.object({ type: z.literal('saveAgent'), agent: agentSchema }),
  z.object({ type: z.literal('previewAgents'), workspaceId: id }),
  z.object({
    type: z.literal('savePlan'),
    workspaceId: id,
    title: z.string().min(1),
    tasks: z.array(taskSchema).min(1).max(50),
    limits: limitsSchema,
  }),
  z.object({
    type: z.literal('approve'),
    workspaceId: id,
    planId: id,
    hash: id,
    decision: z.enum(['approve', 'reject']),
  }),
  z.object({ type: z.literal('execute'), workspaceId: id, planId: id }),
  z.object({
    type: z.literal('plan'),
    workspaceId: id,
    prompt: z.string().min(1).max(30000),
    role: z.string().default('planner'),
  }),
  z.object({
    type: z.literal('control'),
    workspaceId: id,
    runId: id,
    action: z.enum(['pause', 'resume', 'cancel']),
  }),
  z.object({ type: z.literal('stopAll') }),
  z.object({ type: z.literal('summarizeContext'), workspaceId: id }),
  z.object({ type: z.literal('draftFromPlanning'), workspaceId: id, attemptId: id }),
  z.object({ type: z.literal('storage') }),
  z.object({ type: z.literal('pruneHistory'), days: z.number().int().min(1).max(3650) }),
  z.object({ type: z.literal('integrate'), workspaceId: id, attemptId: id }),
  z.object({
    type: z.literal('saveMcp'),
    workspaceId: id,
    server: mcpSchema,
    secret: z.string().max(10000).optional(),
  }),
  z.object({
    type: z.literal('mcpAction'),
    workspaceId: id,
    serverId: id,
    action: z.enum(['test', 'authenticate', 'disconnect', 'clear']),
  }),
  z.object({
    type: z.literal('addContext'),
    workspaceId: id,
    text: z.string().min(1).max(30000),
    kind: z.enum(['decision', 'constraint', 'handoff']),
  }),
  z.object({
    type: z.literal('transferContext'),
    workspaceId: id,
    targetWorkspaceId: id,
    contextId: id,
  }),
  z.object({ type: z.literal('runtime') }),
  z.object({ type: z.literal('login') }),
  z.object({
    type: z.literal('events'),
    workspaceId: id,
    attemptId: id,
    offset: z.number().int().min(0).default(0),
  }),
  z.object({
    type: z.literal('settings'),
    globalConcurrency: z.number().int().min(1).max(16),
    selectedWorkspace: z.string(),
    theme: z.enum(['dark', 'light']),
  }),
  z.object({ type: z.literal('backup'), path: z.string().min(1) }),
  z.object({ type: z.literal('export') }),
  z.object({ type: z.literal('import'), data: z.unknown(), targetWorkspaceId: id.optional() }),
  z.object({ type: z.literal('shutdown') }),
  z.object({ type: z.literal('prepareUpdate') }),
]);
export type Command = z.infer<typeof commandSchema>;
export interface DesktopAPI {
  request<T = unknown>(command: Command): Promise<T>;
  chooseRepository(): Promise<string | null>;
  backup(): Promise<string | null>;
  restore(): Promise<boolean>;
  exportDefinitions(): Promise<boolean>;
  importDefinitions(workspaceId?: string): Promise<boolean>;
  onChange(callback: () => void): () => void;
  update(): Promise<void>;
  version(): Promise<string>;
}
declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}
