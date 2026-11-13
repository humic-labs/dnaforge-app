import type { ToolEffect } from './dynamic-tool-catalog';

export interface HostedCodexCompletedTool {
  readonly toolName: string;
  readonly effects: readonly ToolEffect[];
  readonly isError: boolean;
  readonly failureCode?: string;
  readonly biologyMatchesFound?: boolean;
}

export type HostedCodexCompletionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'ungrounded_action_rejection'
        | 'ungrounded_source_absence'
        | 'requested_effect_unproven';
      readonly missingToolNames: readonly string[];
    };

const NEW_DESIGN_TOOLS = Object.freeze([
  'create_design',
  'add_design_region',
  'draft_design_assembly',
]);

const RECOVERABLE_DRAFT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'DESIGN_REGIONS_REQUIRED',
  'FULL_CIRCULAR_SOURCE_ASSEMBLY',
  'SPLIT_CIRCULAR_SOURCE_RANGE',
  'UNCHANGED_SOURCE_REASSEMBLY',
]);

const DESIGN_REVISION_TOOLS: ReadonlySet<string> = new Set([
  'add_design_region',
  'remove_design_region',
  'reorder_design_regions',
  'draft_design_assembly',
  'assembly.setEditableField',
]);

const COMMAND_PREFIX =
  /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|i\s+(?:want|need)\s+you\s+to\s+)?/iu;

function commandSentences(message: string): string[] {
  if (/^\s*how\s+(?:do|can|would|should)\b/iu.test(message)) return [];
  return message
    .replace(/\b([A-Z])\.\s+(?=[a-z]+\b)/gu, '$1 ')
    .split(/[.!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => sentence.replace(COMMAND_PREFIX, ''));
}

function requestsNewDesign(message: string): boolean {
  return commandSentences(message).some(
    (sentence) =>
      /^(?:create|build|draft|assemble)\b/iu.test(sentence) &&
      /\b(?:plasmid|construct|backbone|assembly)\b/iu.test(sentence)
  );
}

function requestsDesignRevision(message: string): boolean {
  return commandSentences(message).some(
    (sentence) =>
      /^(?:continue|revise|update|change|modify)\b/iu.test(sentence) &&
      /\b(?:design|assembly|plasmid|construct)\b/iu.test(sentence)
  );
}

function requestsRangeHighlight(message: string): boolean {
  return commandSentences(message).some(
    (sentence) =>
      /^(?:open(?:\s+and)?\s+highlight|highlight|show|select)\b/iu.test(sentence) &&
      /\b(?:base|bases|bp|range|region|span|coordinate|coordinates)\b/iu.test(sentence)
  );
}

function claimsActionRejection(answer: string): boolean {
  return (
    /\bDNAForge\s+(?:(?:has|had)\s+)?(?:declined|rejected|refused|blocked)\b/iu.test(answer) ||
    /\bDNAForge\s+(?:could\s+not|couldn't|was\s+unable\s+to)\b/iu.test(answer) ||
    /\b(?:action|change|creation|request|tool\s+call)\s+(?:was|were|is|are|has\s+been|had\s+been)\s+(?:declined|rejected|refused|blocked)\b/iu.test(
      answer
    )
  );
}

function claimsBiologicalSourceAbsence(answer: string): boolean {
  return /\bno\b[^.!?\n]{0,120}\b(?:biological\s+)?(?:source|sequence|part|candidate)\b[^.!?\n]{0,80}\b(?:identified|found|located|available)\b/iu.test(
    answer
  );
}

export function validateHostedCodexCompletion(input: {
  readonly userMessage: string;
  readonly answer: string;
  readonly tools: readonly HostedCodexCompletedTool[];
}): HostedCodexCompletionValidation {
  const failedTools = new Set(
    input.tools.filter((tool) => tool.isError).map((tool) => tool.toolName)
  );
  const successfulTools = new Set(
    input.tools.filter((tool) => !tool.isError).map((tool) => tool.toolName)
  );

  if (claimsActionRejection(input.answer) && failedTools.size === 0) {
    return { ok: false, code: 'ungrounded_action_rejection', missingToolNames: [] };
  }

  if (
    claimsBiologicalSourceAbsence(input.answer) &&
    input.tools.some((tool) => !tool.isError && tool.biologyMatchesFound === true)
  ) {
    return { ok: false, code: 'ungrounded_source_absence', missingToolNames: [] };
  }

  if (requestsNewDesign(input.userMessage)) {
    const hasTerminalNewDesignFailure = input.tools.some(
      (tool) =>
        tool.isError &&
        NEW_DESIGN_TOOLS.includes(tool.toolName) &&
        !(
          tool.toolName === 'draft_design_assembly' &&
          tool.failureCode !== undefined &&
          RECOVERABLE_DRAFT_FAILURE_CODES.has(tool.failureCode)
        )
    );
    if (hasTerminalNewDesignFailure) return { ok: true };
    const missingToolNames = NEW_DESIGN_TOOLS.filter((toolName) => !successfulTools.has(toolName));
    if (missingToolNames.length > 0) {
      return { ok: false, code: 'requested_effect_unproven', missingToolNames };
    }
  }

  if (requestsDesignRevision(input.userMessage)) {
    const attemptedRevision = input.tools.some((tool) => DESIGN_REVISION_TOOLS.has(tool.toolName));
    const completedRevision = input.tools.some(
      (tool) => DESIGN_REVISION_TOOLS.has(tool.toolName) && !tool.isError
    );
    if (attemptedRevision && !completedRevision) return { ok: true };
    if (!completedRevision) {
      return { ok: false, code: 'requested_effect_unproven', missingToolNames: [] };
    }
  }

  if (requestsRangeHighlight(input.userMessage)) {
    if (failedTools.has('highlight_range')) return { ok: true };
    if (!successfulTools.has('highlight_range')) {
      return {
        ok: false,
        code: 'requested_effect_unproven',
        missingToolNames: ['highlight_range'],
      };
    }
  }

  return { ok: true };
}
