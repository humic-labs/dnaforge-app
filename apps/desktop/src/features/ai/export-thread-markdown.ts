import type { DBEntityReference } from '../../db/entity-references';
import { redactSensitive } from '../../shared/redact-sensitive';
import { decodeAgentActivityMessage } from './agent-activity-message';
import type { ConversationSummary } from './orchestration/chat-store-types';
import type { ChatMessage } from './orchestration/chat-types';
import { extractMessageReferences } from './references/extract-message-references';
import { isChatVisibleAgentTraceEvent } from './trace-display';

export interface ThreadMarkdownExportInput {
  conversation: ConversationSummary;
  messages: readonly ChatMessage[];
  referencesByMessageId?: ReadonlyMap<string, readonly DBEntityReference[]>;
  timeZone?: string;
}

type ToolStatus = 'requested' | 'running' | 'completed' | 'failed';

interface RetainedToolCall {
  key: string;
  firstMessageIndex: number;
  name: string;
  status: ToolStatus;
  input?: unknown;
  output?: unknown;
}

interface MaterializedToolContent {
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

interface ExplicitNameMatch {
  index: number;
  name: string;
}

const SECRET_FIELD_PATTERN =
  /^(?:authorization|api[-_]?key|access[-_]?token|token|secret|password|passwd|bearer|session(?:id)?)$/i;

const EXECUTION_ENVELOPE_KEYS = new Set([
  'actionId',
  'action_id',
  'audit_id',
  'error',
  'jobId',
  'job_id',
  'ok',
  'pool',
  'renderer_audit_id',
  'result',
  'status',
  'toolName',
  'tool_name',
]);

const EXECUTION_IDENTITY_KEYS = [
  'actionId',
  'action_id',
  'audit_id',
  'jobId',
  'job_id',
  'renderer_audit_id',
  'toolName',
  'tool_name',
] as const;

const MAX_TOOL_OUTPUT_ENVELOPE_DEPTH = 6;

const MCP_CONTENT_ENVELOPE_KEYS = new Set([
  '_meta',
  'content',
  'isError',
  'structuredContent',
  'structured_content',
]);

const MAX_INLINE_TOOL_ARGUMENTS_LENGTH = 160;
const INLINE_ARGUMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const INLINE_ARGUMENT_TOKEN_PATTERN = /^[A-Za-z0-9._/@:+-]+$/;
const JSON_LIKE_INLINE_STRING_PATTERN =
  /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
const TEXT_ATTACHMENT_SECTION = '\n\nAttached files:\n--- File:';
const FILE_ONLY_PROMPT_PATTERN = /^Please analyze the following (?:file|files):\n\n--- File:/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeStructuredValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_FIELD_PATTERN.test(key) ? '[redacted]' : sanitizeStructuredValue(entry),
      ])
    );
  }
  return typeof value === 'string' ? redactSensitive(value) : value;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isExecutionEnvelope(value: Record<string, unknown>): boolean {
  if (!hasOwn(value, 'result') && !hasOwn(value, 'error')) return false;
  if (!Object.keys(value).every((key) => EXECUTION_ENVELOPE_KEYS.has(key))) return false;
  if (EXECUTION_IDENTITY_KEYS.some((key) => hasOwn(value, key))) return true;
  return typeof value.ok === 'boolean';
}

function extractSingleMcpText(value: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value.content) || value.content.length !== 1) return undefined;
  const [part] = value.content;
  return isRecord(part) && part.type === 'text' && typeof part.text === 'string'
    ? part.text
    : undefined;
}

function isMcpContentEnvelope(value: Record<string, unknown>): boolean {
  return (
    extractSingleMcpText(value) !== undefined &&
    Object.keys(value).every((key) => MCP_CONTENT_ENVELOPE_KEYS.has(key))
  );
}

function normalizeToolOutputEnvelope(value: unknown, depth = 0): unknown {
  if (depth >= MAX_TOOL_OUTPUT_ENVELOPE_DEPTH || !isRecord(value)) return value;

  const structuredContent = hasOwn(value, 'structured_content')
    ? value.structured_content
    : hasOwn(value, 'structuredContent')
      ? value.structuredContent
      : undefined;
  if (
    structuredContent !== undefined &&
    structuredContent !== null &&
    Object.keys(value).every((key) => MCP_CONTENT_ENVELOPE_KEYS.has(key))
  ) {
    return normalizeToolOutputEnvelope(structuredContent, depth + 1);
  }

  if (isExecutionEnvelope(value)) {
    const payload = hasOwn(value, 'result') ? value.result : value.error;
    return normalizeToolOutputEnvelope(payload, depth + 1);
  }

  const mcpText = extractSingleMcpText(value);
  if (mcpText !== undefined && isMcpContentEnvelope(value)) {
    try {
      return normalizeToolOutputEnvelope(JSON.parse(mcpText), depth + 1);
    } catch {
      return mcpText;
    }
  }

  return value;
}

