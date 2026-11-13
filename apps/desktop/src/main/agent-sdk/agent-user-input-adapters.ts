import type {
  AgentUserInputRequest,
  AgentUserInputResponse,
} from '../../shared/agent-confirm-types';
import type { CodexAppServerProtocol } from '@waypoint/codex-app-server-contract';
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
  ElicitationContentValue,
  PermissionOptionKind,
} from '@agentclientprotocol/sdk';
import {
  CreateElicitationRequest as CreateElicitationRequestGuard,
  ElicitationPropertySchema as ElicitationPropertySchemaGuard,
  MultiSelectItems as MultiSelectItemsGuard,
} from '@agentclientprotocol/sdk';
import {
  AGENT_APPROVAL_CHOICE_DESCRIPTIONS,
  AGENT_APPROVAL_CHOICE_LABELS,
  AGENT_APPROVAL_CHOICES,
  AGENT_APPROVAL_QUESTION_ID,
  approvalChoiceAllows,
  publicAgentApprovalCard,
  isAgentApprovalChoice,
  type AgentApprovalCard,
  type AgentApprovalChoice,
} from '../../shared/agent-approval';
import type { ApprovalMemory } from './approval-memory';
import {
  approvalPath,
  commandApprovalRule,
  displayApprovalCommand,
  permissionApprovalRule,
  writeApprovalRule,
  type ApprovalRoot,
} from './approval-rules';

type GrokPermissionRequest = ClientRequestParamsByMethod['session/request_permission'];
type GrokPermissionResponse = ClientRequestResponsesByMethod['session/request_permission'];
type GrokElicitationRequest = ClientRequestParamsByMethod['elicitation/create'];
type GrokElicitationResponse = ClientRequestResponsesByMethod['elicitation/create'];

type GrokElicitationProperty = Parameters<typeof ElicitationPropertySchemaGuard.isString>[0];

export type RequestAgentUserInput = (
  request: Omit<AgentUserInputRequest, 'requestId'>,
  signal?: AbortSignal
) => Promise<AgentUserInputResponse>;

interface ClaudeQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

interface ClaudeQuestion {
  question: string;
  header: string;
  options: ClaudeQuestionOption[];
  multiSelect: boolean;
}

interface ClaudeAskUserQuestionInput extends Record<string, unknown> {
  questions: ClaudeQuestion[];
}

type ClaudePermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt: boolean };

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseClaudeQuestion(value: unknown): ClaudeQuestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const question = value as Record<string, unknown>;
  if (
    !nonEmptyString(question.question) ||
    !nonEmptyString(question.header) ||
    typeof question.multiSelect !== 'boolean' ||
    !Array.isArray(question.options) ||
    question.options.length < 2 ||
    question.options.length > 4
  ) {
    return null;
  }
  const options: ClaudeQuestionOption[] = [];
  for (const valueOption of question.options) {
    if (!valueOption || typeof valueOption !== 'object' || Array.isArray(valueOption)) return null;
    const option = valueOption as Record<string, unknown>;
    if (!nonEmptyString(option.label) || typeof option.description !== 'string') return null;
    if (option.preview !== undefined && typeof option.preview !== 'string') return null;
    options.push({
      label: option.label,
      description: option.description,
      ...(option.preview ? { preview: option.preview } : {}),
    });
  }
  return {
    question: question.question,
    header: question.header,
    options,
    multiSelect: question.multiSelect,
  };
}

function parseClaudeInput(value: Record<string, unknown>): ClaudeAskUserQuestionInput | null {
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 4) {
    return null;
  }
  const questions: ClaudeQuestion[] = [];
  for (const candidate of value.questions) {
    const question = parseClaudeQuestion(candidate);
    if (!question) return null;
    questions.push(question);
  }
  return { ...value, questions };
}

function answerText(
  question: ClaudeQuestion,
  answer: AgentUserInputResponse['answers'][string]
): string | null {
  if (answer.text?.trim()) return answer.text.trim();
  const labels = answer.selectedOptionIds.map((id) => {
    const match = /^option-(\d+)$/.exec(id);
    return match ? question.options[Number(match[1])]?.label : undefined;
  });
  if (labels.some((label) => !label)) return null;
  return labels.join(', ');
}

function claudePlanText(input: Record<string, unknown>): string {
  if (nonEmptyString(input.plan)) return input.plan.trim();
  if (nonEmptyString(input.content)) return input.content.trim();
  return boundedJson(input) ?? 'Claude proposed a plan without displayable text.';
}

