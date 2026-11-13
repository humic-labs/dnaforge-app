const APP_SESSION_STORAGE_KEY = 'dnaforge_telemetry_app_session_id';
const EPISODE_CORRELATION_STORAGE_KEY = 'dnaforge_telemetry_episode_correlation_id';
export const TELEMETRY_EPISODE_STARTED_EVENT = 'dnaforge:rl-episode-started';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TelemetryCorrelationContext = {
  readonly appSessionId: string;
  readonly episodeCorrelationId: string;
};

let correlationRevision = 0;
let correlationContext: TelemetryCorrelationContext | null = null;

export function getTelemetryCorrelationContext(): TelemetryCorrelationContext {
  if (correlationContext) return correlationContext;
  const appSessionId = getOrCreateSessionUuid(APP_SESSION_STORAGE_KEY);
  const episodeCorrelationId = getOrCreateSessionUuid(
    EPISODE_CORRELATION_STORAGE_KEY,
    appSessionId
  );
  correlationContext = { appSessionId, episodeCorrelationId };
  correlationRevision += 1;
  return correlationContext;
}

export function getTelemetryCorrelationRevision(): number {
  getTelemetryCorrelationContext();
  return correlationRevision;
}

export function setEpisodeCorrelationId(episodeCorrelationId: string): void {
  if (!UUID_RE.test(episodeCorrelationId)) {
    throw new Error('episodeCorrelationId must be a UUID');
  }
  const current = getTelemetryCorrelationContext();
  const normalizedEpisodeId = episodeCorrelationId.toLowerCase();
  if (current.episodeCorrelationId === normalizedEpisodeId) return;
  correlationContext = {
    ...current,
    episodeCorrelationId: normalizedEpisodeId,
  };
  correlationRevision += 1;
  writeSessionValue(EPISODE_CORRELATION_STORAGE_KEY, correlationContext.episodeCorrelationId);
}

export function beginTelemetryEpisode(): string {
  const episodeCorrelationId = createUuid();
  setEpisodeCorrelationId(episodeCorrelationId);
  return episodeCorrelationId;
}

export function installTelemetryEpisodeCorrelationBridge(target: Window = window): () => void {
  const handleEpisodeStarted = (event: Event): void => {
    const episodeCorrelationId = (event as CustomEvent<{ episodeCorrelationId?: unknown }>).detail
      ?.episodeCorrelationId;
    if (typeof episodeCorrelationId !== 'string') return;
    setEpisodeCorrelationId(episodeCorrelationId);
  };
  target.addEventListener(TELEMETRY_EPISODE_STARTED_EVENT, handleEpisodeStarted);
  return () => target.removeEventListener(TELEMETRY_EPISODE_STARTED_EVENT, handleEpisodeStarted);
}

export function __resetTelemetryCorrelationForTests(): void {
  correlationContext = null;
  correlationRevision += 1;
}

function getOrCreateSessionUuid(key: string, fallback?: string): string {
  try {
    const stored = sessionStorage.getItem(key);
    if (stored && UUID_RE.test(stored)) return stored.toLowerCase();
    const created = fallback ?? createUuid();
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return fallback ?? createUuid();
  }
}

function writeSessionValue(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {}
}

function createUuid(): string {
  return crypto.randomUUID();
}
