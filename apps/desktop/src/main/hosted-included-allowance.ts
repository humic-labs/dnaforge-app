import {
  parseIncludedAllowanceReadResult,
  type IncludedAllowanceReadResult,
} from '@waypoint/hosted-ai-contract/included-allowance';

interface AllowanceSession {
  readonly accountId: string;
  readonly desktopSessionId: string;
  readonly accessToken: string;
}

export async function readHostedIncludedAllowance(deps: {
  readonly getSession: () => Promise<AllowanceSession | null>;
  readonly gateway: URL | null;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
}): Promise<IncludedAllowanceReadResult> {
  if (!deps.gateway) return { status: 'unavailable', code: 'not_configured' };
  let session: AllowanceSession | null;
  try {
    session = await deps.getSession();
  } catch {
    return { status: 'unavailable', code: 'read_unavailable' };
  }
  if (!session) return { status: 'unavailable', code: 'signed_out' };
  let result: IncludedAllowanceReadResult;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const request: RequestInit & { cache: 'no-store' } = {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' },
      signal: controller.signal,
    };
    const response = await deps.fetch(
      new URL('/v1/hosted/included-allowance', deps.gateway),
      request
    );
    const parsed = response.ok
      ? parseIncludedAllowanceReadResult(await response.json(), session)
      : undefined;
    result = parsed ?? { status: 'unavailable', code: 'read_unavailable' };
  } catch {
    result = { status: 'unavailable', code: 'read_unavailable' };
  } finally {
    clearTimeout(timeout);
  }
  let active: AllowanceSession | null;
  try {
    active = await deps.getSession();
  } catch {
    return { status: 'unavailable', code: 'read_unavailable' };
  }
  if (
    !active ||
    active.accountId !== session.accountId ||
    active.desktopSessionId !== session.desktopSessionId
  )
    return { status: 'unavailable', code: 'session_changed' };
  const now = (deps.now ?? Date.now)();
  if (
    result.status === 'observed' &&
    (result.observedAt < now - 60_000 ||
      result.observedAt > now + 5_000 ||
      now >= Date.parse(`${result.periodEnd}T00:00:00.000Z`))
  )
    return { status: 'unavailable', code: 'invalid_observation' };
  return result;
}
