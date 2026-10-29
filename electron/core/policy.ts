import { createHash } from 'node:crypto';
import { realpath, lstat } from 'node:fs/promises';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import type { Task } from '../../src/shared';
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function approvedAppTool(
  request: { kind: string; toolName?: string },
  allowed: readonly string[],
  planning: boolean,
) {
  if (request.kind !== 'custom-tool' || !request.toolName?.startsWith('agentic_')) return false;
  const name = request.toolName.slice('agentic_'.length);
  return (
    allowed.includes(name) &&
    (!planning || ['read_file', 'list_files', 'graph_query'].includes(name))
  );
}
export function validateDag(tasks: Task[]) {
  const nodes = new Map(tasks.map((t) => [t.id, t]));
  if (nodes.size !== tasks.length) throw new Error('Duplicate task IDs');
  const visited = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error('Workflow contains a cycle');
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new Error(`Missing prerequisite ${id}`);
    active.add(id);
    node.dependsOn.forEach(visit);
    active.delete(id);
    visited.add(id);
  };
  tasks.forEach((t) => visit(t.id));
}
export function prerequisiteOrder(tasks: Task[], taskId: string): string[] {
  validateDag(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ordered: string[] = [],
    seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
    if (id !== taskId) ordered.push(id);
  };
  if (!byId.has(taskId)) throw new Error('Task not found');
  visit(taskId);
  return ordered;
}
export function contained(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export async function safePath(root: string, path: string, write = false) {
  const canonical = await realpath(root),
    target = resolve(canonical, path);
  if (!contained(canonical, target)) throw new Error('Path is outside approved workspace');
  const parts = relative(canonical, target).split(/[\\/]/);
  if (
    parts.some(
      (p) =>
        ['.git', '.env', '.ssh'].includes(p.toLowerCase()) ||
        p.toLowerCase().startsWith('.env.') ||
        p.includes(':') ||
        /[. ]$/.test(p),
    )
  )
    throw new Error('Protected path');
  let probe = target;
  while (true) {
    try {
      await lstat(probe);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (!write) throw e;
      const parent = dirname(probe);
      if (parent === probe) throw e;
      probe = parent;
    }
  }
  if (!contained(canonical, await realpath(probe)))
    throw new Error('Symlink leaves approved workspace');
  return target;
}
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let s = value
      .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
      .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED]');
    for (const secret of secrets.filter(Boolean)) s = s.split(secret).join('[REDACTED]');
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /token|password|secret|authorization|cookie|api.?key/i.test(k) &&
        !/tokens|secretRef|secretName/i.test(k)
          ? '[REDACTED]'
          : redact(v, secrets),
      ]),
    );
  return value;
}
export function safeEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'PROGRAMFILES',
    'ProgramFiles',
    'LANG',
    'LC_ALL',
  ];
  return Object.fromEntries(
    keys.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]]])),
  );
}
