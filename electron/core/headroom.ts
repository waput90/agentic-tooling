import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { HeadroomConfig, HeadroomStatus } from '../../src/shared';

// The compression-only HTTP contract is also used by Headroom's TypeScript SDK.
// Never point the Copilot runtime or its credentials at this endpoint.
export function headroomUrl(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Headroom requires a local base URL such as http://127.0.0.1:8787 (no path or credentials).',
    );
  // Avoid DNS or proxy environment variables redirecting localhost requests.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}

const responseSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.string(),
        content: z.unknown(),
        tool_call_id: z.string().optional(),
      }),
    )
    .max(10),
  tokens_before: z.number().finite().nonnegative(),
  tokens_after: z.number().finite().nonnegative(),
  ccr_hashes: z.array(z.string()).optional(),
});

async function request(baseUrl: string, body: unknown, timeoutMs: number, signal?: AbortSignal) {
  const response = await fetch(`${headroomUrl(baseUrl)}/v1/compress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Headroom returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Headroom returned no response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('Headroom response exceeds 1 MB');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export async function checkHeadroom(baseUrl: string): Promise<HeadroomStatus> {
  const normalized = headroomUrl(baseUrl);
  try {
    const content = 'Agentic Tooling Headroom connection check.';
    const result = await request(
      normalized,
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content }],
        config: { compress_user_messages: false },
      },
      3000,
    );
    if (result.messages.length !== 1 || result.messages[0].content !== content)
      throw new Error('Unexpected probe response');
    return {
      state: 'available',
      baseUrl: normalized,
      detail: 'Local compression API is available. No repository content was sent by this check.',
    };
  } catch {
    return {
      state: 'unavailable',
      baseUrl: normalized,
      detail:
        'Headroom compression API is unavailable or incompatible. Start the local Headroom proxy and check again.',
    };
  }
}

export type CompressionObservation = {
  tool: string;
  state: 'compressed' | 'unchanged' | 'fallback';
  tokensBefore?: number;
  tokensAfter?: number;
  detail?: string;
};
export class Headroom {
  private unavailable = false;
  constructor(
    private config: HeadroomConfig | undefined,
    private report: (observation: CompressionObservation) => void,
    private signal?: AbortSignal,
  ) {}
  async compress(tool: string, content: string, model: string, raw = false) {
    if (
      !this.config?.enabled ||
      raw ||
      this.unavailable ||
      content.length < this.config.minCharacters
    )
      return content;
    try {
      const callId = randomUUID();
      const result = await request(
        this.config.baseUrl,
        {
          model,
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: callId, type: 'function', function: { name: tool, arguments: '{}' } },
              ],
            },
            { role: 'tool', tool_call_id: callId, content },
          ],
          // Marker-free, stateless compression: no shared conversation or CCR retrieval store.
          config: { protect_recent: 0, compress_user_messages: false },
        },
        this.config.timeoutMs,
        this.signal,
      );
      const matches = result.messages.filter((m) => m.role === 'tool' && m.tool_call_id === callId);
      const compressed = matches[0]?.content;
      if (
        matches.length !== 1 ||
        typeof compressed !== 'string' ||
        !compressed.trim() ||
        result.ccr_hashes?.length ||
        /<<ccr:|Retrieve (?:more|original): hash=/.test(compressed)
      )
        throw new Error('Unexpected compression response');
      const header =
        '[Headroom-compressed tool result. Call this read tool again with raw=true for the original bounded result.]\n';
      const smaller =
        compressed !== content &&
        compressed.length + header.length < content.length &&
        result.tokens_after < result.tokens_before;
      this.report({
        tool,
        state: smaller ? 'compressed' : 'unchanged',
        tokensBefore: result.tokens_before,
        tokensAfter: result.tokens_after,
      });
      return smaller ? header + compressed : content;
    } catch {
      this.signal?.throwIfAborted();
      // One failed request is enough: avoid slowing every tool call in this attempt.
      this.unavailable = true;
      this.report({
        tool,
        state: 'fallback',
        detail:
          'Headroom unavailable or invalid response; original tool result used for this attempt.',
      });
      return content;
    }
  }
}
