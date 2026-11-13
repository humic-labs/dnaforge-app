export interface DiscoveryCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export type DiscoveryRanker = (
  query: string,
  candidates: readonly DiscoveryCandidate[],
  signal?: AbortSignal
) => Promise<readonly string[] | null>;

export const DISCOVERY_RANK_PATH = '/external/discovery/rank';

export async function requestDiscoveryRanking(
  query: string,
  candidates: readonly DiscoveryCandidate[],
  request: (init: RequestInit) => Promise<Response>,
  signal?: AbortSignal
): Promise<readonly string[] | null> {
  signal?.throwIfAborted();
  if (!query.trim() || candidates.length === 0) return [];
  if (
    query.length > 500 ||
    candidates.length > 512 ||
    candidates.reduce((sum, c) => sum + c.name.length + c.description.length, 0) > 100_000 ||
    candidates.some((c) => c.id.length > 200 || c.name.length > 200 || c.description.length > 4000)
  )
    return null;
  const ids = new Set(candidates.map((c) => c.id));
  if (ids.size !== candidates.length) return null;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await request({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        candidates: candidates.map(({ id, name, description }) => ({ id, name, description })),
      }),
      signal: controller.signal,
    });
    signal?.throwIfAborted();
    if (!response.ok) return null;
    const body: unknown = await response.json();
    signal?.throwIfAborted();
    if (controller.signal.aborted) return null;
    if (
      !body ||
      typeof body !== 'object' ||
      !('ids' in body) ||
      !Array.isArray(body.ids) ||
      body.ids.some((id) => typeof id !== 'string' || !ids.has(id)) ||
      new Set(body.ids).size !== body.ids.length
    )
      return null;
    return body.ids as string[];
  } catch {
    signal?.throwIfAborted();
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
