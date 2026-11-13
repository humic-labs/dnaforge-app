import type {
  AgentCliModelPersonality,
  AgentCliModelReasoningEffort,
  AgentTransport,
} from '../../platform';

export interface CustomCliHarnessDefinition {
  id: string;
  label: string;
  transport: AgentTransport;
  executablePath: string;
  model: string | null;
  reasoningEffort: AgentCliModelReasoningEffort | null;
  serviceTier: string | null;
  personality: AgentCliModelPersonality | null;
}

export interface CustomCliHarnessInput {
  label: string;
  transport: AgentTransport;
  executablePath: string;
}

export type CustomCliHarnessUpdate = Partial<Omit<CustomCliHarnessDefinition, 'id'>>;

const VALID_TRANSPORTS = new Set<AgentTransport>(['codex-sdk', 'claude-agent-sdk', 'grok-acp']);
const VALID_EFFORTS = new Set<AgentCliModelReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const VALID_PERSONALITIES = new Set<AgentCliModelPersonality>(['none', 'friendly', 'pragmatic']);
const CUSTOM_HARNESS_ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;

let definitions: CustomCliHarnessDefinition[] = [];

function optionalString(value: unknown, maxLength = 512): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

export function isValidCustomCliHarnessId(value: unknown): value is string {
  return typeof value === 'string' && CUSTOM_HARNESS_ID_RE.test(value);
}

export function normalizeCustomCliHarnessDefinition(
  value: unknown
): CustomCliHarnessDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isValidCustomCliHarnessId(raw.id)) return null;
  const label = optionalString(raw.label, 80);
  const executablePath = optionalString(raw.executablePath, 4096);
  if (!label || !executablePath || !VALID_TRANSPORTS.has(raw.transport as AgentTransport)) {
    return null;
  }
  const reasoningEffort =
    raw.reasoningEffort == null
      ? null
      : VALID_EFFORTS.has(raw.reasoningEffort as AgentCliModelReasoningEffort)
        ? (raw.reasoningEffort as AgentCliModelReasoningEffort)
        : null;
  const personality =
    raw.personality == null
      ? null
      : VALID_PERSONALITIES.has(raw.personality as AgentCliModelPersonality)
        ? (raw.personality as AgentCliModelPersonality)
        : null;
  return {
    id: raw.id,
    label,
    transport: raw.transport as AgentTransport,
    executablePath,
    model: optionalString(raw.model),
    reasoningEffort,
    serviceTier: optionalString(raw.serviceTier, 128),
    personality,
  };
}

export function replaceCustomCliHarnessDefinitions(
  nextDefinitions: readonly CustomCliHarnessDefinition[]
): void {
  definitions = nextDefinitions
    .map(normalizeCustomCliHarnessDefinition)
    .filter((entry): entry is CustomCliHarnessDefinition => entry !== null);
}

export function getCustomCliHarnessDefinitions(): CustomCliHarnessDefinition[] {
  return definitions.map((definition) => ({ ...definition }));
}

export function getCustomCliHarnessDefinition(
  id: string | undefined
): CustomCliHarnessDefinition | null {
  if (!id) return null;
  const definition = definitions.find((candidate) => candidate.id === id);
  return definition ? { ...definition } : null;
}

export function createCustomCliHarnessId(label: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'harness';
  const suffix =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `custom-cli-${slug}-${suffix}`;
}
