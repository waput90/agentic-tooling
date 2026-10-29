import type { Attempt, Usage } from '../../src/shared';
import { Store } from './store';
export function captureUsage(
  store: Store,
  attempt: Attempt,
  event: { id: string; type: string; timestamp: string; data: Record<string, unknown> },
) {
  if (event.type !== 'assistant.usage') return;
  const data = event.data;
  const count = (key: string) =>
    typeof data[key] === 'number' && Number.isFinite(data[key]) && Number(data[key]) >= 0
      ? Number(data[key])
      : null;
  const usage: Usage = {
    id: `${attempt.id}:${event.id}`,
    workspaceId: attempt.workspaceId,
    runId: attempt.runId,
    attemptId: attempt.id,
    taskId: attempt.taskId,
    agentId: attempt.agentId,
    sessionId: attempt.sessionId ?? attempt.id,
    model: typeof data.model === 'string' ? data.model : null,
    input: count('inputTokens'),
    output: count('outputTokens'),
    reasoning: count('reasoningTokens'),
    cacheRead: count('cacheReadTokens'),
    cacheWrite: count('cacheWriteTokens'),
    timestamp: event.timestamp,
    kind: 'delta',
    coverage:
      count('inputTokens') === null || count('outputTokens') === null ? 'partial' : 'observed',
  };
  store.put('usage', usage.id, usage, attempt.workspaceId);
  if (usage.model) attempt.reportedModel = usage.model;
  attempt.coverage =
    attempt.coverage === 'partial' ? 'partial' : (usage.coverage as Attempt['coverage']);
  store.put('attempts', attempt.id, attempt, attempt.workspaceId);
}
export function usageTotal(rows: Usage[]) {
  const deltas = rows.filter((r) => r.kind === 'delta');
  const total = (field: 'input' | 'output') =>
    deltas.some((r) => r[field] !== null)
      ? deltas.reduce((sum, r) => sum + (r[field] ?? 0), 0)
      : null;
  return {
    input: total('input'),
    output: total('output'),
    partial: deltas.length === 0 || deltas.some((r) => r.coverage !== 'observed'),
  };
}
