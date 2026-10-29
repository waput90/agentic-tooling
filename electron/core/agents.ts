import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { agentSchema, type Agent, type ResolvedAgent, type Workspace } from '../../src/shared';
import { hash, safePath } from './policy';

export async function instructions(root: string) {
  const paths = ['AGENTS.md', '.github/copilot-instructions.md'];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return;
    for (const item of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
      if (
        item.isSymbolicLink() ||
        ['.git', 'node_modules', 'dist', 'graphify-out', '.venv'].includes(item.name)
      )
        continue;
      const p = join(dir, item.name);
      if (item.isDirectory()) await walk(p, depth + 1);
      else if (
        (item.name === 'AGENTS.md' && p !== 'AGENTS.md') ||
        (p.replaceAll('\\', '/').startsWith('.github/instructions/') &&
          item.name.endsWith('.instructions.md'))
      )
        paths.push(p);
    }
  }
  await walk('', 0);
  const chunks: string[] = [];
  for (const p of [...new Set(paths)].sort())
    try {
      chunks.push(
        `## Scoped instructions: ${p}\n${await readFile(await safePath(root, p), 'utf8')}`,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  if (chunks.join('\n').length > 150000)
    throw new Error('Repository instructions exceed 150 KB; narrow the workspace.');
  return chunks.join('\n\n');
}
export async function discover(root: string) {
  const result: {
    name: string;
    role: string;
    prompt: string;
    model?: string;
    tools?: string[];
    path: string;
    hash: string;
  }[] = [];
  const dir = join(root, '.github', 'agents');
  for (const entry of (
    await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.agent.md')) continue;
    const path = await safePath(root, join('.github', 'agents', entry.name));
    const raw = await readFile(path, 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
    if (!match)
      throw new Error(
        `Invalid repository agent: ${entry.name} requires YAML frontmatter and prompt.`,
      );
    const meta = parse(match[1]);
    if (!meta || typeof meta !== 'object') throw new Error(`Invalid metadata in ${entry.name}`);
    const name = meta.name ?? entry.name.replace(/\.agent\.md$/, '');
    if (typeof name !== 'string' || !name.trim()) throw new Error(`Invalid name in ${entry.name}`);
    if (meta['mcp-servers'] || meta.hooks)
      throw new Error(`Configure MCP/hooks in application settings, not ${entry.name}`);
    const role = meta.role ?? name;
    if (result.some((a) => a.role === role))
      throw new Error(`Ambiguous repository agents for role ${role}`);
    let tools = meta.tools;
    if (typeof tools === 'string') tools = tools.split(',').map((s: string) => s.trim());
    if (
      tools !== undefined &&
      (!Array.isArray(tools) || tools.some((t: unknown) => typeof t !== 'string'))
    )
      throw new Error(`Invalid tools in ${entry.name}`);
    result.push({ name, role, prompt: match[2], model: meta.model, tools, path, hash: hash(raw) });
  }
  return result;
}
export async function resolveAgent(
  ws: Workspace,
  role: string,
  custom: Agent[],
  models: string[],
  source = 'auto',
): Promise<ResolvedAgent> {
  const profiles = await discover(ws.root),
    profile = profiles.find((a) => a.role === role);
  const instructionText = await instructions(ws.root);
  let resolved: Agent, kind: 'repository' | 'custom', path: string, contentHash: string;
  if (profile && source !== 'custom') {
    const mapping: Record<string, string> = {
      read: 'read_file',
      view: 'read_file',
      search: 'list_files',
      grep: 'list_files',
      glob: 'list_files',
      edit: 'write_file',
      execute: 'run_command',
      shell: 'run_command',
    };
    const tools = (profile.tools ?? ['read_file', 'list_files', 'graph_query']).map(
      (t) => mapping[t] ?? t,
    );
    resolved = {
      ...agentSchema.parse({
        name: profile.name,
        role,
        prompt: profile.prompt,
        model: profile.model ?? ws.model,
        tools,
      }),
      id: `repo:${role}`,
      version: 1,
    };
    kind = 'repository';
    path = profile.path;
    contentHash = profile.hash;
  } else {
    if (source === 'repository') throw new Error(`No repository agent for ${role}`);
    const matches = custom.filter((a) => a.role === role && !a.archived);
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `Ambiguous custom role ${role}`
          : `Create a custom ${role} agent or add .github/agents/${role}.agent.md`,
      );
    resolved = matches[0];
    kind = 'custom';
    path = resolved.id;
    contentHash = hash(resolved);
  }
  if (!models.includes(resolved.model))
    throw new Error(
      `Model ${resolved.model || '(unset)'} is unavailable. Refresh Copilot models and select an available model.`,
    );
  return {
    ...resolved,
    source: kind,
    sourcePath: path,
    hash: contentHash,
    instructions: instructionText,
    instructionHash: hash(instructionText),
  };
}
