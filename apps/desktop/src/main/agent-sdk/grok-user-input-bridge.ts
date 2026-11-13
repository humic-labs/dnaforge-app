import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

import type { AgentUserInputQuestion } from '../../shared/agent-confirm-types';
import type { RequestAgentUserInput } from './agent-user-input-adapters';

const HANDOFF_SCHEMA = 'dnaforge.grok-user-input-handoff/v1';
const BRIDGE_TOOL_NAME = 'request_user_input';
const BRIDGE_SERVER_NAME = 'dnaforge';
const ROUTED_BRIDGE_TOOL_NAME = `${BRIDGE_SERVER_NAME}__${BRIDGE_TOOL_NAME}`;

export interface GrokToolIdentity {
  name: string;
  mcpServer?: string;
}

export interface GrokUserInputHandoff {
  path: string;
  token: string;
}

interface GrokRoutedToolInput extends Record<string, unknown> {
  questions: unknown[];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toolIdentity(name: string | null | undefined): GrokToolIdentity {
  const value = name?.trim() || 'tool';
  const match = /^(?:mcp__)?([^_]+)__(.+)$/u.exec(value);
  return match ? { mcpServer: match[1], name: match[2] } : { name: value };
}

export function resolveGrokToolIdentity(
  call: { name?: string | null; rawInput?: unknown },
  observed?: GrokToolIdentity
): GrokToolIdentity | null {
  const direct = call.name?.trim() ? toolIdentity(call.name) : null;
  if (direct?.mcpServer) return direct;
  const raw = call.rawInput;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const route = raw as Record<string, unknown>;
    if (
      route.variant === 'UseTool' &&
      nonEmptyString(route.tool_name) &&
      route.tool_input &&
      typeof route.tool_input === 'object' &&
      !Array.isArray(route.tool_input)
    ) {
      const routed = toolIdentity(route.tool_name);
      if (
        routed.mcpServer &&
        (!direct ||
          direct.name === routed.name ||
          direct.name === 'MCPTool' ||
          direct.name === 'UseTool' ||
          direct.name === 'use_tool')
      )
        return routed;
    }
  }
  if (observed?.mcpServer && (!direct || direct.name === observed.name)) return observed;
  return direct ?? observed ?? null;
}

export function grokCanonicalToolInput(call: {
  name?: string | null;
  rawInput?: unknown;
}): unknown {
  const identity = resolveGrokToolIdentity(call);
  const raw = call.rawInput;
  if (identity?.mcpServer && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const route = raw as Record<string, unknown>;
    const routed = nonEmptyString(route.tool_name) ? toolIdentity(route.tool_name) : null;
    if (
      route.variant === 'UseTool' &&
      routed?.mcpServer === identity.mcpServer &&
      routed.name === identity.name &&
      route.tool_input &&
      typeof route.tool_input === 'object' &&
      !Array.isArray(route.tool_input)
    )
      return route.tool_input;
  }
  return raw;
}

function exactBridgeIdentity(identity: GrokToolIdentity): boolean {
  return identity.mcpServer === BRIDGE_SERVER_NAME && identity.name === BRIDGE_TOOL_NAME;
}

function routedToolInput(rawInput: unknown): GrokRoutedToolInput | null {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
  const route = rawInput as Record<string, unknown>;
  if (
    route.variant !== 'UseTool' ||
    route.tool_name !== ROUTED_BRIDGE_TOOL_NAME ||
    !route.tool_input ||
    typeof route.tool_input !== 'object' ||
    Array.isArray(route.tool_input)
  ) {
    return null;
  }
  const input = route.tool_input as Record<string, unknown>;
  return Array.isArray(input.questions) ? { ...input, questions: input.questions } : null;
}

