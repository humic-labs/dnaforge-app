import {
  toUserMessage,
  userMessage,
  userMessageValue,
  userMessageWithValues,
  userToolLabel,
  type UserMessage,
  type UserMessageKey,
  type UserMessageValue,
} from '@waypoint/user-messages';
import type { AgentTraceToolCallShape } from './agent-runtime-ipc';

export interface PublicActionDetail {
  label: UserMessage;
  value: UserMessageValue;
}

export interface PublicToolAction {
  title: UserMessage;
  status: UserMessage;
  summary?: UserMessage;
  details: PublicActionDetail[];
  failed: boolean;
}

const inputFields: ReadonlyArray<readonly [string, UserMessageKey]> = [
  ['path', 'assistant.actionField.file'],
  ['filePath', 'assistant.actionField.file'],
  ['file_path', 'assistant.actionField.file'],
  ['filename', 'assistant.actionField.file'],
  ['command', 'assistant.actionField.command'],
  ['query', 'assistant.actionField.search'],
  ['pattern', 'assistant.actionField.search'],
  ['name', 'assistant.actionField.target'],
  ['displayName', 'assistant.actionField.target'],
  ['displayLabel', 'assistant.actionField.target'],
  ['label', 'assistant.actionField.target'],
  ['title', 'assistant.actionField.target'],
  ['description', 'assistant.actionField.description'],
  ['region', 'assistant.actionField.region'],
  ['chromosome', 'assistant.actionField.chromosome'],
  ['start', 'assistant.actionField.start'],
  ['start0', 'assistant.actionField.start'],
  ['end', 'assistant.actionField.end'],
  ['end0', 'assistant.actionField.end'],
];

const outputFields: ReadonlyArray<readonly [string, UserMessageKey]> = [
  ['count', 'assistant.actionField.results'],
  ['matchCount', 'assistant.actionField.matches'],
  ['totalCount', 'assistant.actionField.results'],
  ['featureCount', 'assistant.actionField.features'],
  ['length', 'assistant.actionField.length'],
  ['format', 'assistant.actionField.format'],
  ['name', 'assistant.actionField.name'],
  ['label', 'assistant.actionField.name'],
  ['description', 'assistant.actionField.description'],
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function publicValue(value: unknown): UserMessageValue | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  const text = String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, '[REDACTED]')
    .replace(/\b(?:sk-|claude-)[A-Za-z0-9._-]+/giu, '[REDACTED]')
    .trim();
  if (!text) return undefined;
  const approved = userMessageValue(text);
  if (approved !== text) return undefined;
  return userMessageValue(text.length > 360 ? `${text.slice(0, 360)}…` : text);
}

function appendFields(
  details: PublicActionDetail[],
  data: Record<string, unknown> | undefined,
  fields: ReadonlyArray<readonly [string, UserMessageKey]>
): void {
  if (!data) return;
  for (const [key, labelKey] of fields) {
    const value = publicValue(data[key]);
    const label = userMessage(labelKey);
    if (
      value !== undefined &&
      !details.some((detail) => detail.label === label && detail.value === value)
    )
      details.push({ label, value });
  }
}

function successfulOutputDetails(
  details: PublicActionDetail[],
  output: Record<string, unknown> | undefined
): void {
  appendFields(details, output, outputFields);
  if (!output) return;
  for (const key of ['entries', 'matches', 'results', 'features'] as const) {
    const items = output[key];
    if (!Array.isArray(items)) continue;
    if (
      !['count', 'matchCount', 'totalCount', 'featureCount'].some(
        (field) => typeof output[field] === 'number'
      )
    )
      details.push({
        label: userMessage('assistant.actionField.items'),
        value: userMessageValue(items.length),
      });
    for (const item of items.slice(0, 6)) {
      const data = record(item);
      const value = publicValue(data?.displayName ?? data?.name ?? data?.title);
      if (value !== undefined)
        details.push({ label: userMessage('assistant.actionField.name'), value });
    }
    break;
  }
}

export function presentToolAction(
  call: Pick<AgentTraceToolCallShape, 'name' | 'mcpServer' | 'status' | 'input' | 'output'>
): PublicToolAction {
  const input = record(call.input);
  const output = record(call.output);
  const failed =
    call.status === 'failed' ||
    output?.ok === false ||
    output?.isError === true ||
    Boolean(output?.error);
  const title = userToolLabel(call.name);
  const details: PublicActionDetail[] = [];
  appendFields(details, input, inputFields);
  const operation = publicValue(input?.action ?? record(input?.operation)?.kind);
  if (operation)
    details.unshift({
      label: userMessage('assistant.actionField.action'),
      value: userMessageValue(userToolLabel(operation)),
    });
  const summaryDetails = details.slice(0, 2);
  if (!failed) successfulOutputDetails(details, output);
  if (call.mcpServer && call.mcpServer !== 'dnaforge') {
    const service = userToolLabel(call.mcpServer);
    if (service !== userMessage('assistant.action'))
      details.push({
        label: userMessage('assistant.actionField.service'),
        value: userMessageValue(service),
      });
  }
  const status = userMessage(
    failed
      ? 'assistant.trace.failed'
      : call.status === 'completed'
        ? 'assistant.trace.completed'
        : call.status === 'requested'
          ? 'assistant.trace.requested'
          : 'assistant.trace.running'
  );
  const summary = failed
    ? toUserMessage(output?.error ?? output, 'assistant.failed')
    : summaryDetails.length
      ? userMessageWithValues('assistant.actionSummary', {
          detail: userMessageValue(
            summaryDetails
              .map(({ label, value }) =>
                userMessageWithValues('assistant.actionFieldValue', {
                  label: userMessageValue(label),
                  value,
                })
              )
              .join(' · ')
          ),
        })
      : undefined;
  return { title, status, summary, details: details.slice(0, 16), failed };
}

export function presentationToolNames(value: unknown): string[] {
  const candidates =
    typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  return candidates.slice(0, 16).flatMap((candidate) => {
    if (typeof candidate !== 'string') return [];
    const name = candidate.trim();
    return name.length <= 256 && userToolLabel(name) !== userMessage('assistant.action')
      ? [name]
      : [];
  });
}