export async function answerClaudePlanDecision(input: {
  input: Record<string, unknown>;
  conversationId: string | null;
  signal: AbortSignal;
  requestUserInput: RequestAgentUserInput;
}): Promise<ClaudePermissionResult> {
  const response = await input.requestUserInput(
    {
      provider: 'claude-agent-sdk',
      conversationId: input.conversationId,
      questions: [
        {
          id: 'plan-decision',
          header: 'Plan',
          prompt: claudePlanText(input.input),
          options: [
            { id: 'approve', label: 'Approve', description: 'Continue with this plan.' },
            { id: 'reject', label: 'Reject', description: 'Do not execute this plan.' },
            { id: 'edit', label: 'Request edits', description: 'Send revision feedback.' },
          ],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    },
    input.signal
  );
  if (response.outcome !== 'submitted') {
    return {
      behavior: 'deny',
      message: 'The user cancelled this plan decision.',
      interrupt: true,
    };
  }
  const answer = response.answers['plan-decision'];
  const decision = answer?.selectedOptionIds[0];
  if (decision === 'approve') return { behavior: 'allow', updatedInput: input.input };
  if (decision === 'edit' || (!decision && answer?.text?.trim())) {
    const feedback = answer?.text?.trim();
    return {
      behavior: 'deny',
      message: feedback
        ? `Revise the plan before continuing: ${feedback}`
        : 'The user requested revisions but did not supply feedback.',
      interrupt: false,
    };
  }
  return { behavior: 'deny', message: 'The user rejected this plan.', interrupt: false };
}

export async function answerClaudeAskUserQuestion(input: {
  input: Record<string, unknown>;
  conversationId: string | null;
  signal: AbortSignal;
  requestUserInput: RequestAgentUserInput;
}): Promise<ClaudePermissionResult> {
  const parsed = parseClaudeInput(input.input);
  if (!parsed) {
    return {
      behavior: 'deny',
      message: 'Claude supplied a malformed AskUserQuestion request.',
      interrupt: true,
    };
  }

  const request: Omit<AgentUserInputRequest, 'requestId'> = {
    provider: 'claude-agent-sdk',
    conversationId: input.conversationId,
    questions: parsed.questions.map((question, questionIndex) => ({
      id: `question-${questionIndex}`,
      header: question.header,
      prompt: question.question,
      options: question.options.map((option, optionIndex) => ({
        id: `option-${optionIndex}`,
        ...option,
      })),
      multiSelect: question.multiSelect,
      allowFreeText: true,
    })),
  };
  const response = await input.requestUserInput(request, input.signal);
  if (response.outcome !== 'submitted') {
    return {
      behavior: 'deny',
      message: 'The user cancelled this question.',
      interrupt: true,
    };
  }

  const answers: Record<string, string> = {};
  for (const [questionIndex, question] of parsed.questions.entries()) {
    const answer = response.answers[`question-${questionIndex}`];
    const text = answer && answerText(question, answer);
    if (!text) {
      return {
        behavior: 'deny',
        message: 'DNAForge received an invalid answer for Claude.',
        interrupt: true,
      };
    }
    answers[question.question] = text;
  }
  return { behavior: 'allow', updatedInput: { ...parsed, answers } };
}

function codexOptionId(index: number): string {
  return `option-${index}`;
}

export async function answerCodexRequestUserInput(input: {
  params: CodexAppServerProtocol.v2.ToolRequestUserInputParams;
  conversationId: string | null;
  signal: AbortSignal;
  requestUserInput: RequestAgentUserInput;
  provider?: 'codex-sdk' | 'hosted-codex';
}): Promise<CodexAppServerProtocol.v2.ToolRequestUserInputResponse> {
  const response = await input.requestUserInput(
    {
      provider: input.provider ?? 'codex-sdk',
      conversationId: input.conversationId,
      questions: input.params.questions.map((question) => ({
        id: question.id,
        header: question.header,
        prompt: question.question,
        options: (question.options ?? []).map((option, index) => ({
          id: codexOptionId(index),
          label: option.label,
          description: option.description,
        })),
        multiSelect: false,
        allowFreeText: question.isOther || question.options === null,
        secret: question.isSecret,
      })),
    },
    input.signal
  );

  const answers: CodexAppServerProtocol.v2.ToolRequestUserInputResponse['answers'] = {};
  for (const question of input.params.questions) {
    const answer = response.outcome === 'submitted' ? response.answers[question.id] : undefined;
    if (answer?.text?.trim()) {
      answers[question.id] = { answers: [answer.text.trim()] };
      continue;
    }
    const selected = (answer?.selectedOptionIds ?? []).flatMap((optionId) => {
      const match = /^option-(\d+)$/.exec(optionId);
      if (!match) return [];
      const option = question.options?.[Number(match[1])];
      return option ? [option.label] : [];
    });
    answers[question.id] = { answers: selected };
  }
  return { answers };
}

export async function answerCodexMcpElicitation(input: {
  params: CodexAppServerProtocol.v2.McpServerElicitationRequestParams;
  conversationId: string | null;
  signal: AbortSignal;
  requestUserInput: RequestAgentUserInput;
  provider?: 'codex-sdk' | 'hosted-codex';
}): Promise<CodexAppServerProtocol.v2.McpServerElicitationRequestResponse> {
  if (input.params.mode !== 'form') {
    return { action: 'decline', content: null, _meta: null };
  }
  const required = new Set(input.params.requestedSchema.required ?? []);
  const fields: Array<[string, GrokFormField]> = [];
  for (const [id, schema] of Object.entries(input.params.requestedSchema.properties ?? {})) {
    if (!schema) continue;
    const field = grokFormField(
      id,
      schema as GrokElicitationProperty,
      input.params.message,
      required.has(id)
    );
    if (!field) return { action: 'decline', content: null, _meta: null };
    fields.push([id, field]);
  }
  if (fields.length === 0) return { action: 'decline', content: null, _meta: null };

  const response = await input.requestUserInput(
    {
      provider: input.provider ?? 'codex-sdk',
      conversationId: input.conversationId,
      questions: fields.map(([, field]) => field.request),
    },
    input.signal
  );
  if (response.outcome !== 'submitted') {
    return { action: 'cancel', content: null, _meta: null };
  }

  const content: Record<string, ElicitationContentValue> = {};
  for (const [id, field] of fields) {
    const result = field.parse(response.answers[id]);
    if (!result.ok) return { action: 'decline', content: null, _meta: null };
    if (result.present && result.value !== undefined) content[id] = result.value;
  }
  return { action: 'accept', content, _meta: null };
}

type CodexApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval';

type CodexApprovalParams =
  | CodexAppServerProtocol.v2.CommandExecutionRequestApprovalParams
  | CodexAppServerProtocol.v2.FileChangeRequestApprovalParams
  | CodexAppServerProtocol.v2.PermissionsRequestApprovalParams;

type CodexApprovalResponse =
  | CodexAppServerProtocol.v2.CommandExecutionRequestApprovalResponse
  | CodexAppServerProtocol.v2.FileChangeRequestApprovalResponse
  | CodexAppServerProtocol.v2.PermissionsRequestApprovalResponse
  | null;

interface ApprovalContext {
  conversationId: string | null;
  signal: AbortSignal;
  requestUserInput: RequestAgentUserInput;
  approvalMemory?: ApprovalMemory | null;
  approvalRoots?: readonly ApprovalRoot[];
}

export async function askAgentApproval(
  context: ApprovalContext & { provider: AgentUserInputRequest['provider'] },
  inputCard: AgentApprovalCard
): Promise<AgentApprovalChoice> {
  const card = publicAgentApprovalCard(inputCard);
  if (context.approvalMemory?.allows(context.conversationId, card.rule.key)) return 'once';
  const response = await context.requestUserInput(
    {
      provider: context.provider,
      conversationId: context.conversationId,
      approval: card,
      questions: [
        {
          id: AGENT_APPROVAL_QUESTION_ID,
          header: card.title,
          prompt: [card.detail, card.command].filter(nonEmptyString).join('\n') || card.title,
          options: AGENT_APPROVAL_CHOICES.map((choice) => ({
            id: choice,
            label: AGENT_APPROVAL_CHOICE_LABELS[choice],
            description: AGENT_APPROVAL_CHOICE_DESCRIPTIONS[choice],
          })),
          multiSelect: false,
          allowFreeText: false,
        },
      ],
    },
    context.signal
  );
  const selected =
    response.outcome === 'submitted'
      ? response.answers[AGENT_APPROVAL_QUESTION_ID]?.selectedOptionIds[0]
      : null;
  const choice: AgentApprovalChoice = isAgentApprovalChoice(selected)
    ? selected
    : response.outcome === 'cancelled' &&
        response.reason &&
        response.reason !== 'user_cancelled' &&
        response.reason !== 'turn_aborted'
      ? 'deny'
      : 'stop';
  context.approvalMemory?.remember(choice, context.conversationId, card.rule);
  return choice;
}

function codexDecision<Decision>(
  choice: AgentApprovalChoice,
  available: readonly Decision[]
): Decision | 'accept' | 'acceptForSession' | 'decline' | 'cancel' {
  if (choice === 'deny') return 'decline';
  if (choice === 'stop') return 'cancel';
  if (choice !== 'once' && (available as readonly unknown[]).includes('acceptForSession')) {
    return 'acceptForSession';
  }
  return 'accept';
}

export async function answerCodexServerApproval(
  input: ApprovalContext & {
    method: CodexApprovalMethod;
    params: CodexApprovalParams;
    provider?: 'codex-sdk' | 'hosted-codex';
  }
): Promise<CodexApprovalResponse> {
  const context = { ...input, provider: input.provider ?? ('codex-sdk' as const) };
  const roots = input.approvalRoots ?? [];

  if (input.method === 'item/commandExecution/requestApproval') {
    const params = input.params as CodexAppServerProtocol.v2.CommandExecutionRequestApprovalParams;
    const decisions: CodexAppServerProtocol.v2.CommandExecutionApprovalDecision[] = params
      .availableDecisions?.length
      ? params.availableDecisions
      : ['accept', 'acceptForSession', 'decline', 'cancel'];
    const command = typeof params.command === 'string' ? params.command : '';
    const choice = await askAgentApproval(context, {
      kind: 'command',
      title: 'Codex wants to run a command',
      detail: nonEmptyString(params.reason) ? params.reason : null,
      command: command ? displayApprovalCommand(command, roots) : null,
      paths: params.cwd ? [approvalPath(params.cwd, roots)] : [],
      rule: command
        ? commandApprovalRule(command)
        : { key: 'codex-command', label: 'Codex commands' },
    });
    return {
      decision: codexDecision(
        choice,
        decisions
      ) as CodexAppServerProtocol.v2.CommandExecutionApprovalDecision,
    };
  }

  if (input.method === 'item/fileChange/requestApproval') {
    const params = input.params as CodexAppServerProtocol.v2.FileChangeRequestApprovalParams;
    const choice = await askAgentApproval(context, {
      kind: 'file',
      title: 'Codex wants to change files',
      detail: nonEmptyString(params.reason) ? params.reason : null,
      command: null,
      paths: params.grantRoot ? [approvalPath(params.grantRoot, roots)] : [],
      rule: params.grantRoot
        ? writeApprovalRule(params.grantRoot, roots)
        : { key: 'codex-file-change', label: 'Codex file changes' },
    });
    return {
      decision: codexDecision(choice, [
        'accept',
        'acceptForSession',
        'decline',
        'cancel',
      ]) as CodexAppServerProtocol.v2.FileChangeApprovalDecision,
    };
  }

  const params = input.params as CodexAppServerProtocol.v2.PermissionsRequestApprovalParams;
  const kinds = [
    params.permissions.network ? 'network' : null,
    params.permissions.fileSystem ? 'file system' : null,
  ].filter(nonEmptyString);
  const choice = await askAgentApproval(context, {
    kind: 'permission',
    title: `Codex wants ${kinds.join(' and ') || 'more'} access`,
    detail: nonEmptyString(params.reason) ? params.reason : null,
    command: null,
    paths: [approvalPath(params.cwd, roots)],
    rule: permissionApprovalRule(kinds.join('+') || 'extra'),
  });
  if (!approvalChoiceAllows(choice)) return null;
  return {
    permissions: {
      ...(params.permissions.network ? { network: params.permissions.network } : {}),
      ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
    },
    scope: choice === 'once' ? 'turn' : 'session',
  };
}

function boundedJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) return null;
    return encoded.length <= 4_000 ? encoded : `${encoded.slice(0, 3_997)}...`;
  } catch {
    return '[unserializable input]';
  }
}

