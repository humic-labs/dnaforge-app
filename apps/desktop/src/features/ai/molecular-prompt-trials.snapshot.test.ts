/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMolecularPromptTrial,
  molecularTrialUnexpectedTools,
  molecularTrialUncheckedNamedGroups,
  molecularTrialWrongViewTargets,
  readMolecularPromptTrialForTurn,
  clearMolecularPromptTrialIsolation,
  readMolecularTrialSentPromptSnapshot,
  writeMolecularPromptTrial,
  writeMolecularTrialSentPromptSnapshot,
} from './molecular-prompt-trials';

describe('controlled protein trial prompt snapshot', () => {
  beforeEach(() => localStorage.clear());

  it('scopes native bridge sessions separately from their recorded chat turns', () => {
    const conversationId = '00000000-0000-4000-8000-000000000020';
    const turnId = '00000000-0000-4000-8000-000000000021';
    const bridgeTurnId = '00000000-0000-4000-8000-000000000022';
    const trial = createMolecularPromptTrial({
      conversationId,
      caseId: 'kcsa',
      profileId: 'camera-v1',
      experiment: { id: '00000000-0000-4000-8000-000000000023', replicate: 1, replicateCount: 3 },
      fixtures: [
        {
          pdbId: '1K4C',
          referenceId: '00000000-0000-4000-8000-000000000001',
          savedViewId: 'saved-view:00000000-0000-4000-8000-000000000005',
          coordinateSha256: 'a'.repeat(64),
          initialSceneSha256: 'b'.repeat(64),
          initialCameraSignature: '[]',
          structureSignature: '["assembly:1"]',
        },
      ],
    });
    expect(trial.promptInstructions).toContain("operation:'annotations'");
    expect(trial.promptInstructions).toContain('an author chain verified in the loaded inventory');
    expect(trial.promptInstructions).toContain(
      'verify their correspondence to the loaded sequence'
    );
    expect(trial.promptInstructions).not.toContain('Do not call protein_get_context');
    writeMolecularPromptTrial(trial);
    writeMolecularTrialSentPromptSnapshot({
      version: 1,
      conversationId,
      turnId,
      bridgeTurnId,
      channel: 'cli-seed',
      prompt: 'Seed',
      continuationPrompt: 'Continuation',
      additionalAgentInstructions: null,
      capturedAt: 42,
    });
    expect(readMolecularPromptTrialForTurn(bridgeTurnId)?.conversationId).toBe(conversationId);
    expect(readMolecularPromptTrialForTurn(turnId)?.conversationId).toBe(conversationId);
    expect(readMolecularPromptTrialForTurn('unrelated-session')).toBeNull();
    clearMolecularPromptTrialIsolation(conversationId);
    expect(readMolecularPromptTrialForTurn(bridgeTurnId)).toBeNull();
  });

  it('retains the exact app-sent prompt only for the fixed conversation', () => {
    const conversationId = '00000000-0000-4000-8000-000000000006';
    const trial = createMolecularPromptTrial({
      conversationId,
      caseId: 'kcsa',
      profileId: 'camera-v1',
      fixtures: [
        {
          pdbId: '1K4C',
          referenceId: '00000000-0000-4000-8000-000000000001',
          savedViewId: 'saved-view:00000000-0000-4000-8000-000000000005',
          coordinateSha256: 'a'.repeat(64),
          initialSceneSha256: 'b'.repeat(64),
          initialCameraSignature: '[]',
          structureSignature: '["assembly:1"]',
        },
      ],
    });
    writeMolecularPromptTrial(trial);
    const snapshot = {
      version: 1 as const,
      conversationId,
      turnId: '00000000-0000-4000-8000-000000000007',
      channel: 'cli-seed' as const,
      prompt: 'The exact prompt sent to the CLI agent.',
      continuationPrompt: 'The exact prompt for subsequent CLI steps.',
      additionalAgentInstructions: 'Separate custom instructions.',
      capturedAt: 42,
    };
    writeMolecularTrialSentPromptSnapshot(snapshot);
    expect(readMolecularTrialSentPromptSnapshot(conversationId)).toMatchObject({
      ...snapshot,
      scenePolicy: {
        id: expect.any(String),
        enforcedConstraints: expect.arrayContaining([
          expect.objectContaining({ id: 'background-locked', errorCode: 'MVS_BACKGROUND_LOCKED' }),
        ]),
      },
    });
    expect(readMolecularTrialSentPromptSnapshot('00000000-0000-4000-8000-000000000008')).toBeNull();
  });

  it('freezes an edited variant without changing the scientific fixture', () => {
    const fixtures = [
      {
        pdbId: '1K4C',
        referenceId: '00000000-0000-4000-8000-000000000001',
        savedViewId: 'saved-view:00000000-0000-4000-8000-000000000005',
        coordinateSha256: 'a'.repeat(64),
        initialSceneSha256: 'b'.repeat(64),
        initialCameraSignature: '[]',
        structureSignature: '["assembly:1"]',
      },
    ];
    const first = createMolecularPromptTrial({
      conversationId: '00000000-0000-4000-8000-000000000010',
      caseId: 'kcsa',
      variant: {
        id: 'custom:camera-study',
        label: 'Camera study',
        instructions: 'Focus on the filter atoms.',
      },
      fixtures,
    });
    const second = createMolecularPromptTrial({
      conversationId: '00000000-0000-4000-8000-000000000011',
      caseId: 'kcsa',
      variant: {
        id: 'custom:camera-study',
        label: 'Camera study',
        instructions: 'Show the pore entrance too.',
      },
      fixtures,
    });
    expect(first.profileLabel).toBe('Camera study');
    expect(first.promptInstructions).toContain('Focus on the filter atoms.');
    expect(first.promptInstructions).not.toContain('Show the pore entrance too.');
    expect(first.question).toBe(second.question);
    expect(first.fixtures).toEqual(second.fixtures);
    expect(second.promptInstructions).toContain('Show the pore entrance too.');
  });

  it('audits actual CLI activity, including forbidden tools and cross-run structure targets', () => {
    const activity = (tool: string, structureViewId?: string) => ({
      role: 'activity',
      content: JSON.stringify({
        type: 'agent.activity',
        event: {
          raw: {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'dnaforge',
              tool,
              arguments: structureViewId ? { structureViewId } : {},
              status: 'completed',
            },
          },
        },
      }),
    });
    const messages = [
      activity('mol_get_scene', 'saved-view:other-run'),
      activity('external_fetch'),
    ];
    expect(molecularTrialUnexpectedTools(messages)).toEqual(['external_fetch']);
    expect(molecularTrialWrongViewTargets(messages, ['saved-view:this-run'])).toEqual([
      'mol_get_scene → saved-view:other-run',
    ]);
    const interaction = activity('mol_show_interaction_context', 'saved-view:this-run');
    expect(molecularTrialUnexpectedTools([interaction])).toEqual([]);
    expect(molecularTrialWrongViewTargets([interaction], ['saved-view:this-run'])).toEqual([]);
    const alignment = activity('mol_align_structures', 'saved-view:this-run');
    expect(molecularTrialUnexpectedTools([alignment])).toEqual([]);
    expect(molecularTrialWrongViewTargets([alignment], ['saved-view:this-run'])).toEqual([]);
    const wrongBinding = {
      role: 'tool',
      tool_name: 'mol_show_interaction_context',
      content: JSON.stringify({
        input: { bindingId: 'saved-view:other-run', selection: 'resn ATP' },
      }),
    };
    expect(molecularTrialWrongViewTargets([wrongBinding], ['saved-view:this-run'])).toEqual([
      'mol_show_interaction_context → saved-view:other-run',
    ]);
  });

  it('requires resolved named-group readback after the final edit and before saving each view', () => {
    const view = 'saved-view:target';
    const scene = JSON.stringify({
      root: {
        kind: 'root',
        children: [{ kind: 'color', custom: { dnaforge_legend_label: 'Focal group' } }],
      },
    });
    const activity = (tool: string, extras: Record<string, unknown> = {}) => ({
      role: 'activity',
      content: JSON.stringify({
        event: {
          raw: {
            item: {
              type: 'mcp_tool_call',
              tool,
              arguments: { structureViewId: view, ...extras },
            },
          },
        },
      }),
    });
    const edited = activity('mol_apply_scene');
    const readback = activity('mol_get_scene', { includeColorGroupSelections: true });
    const save = activity('mol_save_view');
    const named = [{ structureViewId: view, scene }];
    expect(
      molecularTrialUncheckedNamedGroups(
        [edited, readback, activity('mol_align_structures'), save],
        named
      )
    ).toEqual([view]);
    expect(molecularTrialUncheckedNamedGroups([edited, save], named)).toEqual([view]);
    expect(
      molecularTrialUncheckedNamedGroups([edited, activity('mol_get_scene'), save], named)
    ).toEqual([view]);
    expect(molecularTrialUncheckedNamedGroups([edited, readback, save], named)).toEqual([]);
    expect(molecularTrialUncheckedNamedGroups([readback, edited, save], named)).toEqual([view]);
    expect(molecularTrialUncheckedNamedGroups([edited, readback, edited, save], named)).toEqual([
      view,
    ]);
    expect(
      molecularTrialUncheckedNamedGroups(
        [edited, save],
        [{ structureViewId: view, scene: '{"root":{"kind":"root"}}' }]
      )
    ).toEqual([]);
  });
});
