import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { safeEnvironment, safePath } from './policy';
import { trustedExecutable } from './executables';
const exec = promisify(execFile);
export type GraphState = { state: string; detail?: string; nodes?: number; updatedAt?: string };
export class Graphify {
  private jobs = new Map<string, Promise<GraphState>>();
  private installation?: Promise<void>;
  private abort = new AbortController();
  stop() {
    this.abort.abort();
  }
  constructor(
    private dataDir: string,
    private changed: (workspaceId: string, state: GraphState) => void,
  ) {}
  async inspect(root: string): Promise<GraphState> {
    try {
      const path = await safePath(root, 'graphify-out/graph.json');
      if ((await stat(path)).size > 64 * 1024 * 1024)
        throw new Error('Graph exceeds the 64 MB indexing limit. Narrow the project graph.');
      const graph = JSON.parse(await readFile(path, 'utf8'));
      if (
        !Array.isArray(graph.nodes) ||
        (!Array.isArray(graph.links) && !Array.isArray(graph.edges))
      )
        throw new Error('Invalid graph schema');
      return {
        state: 'ready',
        nodes: graph.nodes.length,
        detail: 'Existing project graph',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      return {
        state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid',
        detail: (e as Error).message,
      };
    }
  }
  ensure(workspaceId: string, root: string, rebuild = false): Promise<GraphState> {
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (this.jobs.has(key)) return this.jobs.get(key)!;
    const job = this.build(workspaceId, root, rebuild).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return job;
  }
  private async build(workspaceId: string, root: string, rebuild: boolean): Promise<GraphState> {
    const update = (state: GraphState) => {
      this.changed(workspaceId, state);
      return state;
    };
    const current = await this.inspect(root);
    if (current.state === 'ready' && !rebuild) return update(current);
    if (current.state === 'invalid' && !rebuild)
      return update({
        ...current,
        detail: 'Graph is invalid. Review it and use Rebuild to replace it.',
      });
    try {
      await safePath(root, 'graphify-out/graph.json', true);
      update({ state: 'checking', detail: 'Checking Graphify installation' });
      const options = {
        signal: this.abort.signal,
        cwd: root,
        windowsHide: true,
        env: safeEnvironment(),
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      };
      let executable = '';
      try {
        executable = await trustedExecutable('graphify');
        await exec(executable, ['--help'], options);
      } catch {
        const venv = join(this.dataDir, 'tools', 'graphify');
        await mkdir(join(this.dataDir, 'tools'), { recursive: true });
        const python = join(
          venv,
          process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
        );
        executable = join(
          venv,
          process.platform === 'win32' ? 'Scripts/graphify.exe' : 'bin/graphify',
        );
        try {
          await exec(executable, ['--help'], options);
        } catch {
          update({
            state: 'installing',
            detail:
              'Installing Graphify in an isolated application environment; Python 3.10+ is required',
          });
          const install = (this.installation ??= (async () => {
            const installOptions = { ...options, cwd: join(this.dataDir, 'tools') };
            await exec(
              await trustedExecutable(process.platform === 'win32' ? 'python' : 'python3'),
              ['-I', '-m', 'venv', venv],
              installOptions,
            );
            await exec(python, ['-I', '-m', 'pip', 'install', 'graphifyy==0.9.76'], {
              ...installOptions,
              timeout: 600000,
            });
          })());
          try {
            await install;
          } finally {
            if (this.installation === install) this.installation = undefined;
          }
        }
      }
      update({
        state: 'building',
        detail: 'Indexing this project locally (code only; no inference credentials)',
      });
      await exec(
        executable,
        [
          'extract',
          root,
          '--code-only',
          '--no-cluster',
          '--max-workers',
          '2',
          ...(rebuild ? ['--force'] : []),
        ],
        { ...options, timeout: 600000, maxBuffer: 8 * 1024 * 1024 },
      );
      const result = await this.inspect(root);
      if (result.state !== 'ready')
        throw new Error(
          'Graphify did not produce a valid graph; this project may contain no supported code.',
        );
      return update({
        ...result,
        detail: 'Local code graph ready. Documentation/media semantic extraction is not enabled.',
      });
    } catch (e) {
      return update({ state: 'failed', detail: String((e as Error).message).slice(0, 1500) });
    }
  }
}
export async function queryGraph(root: string, query: string) {
  const path = await safePath(root, 'graphify-out/graph.json');
  if ((await stat(path)).size > 64 * 1024 * 1024)
    throw new Error('Graph exceeds the query size limit');
  const graph = JSON.parse(await readFile(path, 'utf8'));
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const nodes = graph.nodes as Record<string, unknown>[];
  const ranked = nodes
    .map((n) => ({
      n,
      score: words.reduce(
        (sum, w) => sum + (JSON.stringify(n).toLowerCase().includes(w) ? 1 : 0),
        0,
      ),
    }))
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((x) => x.n);
  const ids = new Set(ranked.map((n) => n.id));
  const edges = (graph.links ?? graph.edges) as { source: string; target: string }[];
  return JSON.stringify({
    nodes: ranked,
    edges: edges.filter((e) => ids.has(e.source) || ids.has(e.target)).slice(0, 50),
    note: 'Graph is a routing aid. Verify current source; graph may be stale.',
  }).slice(0, 24000);
}