function serializeRetainedValue(value: unknown): { content: string; language?: string } {
  if (typeof value === 'string') return { content: redactSensitive(value) };
  try {
    const serialized = JSON.stringify(sanitizeStructuredValue(value), null, 2);
    return { content: serialized ?? String(value), language: 'json' };
  } catch {
    return { content: redactSensitive(String(value)) };
  }
}

function fenced(content: string, language?: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g)?.map((run) => run.length) ?? []));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language ?? ''}\n${content}\n${fence}`;
}

function formatInlineArgumentScalar(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  return value.length > 0 &&
    !JSON_LIKE_INLINE_STRING_PATTERN.test(value) &&
    INLINE_ARGUMENT_TOKEN_PATTERN.test(value)
    ? value
    : JSON.stringify(value);
}

function renderToolArguments(value: unknown): string | null {
  let sanitized: unknown;
  try {
    sanitized = sanitizeStructuredValue(value);
  } catch {
    const serialized = serializeRetainedValue(value);
    return `**Arguments**\n\n${fenced(serialized.content, serialized.language)}`;
  }

  if (isRecord(sanitized)) {
    const entries = Object.entries(sanitized);
    if (entries.length === 0) return null;

    const pairs = entries.flatMap(([key, entry]) => {
      const formatted = formatInlineArgumentScalar(entry);
      return INLINE_ARGUMENT_KEY_PATTERN.test(key) && formatted !== null
        ? [`${key}=${formatted}`]
        : [];
    });
    if (pairs.length === entries.length) {
      const inline = `**Arguments:** ${pairs.join(', ')}`;
      if (inline.length <= MAX_INLINE_TOOL_ARGUMENTS_LENGTH) return inline;
    }
  }

  const serialized = serializeRetainedValue(sanitized);
  return `**Arguments**\n\n${fenced(serialized.content, serialized.language)}`;
}

function parseMaterializedTool(content: string): MaterializedToolContent {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return { output: parsed };
    return {
      ...(Object.prototype.hasOwnProperty.call(parsed, 'input') ? { input: parsed.input } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed, 'output') ? { output: parsed.output } : {}),
      ...(typeof parsed.isError === 'boolean' ? { isError: parsed.isError } : {}),
    };
  } catch {
    return { output: content };
  }
}

function collectRetainedToolCalls(messages: readonly ChatMessage[]): Map<string, RetainedToolCall> {
  const calls = new Map<string, RetainedToolCall>();

  messages.forEach((message, messageIndex) => {
    if (message.role === 'activity') {
      const event = decodeAgentActivityMessage(message.content);
      for (const toolCall of event?.toolCalls ?? []) {
        const key = `call:${toolCall.id}`;
        const existing = calls.get(key);
        calls.set(key, {
          key,
          firstMessageIndex: existing?.firstMessageIndex ?? messageIndex,
          name: toolCall.name || existing?.name || 'Unknown tool',
          status: toolCall.status,
          input: toolCall.input ?? existing?.input,
          output: toolCall.output ?? existing?.output,
        });
      }
      return;
    }

    if (message.role !== 'tool') return;
    const parsed = parseMaterializedTool(message.content);
    const key = message.toolCallId ? `call:${message.toolCallId}` : `message:${message.id}`;
    const existing = calls.get(key);
    calls.set(key, {
      key,
      firstMessageIndex: existing?.firstMessageIndex ?? messageIndex,
      name: message.toolName || existing?.name || 'Unknown tool',
      status:
        parsed.isError === true ? 'failed' : existing?.status === 'failed' ? 'failed' : 'completed',
      input: parsed.input ?? existing?.input,
      output: parsed.output ?? existing?.output,
    });
  });

  return calls;
}

function renderToolCall(call: RetainedToolCall): string {
  const lines = [`### Tool: ${call.name}`];

  if (call.input !== undefined) {
    const argumentsSection = renderToolArguments(call.input);
    if (argumentsSection) lines.push('', argumentsSection);
  }
  if (call.output !== undefined) {
    const output = serializeRetainedValue(normalizeToolOutputEnvelope(call.output));
    lines.push('', '**Result**', '', fenced(output.content, output.language));
  }
  if (call.status === 'failed') lines.push('', '**Error:** Tool failed.');
  if (call.output === undefined && (call.status === 'requested' || call.status === 'running')) {
    lines.push('', '**Incomplete:** No retained result.');
  }
  return lines.join('\n');
}