function grokApprovalCard(
  toolCall: GrokPermissionRequest['toolCall'],
  roots: readonly ApprovalRoot[]
): AgentApprovalCard {
  const raw =
    toolCall.rawInput && typeof toolCall.rawInput === 'object' && !Array.isArray(toolCall.rawInput)
      ? (toolCall.rawInput as Record<string, unknown>)
      : {};
  const command = typeof raw.command === 'string' ? raw.command : null;
  const path =
    typeof raw.path === 'string'
      ? raw.path
      : typeof raw.file_path === 'string'
        ? raw.file_path
        : null;
  const title = toolCall.title?.trim() || 'Grok wants to use a tool';
  return {
    kind: command ? 'command' : path ? 'file' : 'permission',
    title,
    detail: command || path ? null : boundedJson(toolCall.rawInput),
    command: command ? displayApprovalCommand(command, roots) : null,
    paths: path ? [approvalPath(path, roots)] : [],
    rule: command
      ? commandApprovalRule(command)
      : path
        ? writeApprovalRule(path, roots)
        : { key: `grok-tool:${toolCall.kind ?? 'other'}:${title}`, label: title },
  };
}

function grokOption(
  options: GrokPermissionRequest['options'],
  kinds: readonly PermissionOptionKind[]
): string | null {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option.optionId;
  }
  return null;
}

