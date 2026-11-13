import { describe, it, expect } from 'vitest';
import { buildSlashAskPayload } from './build-payload';
import {
  buildAskAiSelectionInput,
  type AskAiViewerPayload,
} from '../components/ask-ai-selection-input';
import type { ActiveOverlaySnapshot } from '../../ai/selection-descriptor/active-overlays';

const CTX = {
  documentId: 'sequence-document-puc19',
  workspaceRootPath: '/workspace',
  sequenceBasename: 'pUC19.gb',
};

const OVERLAYS: ActiveOverlaySnapshot = {
  restrictionSites: { visible: true, sites: [] },
  orfs: { visible: false, items: [] },
  primers: { visible: true, items: [] },
};

function descriptorFields(input: ReturnType<typeof buildAskAiSelectionInput>) {
  const { seedText: _seedText, ...rest } = input;
  return rest;
}

describe('Slash-Ask reuse parity ', () => {
  it('a RANGE via `/` builds the SAME descriptor+overlays input as right-click', () => {
    const range = { start: 123, end: 456 };

    const rightClickPayload: AskAiViewerPayload = { range, overlays: OVERLAYS };
    const rightClickInput = buildAskAiSelectionInput(rightClickPayload, CTX);

    const staged = buildSlashAskPayload({
      sourceRange: range,
      sourceCaret: null,
      sequenceLength: 3000,
      isCircular: false,
    });
    expect(staged).not.toBeNull();
    const slashPayload: AskAiViewerPayload = {
      range: staged!.range,
      wraps: staged!.range.wraps,
      overlays: OVERLAYS,
      inferredWindow: staged!.inferredWindow,
      seedText: 'What is this region?',
    };
    const slashInput = buildAskAiSelectionInput(slashPayload, CTX);

    expect(descriptorFields(slashInput)).toEqual(descriptorFields(rightClickInput));
    expect(slashInput.seedText).toBe('What is this region?');
    expect(rightClickInput.seedText).toBeUndefined();
    expect(slashInput.deepLinkParams).toEqual({ start: 123, end: 456, wraps: undefined });
  });

  it('a CARET-only `/` stages an inferred window LABELED in the chip', () => {
    const staged = buildSlashAskPayload({
      sourceRange: null,
      sourceCaret: 1500,
      sequenceLength: 3000,
      isCircular: false,
    });
    expect(staged!.inferredWindow).toBe(true);

    const input = buildAskAiSelectionInput(
      { range: staged!.range, inferredWindow: true, seedText: 'q' },
      CTX
    );
    expect(input.displayLabel).toContain('(inferred window)');
    expect(input.displayLabel).toContain('~');
    expect(input.deepLinkParams.start).toBe(staged!.range.start);
    expect(input.deepLinkParams.end).toBe(staged!.range.end);
  });
});