function renderActivityThinking(message: ChatMessage): string | null {
  const event = decodeAgentActivityMessage(message.content);
  if (!event || event.toolCalls?.length || !isChatVisibleAgentTraceEvent(event)) return null;

  const title = redactSensitive(event.display.title);
  const body =
    event.display.kind === 'error' ? [`**Error:** ${title}`] : [title ? `**${title}**` : ''];
  if (event.display.status && event.display.kind !== 'error') {
    body.push(redactSensitive(event.display.status));
  }
  if (event.display.text) body.push(redactSensitive(event.display.text));
  return `### Thinking\n\n${body.filter(Boolean).join('\n\n')}`;
}

function formatMessageTime(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')} ${value('timeZoneName')}`;
}

function cleanExplicitName(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+|['"`,.;:!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isClearPathOrFilename(value: string): boolean {
  const candidate = cleanExplicitName(value);
  if (!candidate || /^https?:\/\//i.test(candidate)) return false;
  if (/^(?:~|\.{1,2})?\/[A-Za-z0-9_.@%+~/-]+$/.test(candidate)) return true;
  if (/^[A-Za-z0-9_.@%+~-]+(?:\/[A-Za-z0-9_.@%+~-]+)+\/?$/.test(candidate)) return true;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(candidate);
}

function extractExplicitNames(content: string): string[] {
  const matches: ExplicitNameMatch[] = [];
  const excludedRanges: Array<[number, number]> = [];
  const pathRanges: Array<[number, number]> = [];

  const bareUrlPattern = /https?:\/\/[^\s<>)]+/gi;
  for (const match of content.matchAll(bareUrlPattern)) {
    if (match.index === undefined) continue;
    excludedRanges.push([match.index, match.index + match[0].length]);
  }

  const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  for (const match of content.matchAll(emailPattern)) {
    if (match.index === undefined) continue;
    excludedRanges.push([match.index, match.index + match[0].length]);
  }

  const attachmentPattern = /^--- File:\s*(.+?)\s*---$/gim;
  for (const match of content.matchAll(attachmentPattern)) {
    if (match.index === undefined) continue;
    matches.push({ index: match.index, name: cleanExplicitName(match[1]) });
  }

  const markdownLinkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi;
  for (const match of content.matchAll(markdownLinkPattern)) {
    if (match.index === undefined) continue;
    matches.push({ index: match.index, name: cleanExplicitName(match[1]) });
    const urlOffset = match[0].indexOf(match[2]);
    excludedRanges.push([match.index + urlOffset, match.index + urlOffset + match[2].length]);
  }

  const inlineCodePattern = /`([^`\n]+)`/g;
  for (const match of content.matchAll(inlineCodePattern)) {
    if (match.index === undefined || !isClearPathOrFilename(match[1])) continue;
    matches.push({ index: match.index, name: cleanExplicitName(match[1]) });
    const valueOffset = match[0].indexOf(match[1]);
    pathRanges.push([match.index + valueOffset, match.index + valueOffset + match[1].length]);
  }

  const pathPattern =
    /(?:^|[\s([])((?:~|\.{1,2})?\/[A-Za-z0-9_.@%+~/-]+|[A-Za-z0-9_.@%+~-]+(?:\/[A-Za-z0-9_.@%+~-]+)+\/?)/gm;
  for (const match of content.matchAll(pathPattern)) {
    if (match.index === undefined) continue;
    const offset = match[0].lastIndexOf(match[1]);
    const start = match.index + offset;
    const end = start + match[1].length;
    if (excludedRanges.some(([from, to]) => start >= from && end <= to)) continue;
    matches.push({ index: start, name: cleanExplicitName(match[1]) });
    pathRanges.push([start, end]);
  }

  const filenamePattern = /\b[A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{0,9}\b/g;
  for (const match of content.matchAll(filenamePattern)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (
      excludedRanges.some(([from, to]) => start >= from && end <= to) ||
      pathRanges.some(([from, to]) => start >= from && end <= to)
    ) {
      continue;
    }
    matches.push({ index: start, name: cleanExplicitName(match[0]) });
  }

  matches.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  return matches
    .map(({ name }) => name)
    .filter((name) => {
      if (!name) return false;
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function renderFirstMentionReferences(
  message: ChatMessage,
  referencesByMessageId: ReadonlyMap<string, readonly DBEntityReference[]>,
  seenReferences: Set<string>
): string | null {
  const candidates = [
    ...(referencesByMessageId.get(message.id) ?? []).map((reference) =>
      redactSensitive(cleanExplicitName(reference.display_label || reference.locator))
    ),
    ...extractExplicitNames(message.content).map(redactSensitive),
  ];
  const firstMentions = candidates.filter((name) => {
    if (!name) return false;
    const key = name.toLowerCase();
    if (seenReferences.has(key)) return false;
    seenReferences.add(key);
    return true;
  });
  if (firstMentions.length === 0) return null;
  return `### Entities and files\n\n${firstMentions.map((name) => `- ${name}`).join('\n')}`;
}

