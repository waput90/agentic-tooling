import type { McpDirectoryEntry, McpDirectoryResult } from '../../src/shared';

const registryUrl = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const maxResponseBytes = 1_000_000;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown, max: number) =>
  typeof value === 'string' ? value.slice(0, max) : '';

function supportedRemote(value: unknown): McpDirectoryEntry['remote'] {
  const remote = record(value);
  if (remote.type !== 'streamable-http' && remote.type !== 'sse') return;
  if (Array.isArray(remote.headers) && remote.headers.length) return;
  if (remote.variables && Object.keys(record(remote.variables)).length) return;
  const endpoint = string(remote.url, 2001);
  if (!endpoint || endpoint.length > 2000 || endpoint.includes('{')) return;
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    return { transport: remote.type === 'sse' ? 'sse' : 'http', endpoint: url.href };
  } catch {
    return;
  }
}

export function parseMcpDirectory(value: unknown): McpDirectoryResult {
  const response = record(value);
  if (!Array.isArray(response.servers)) throw new Error('MCP directory returned invalid data.');
  const entries: McpDirectoryEntry[] = [];
  for (const item of response.servers.slice(0, 20)) {
    const row = record(item);
    const server = record(row.server);
    const metadata = record(record(row._meta)['io.modelcontextprotocol.registry/official']);
    const name = string(server.name, 200);
    if (!name || metadata.status === 'deleted') continue;
    const remotes = Array.isArray(server.remotes) ? server.remotes : [];
    entries.push({
      name,
      title: string(server.title, 100) || name,
      description: string(server.description, 300),
      version: string(server.version, 100),
      status: metadata.status === 'deprecated' ? 'deprecated' : 'active',
      remote: remotes.map(supportedRemote).find(Boolean),
      hasPackage: Array.isArray(server.packages) && server.packages.length > 0,
    });
  }
  const cursor = record(response.metadata).nextCursor;
  return { entries, nextCursor: typeof cursor === 'string' && cursor.length <= 500 ? cursor : undefined };
}

export async function searchMcpDirectory(
  query: string,
  cursor?: string,
  request: typeof fetch = fetch,
): Promise<McpDirectoryResult> {
  const search = query.trim();
  if (search && [...search].length < 3)
    throw new Error('Enter at least three characters to search the public MCP directory.');
  const url = new URL(registryUrl);
  url.searchParams.set('limit', '20');
  url.searchParams.set('version', 'latest');
  if (search) url.searchParams.set('search', search);
  if (cursor) url.searchParams.set('cursor', cursor);
  let response: Response;
  try {
    response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  } catch {
    throw new Error('The public MCP directory is unavailable. Try again later or add a connection manually.');
  }
  if (!response.ok)
    throw new Error(`The public MCP directory returned HTTP ${response.status}. Try again later or add a connection manually.`);
  if (Number(response.headers.get('content-length') ?? 0) > maxResponseBytes)
    throw new Error('The public MCP directory response was too large.');
  if (!response.body) throw new Error('The public MCP directory returned no data.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxResponseBytes) {
      await reader.cancel();
      throw new Error('The public MCP directory response was too large.');
    }
    content += decoder.decode(value, { stream: true });
  }
  content += decoder.decode();
  try {
    return parseMcpDirectory(JSON.parse(content));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The public MCP directory returned invalid JSON.');
    throw error;
  }
}