export async function answerGrokPermissionRequest(
  input: ApprovalContext & { params: GrokPermissionRequest }
): Promise<GrokPermissionResponse> {
  const choice = await askAgentApproval(
    { ...input, provider: 'grok-acp' },
    grokApprovalCard(input.params.toolCall, input.approvalRoots ?? [])
  );
  const optionId =
    choice === 'once'
      ? grokOption(input.params.options, ['allow_once', 'allow_always'])
      : choice === 'chat' || choice === 'always'
        ? grokOption(input.params.options, ['allow_always', 'allow_once'])
        : choice === 'deny'
          ? grokOption(input.params.options, ['reject_once', 'reject_always'])
          : null;
  return optionId
    ? { outcome: { outcome: 'selected', optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

interface GrokFormField {
  request: AgentUserInputRequest['questions'][number];
  parse: (
    answer: AgentUserInputResponse['answers'][string] | undefined
  ) => { ok: true; present: boolean; value?: ElicitationContentValue } | { ok: false };
}

function titledOptions(
  values: Array<{ const: string; title: string; description?: string | null }>
): AgentUserInputRequest['questions'][number]['options'] {
  return values.map((value) => ({
    id: value.const,
    label: value.title,
    description: value.description ?? '',
  }));
}

function untitledOptions(values: string[]): AgentUserInputRequest['questions'][number]['options'] {
  return values.map((value) => ({ id: value, label: value, description: '' }));
}

function selectedValues(
  answer: AgentUserInputResponse['answers'][string] | undefined,
  allowed: ReadonlySet<string>
): string[] | null {
  const selected = answer?.selectedOptionIds ?? [];
  return selected.every((value) => allowed.has(value)) ? selected : null;
}

function grokFormField(
  id: string,
  schema: GrokElicitationProperty,
  fallbackPrompt: string,
  required: boolean
): GrokFormField | null {
  const header = typeof schema.title === 'string' && schema.title.trim() ? schema.title.trim() : id;
  const description =
    typeof schema.description === 'string' && schema.description.trim()
      ? schema.description.trim()
      : fallbackPrompt;

  if (ElicitationPropertySchemaGuard.isString(schema)) {
    const choices = schema.oneOf?.length
      ? titledOptions(schema.oneOf)
      : schema.enum?.length
        ? untitledOptions(schema.enum)
        : [];
    const allowed = new Set(choices.map((option) => option.id));
    return {
      request: {
        id,
        header,
        prompt: description,
        options: choices,
        multiSelect: false,
        allowFreeText: choices.length === 0,
        ...(schema.default !== undefined && schema.default !== null && allowed.has(schema.default)
          ? { defaultOptionIds: [schema.default] }
          : {}),
      },
      parse(answer) {
        const value = choices.length
          ? selectedValues(answer, allowed)?.[0]
          : answer?.text?.trim() || schema.default || undefined;
        if (value === undefined) return required ? { ok: false } : { ok: true, present: false };
        if (schema.minLength != null && value.length < schema.minLength) return { ok: false };
        if (schema.maxLength != null && value.length > schema.maxLength) return { ok: false };
        if (schema.pattern) {
          try {
            if (!new RegExp(schema.pattern).test(value)) return { ok: false };
          } catch {
            return { ok: false };
          }
        }
        return { ok: true, present: true, value };
      },
    };
  }

  if (
    ElicitationPropertySchemaGuard.isNumber(schema) ||
    ElicitationPropertySchemaGuard.isInteger(schema)
  ) {
    const defaultValue = schema.default;
    return {
      request: {
        id,
        header,
        prompt:
          defaultValue === undefined || defaultValue === null
            ? description
            : `${description}\nDefault: ${defaultValue}`,
        options: [],
        multiSelect: false,
        allowFreeText: true,
      },
      parse(answer) {
        const raw = answer?.text?.trim();
        if (!raw && defaultValue == null) {
          return required ? { ok: false } : { ok: true, present: false };
        }
        const value = raw ? Number(raw) : defaultValue;
        if (value == null || !Number.isFinite(value)) return { ok: false };
        if (ElicitationPropertySchemaGuard.isInteger(schema) && !Number.isInteger(value)) {
          return { ok: false };
        }
        if (schema.minimum != null && value < schema.minimum) return { ok: false };
        if (schema.maximum != null && value > schema.maximum) return { ok: false };
        return { ok: true, present: true, value };
      },
    };
  }

  if (ElicitationPropertySchemaGuard.isBoolean(schema)) {
    return {
      request: {
        id,
        header,
        prompt: description,
        options: [
          { id: 'true', label: 'Yes', description: '' },
          { id: 'false', label: 'No', description: '' },
        ],
        multiSelect: false,
        allowFreeText: false,
        ...(schema.default == null ? {} : { defaultOptionIds: [String(schema.default)] }),
      },
      parse(answer) {
        const selected =
          answer?.selectedOptionIds[0] ??
          (schema.default == null ? undefined : String(schema.default));
        if (selected !== 'true' && selected !== 'false') {
          return required ? { ok: false } : { ok: true, present: false };
        }
        return { ok: true, present: true, value: selected === 'true' };
      },
    };
  }

  if (ElicitationPropertySchemaGuard.isArray(schema)) {
    const choices = MultiSelectItemsGuard.isTitled(schema.items)
      ? titledOptions(schema.items.anyOf)
      : MultiSelectItemsGuard.isString(schema.items)
        ? untitledOptions(schema.items.enum)
        : null;
    if (!choices) return null;
    const allowed = new Set(choices.map((option) => option.id));
    return {
      request: {
        id,
        header,
        prompt: description,
        options: choices,
        multiSelect: true,
        allowFreeText: false,
        ...(schema.default?.length ? { defaultOptionIds: schema.default } : {}),
      },
      parse(answer) {
        const values = selectedValues(answer, allowed) ?? schema.default ?? null;
        if (!values) return required ? { ok: false } : { ok: true, present: false };
        if (required && values.length === 0) return { ok: false };
        if (schema.minItems != null && values.length < schema.minItems) return { ok: false };
        if (schema.maxItems != null && values.length > schema.maxItems) return { ok: false };
        return { ok: true, present: true, value: values };
      },
    };
  }

  return null;
}

export async function answerGrokElicitation(input: {
  params: GrokElicitationRequest;
  conversationId: string | null;
  signal: AbortSignal;
  requestUserInput: RequestAgentUserInput;
}): Promise<GrokElicitationResponse> {
  if (!CreateElicitationRequestGuard.isForm(input.params)) return { action: 'decline' };
  const required = new Set(input.params.requestedSchema.required ?? []);
  const fields: Array<[string, GrokFormField]> = [];
  for (const [id, schema] of Object.entries(input.params.requestedSchema.properties ?? {})) {
    const field = grokFormField(id, schema, input.params.message, required.has(id));
    if (!field) return { action: 'decline' };
    fields.push([id, field]);
  }
  if (fields.length === 0) return { action: 'decline' };

  const response = await input.requestUserInput(
    {
      provider: 'grok-acp',
      conversationId: input.conversationId,
      questions: fields.map(([, field]) => field.request),
    },
    input.signal
  );
  if (response.outcome !== 'submitted') return { action: 'cancel' };

  const content: Record<string, ElicitationContentValue> = {};
  for (const [id, field] of fields) {
    const result = field.parse(response.answers[id]);
    if (!result.ok) return { action: 'decline' };
    if (result.present && result.value !== undefined) content[id] = result.value;
  }
  return { action: 'accept', content };
}