function collectFinalAssistantIndexes(messages: readonly ChatMessage[]): Set<number> {
  const scopes = new Map<string, number[]>();
  let legacyScope = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user') legacyScope += 1;
    const key = message.turnId ? `turn:${message.turnId}` : `legacy:${legacyScope}`;
    const indices = scopes.get(key) ?? [];
    indices.push(index);
    scopes.set(key, indices);
  });

  const finalIndexes = new Set<number>();
  for (const indices of scopes.values()) {
    const finalAssistant = [...indices]
      .reverse()
      .find((index) => messages[index]?.role === 'assistant');
    if (finalAssistant !== undefined) finalIndexes.add(finalAssistant);
  }
  return finalIndexes;
}

function stripAppendedFileContent(content: string): string {
  if (FILE_ONLY_PROMPT_PATTERN.test(content)) return '';
  const attachmentSectionIndex = content.indexOf(TEXT_ATTACHMENT_SECTION);
  return attachmentSectionIndex === -1 ? content : content.slice(0, attachmentSectionIndex);
}

export function serializeTextThreadMarkdown({
  conversation,
  messages,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
}: Omit<ThreadMarkdownExportInput, 'referencesByMessageId'>): string {
  const normalizedTitle = conversation.title.trim().replace(/\s+/g, ' ') || 'Untitled conversation';
  const title = redactSensitive(normalizedTitle);
  const finalAssistantIndexes = collectFinalAssistantIndexes(messages);
  const sections: string[] = [];

  messages.forEach((message, messageIndex) => {
    if (message.role === 'user') {
      const visibleProse = extractMessageReferences(message.content).prose;
      const content = redactSensitive(stripAppendedFileContent(visibleProse));
      sections.push(
        `## Prompt — ${formatMessageTime(message.createdAt, timeZone)}\n\n${content || '_(empty message)_'}`
      );
      return;
    }

    if (message.role === 'assistant' && finalAssistantIndexes.has(messageIndex)) {
      const content = redactSensitive(extractMessageReferences(message.content).prose);
      sections.push(
        `## Response — ${formatMessageTime(message.createdAt, timeZone)}\n\n${content || '_(empty message)_'}`
      );
    }
  });

  if (sections.length === 0) sections.push('_No retained messages._');
  return `# ${title}\n\n${sections.join('\n\n')}\n`;
}

export function serializeThreadMarkdown({
  conversation,
  messages,
  referencesByMessageId = new Map(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
}: ThreadMarkdownExportInput): string {
  const normalizedTitle = conversation.title.trim().replace(/\s+/g, ' ') || 'Untitled conversation';
  const title = redactSensitive(normalizedTitle);
  const toolCalls = collectRetainedToolCalls(messages);
  const toolsByFirstMessageIndex = new Map<number, RetainedToolCall[]>();
  for (const call of toolCalls.values()) {
    const atIndex = toolsByFirstMessageIndex.get(call.firstMessageIndex) ?? [];
    atIndex.push(call);
    toolsByFirstMessageIndex.set(call.firstMessageIndex, atIndex);
  }

  const finalAssistantIndexes = collectFinalAssistantIndexes(messages);
  const seenReferences = new Set<string>();
  const sections: string[] = [];

  messages.forEach((message, messageIndex) => {
    for (const call of toolsByFirstMessageIndex.get(messageIndex) ?? []) {
      sections.push(renderToolCall(call));
    }

    if (message.role === 'user') {
      const content = redactSensitive(message.content);
      sections.push(
        `## Prompt — ${formatMessageTime(message.createdAt, timeZone)}\n\n${content || '_(empty message)_'}`
      );
      const references = renderFirstMentionReferences(
        message,
        referencesByMessageId,
        seenReferences
      );
      if (references) sections.push(references);
      return;
    }

    if (message.role === 'assistant') {
      const content = redactSensitive(message.content);
      const heading = finalAssistantIndexes.has(messageIndex)
        ? `## Response — ${formatMessageTime(message.createdAt, timeZone)}`
        : '### Thinking';
      sections.push(`${heading}\n\n${content || '_(empty message)_'}`);
      const references = renderFirstMentionReferences(
        message,
        referencesByMessageId,
        seenReferences
      );
      if (references) sections.push(references);
      return;
    }

    if (message.role === 'activity') {
      const thinking = renderActivityThinking(message);
      if (thinking) sections.push(thinking);
    }
  });

  if (sections.length === 0) sections.push('_No retained messages._');
  return `# ${title}\n\n${sections.join('\n\n')}\n`;
}