function parseQuestion(value: unknown): AgentUserInputQuestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const question = value as Record<string, unknown>;
  if (
    !nonEmptyString(question.id) ||
    question.id.length > 64 ||
    !nonEmptyString(question.header) ||
    question.header.length > 64 ||
    !nonEmptyString(question.question) ||
    question.question.length > 1_000 ||
    (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') ||
    !Array.isArray(question.options) ||
    question.options.length < 2 ||
    question.options.length > 4
  ) {
    return null;
  }
  const options: AgentUserInputQuestion['options'] = [];
  const labels = new Set<string>();
  for (const valueOption of question.options) {
    if (!valueOption || typeof valueOption !== 'object' || Array.isArray(valueOption)) return null;
    const option = valueOption as Record<string, unknown>;
    if (
      !nonEmptyString(option.label) ||
      option.label.length > 80 ||
      typeof option.description !== 'string' ||
      option.description.length > 400 ||
      labels.has(option.label)
    ) {
      return null;
    }
    labels.add(option.label);
    options.push({ id: option.label, label: option.label, description: option.description });
  }
  return {
    id: question.id,
    header: question.header,
    prompt: question.question,
    options,
    multiSelect: question.multiSelect === true,
    allowFreeText: false,
  };
}

function bridgeInputForPermission(
  params: RequestPermissionRequest,
  observedToolCalls: ReadonlyMap<string, GrokToolIdentity>
): { arguments: GrokRoutedToolInput; questions: AgentUserInputQuestion[] } | null {
  const identity = resolveGrokToolIdentity(
    params.toolCall,
    observedToolCalls.get(params.toolCall.toolCallId)
  );
  if (identity && !exactBridgeIdentity(identity)) return null;
  const argumentsValue = routedToolInput(params.toolCall.rawInput);
  if (
    !argumentsValue ||
    argumentsValue.questions.length < 1 ||
    argumentsValue.questions.length > 3
  ) {
    return null;
  }
  const questions: AgentUserInputQuestion[] = [];
  const ids = new Set<string>();
  for (const value of argumentsValue.questions) {
    const question = parseQuestion(value);
    if (!question || ids.has(question.id)) return null;
    ids.add(question.id);
    questions.push(question);
  }
  return { arguments: argumentsValue, questions };
}

export function createGrokUserInputHandoff(runtimeRoot: string): GrokUserInputHandoff {
  const nonce = randomBytes(24).toString('hex');
  const path = join(runtimeRoot, 'user-input', `${nonce}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return { path, token: randomBytes(32).toString('hex') };
}

export function discardGrokUserInputHandoff(handoff: GrokUserInputHandoff): void {
  rmSync(handoff.path, { force: true });
}

export function answerGrokDnaForgeMcpPermission(input: {
  params: RequestPermissionRequest;
  observedToolCalls: ReadonlyMap<string, GrokToolIdentity>;
}): RequestPermissionResponse | null {
  const identity = resolveGrokToolIdentity(
    input.params.toolCall,
    input.observedToolCalls.get(input.params.toolCall.toolCallId)
  );
  if (!identity || identity.mcpServer !== BRIDGE_SERVER_NAME) return null;
  if (identity.name === BRIDGE_TOOL_NAME) return null;
  const allowOnce = input.params.options.find((option) => option.kind === 'allow_once');
  return allowOnce ? { outcome: { outcome: 'selected', optionId: allowOnce.optionId } } : null;
}

export async function answerGrokMcpUserInputPermission(input: {
  params: RequestPermissionRequest;
  observedToolCalls: ReadonlyMap<string, GrokToolIdentity>;
  handoff: GrokUserInputHandoff;
  conversationId: string | null;
  signal: AbortSignal;
  requestUserInput: RequestAgentUserInput;
}): Promise<RequestPermissionResponse | null> {
  const bridgeInput = bridgeInputForPermission(input.params, input.observedToolCalls);
  if (!bridgeInput) return null;
  const allowOnce = input.params.options.find((option) => option.kind === 'allow_once');
  if (!allowOnce) return null;
  const response = await input.requestUserInput(
    {
      provider: 'grok-acp',
      conversationId: input.conversationId,
      questions: bridgeInput.questions,
    },
    input.signal
  );
  const temporaryPath = `${input.handoff.path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      JSON.stringify({
        schema: HANDOFF_SCHEMA,
        token: input.handoff.token,
        arguments: bridgeInput.arguments,
        response,
      }),
      { encoding: 'utf8', mode: 0o600 }
    );
    renameSync(temporaryPath, input.handoff.path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
}
