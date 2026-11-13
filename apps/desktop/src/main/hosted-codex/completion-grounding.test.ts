import { describe, expect, it } from 'vitest';

import { validateHostedCodexCompletion } from './completion-grounding';

const readOnly = (toolName: string) => ({
  toolName,
  effects: ['read-only'] as const,
  isError: false,
});

const completed = (toolName: string, effects: readonly ('mutating' | 'ui-bound')[]) => ({
  toolName,
  effects,
  isError: false,
});

const biologySearch = (query: string, entries: readonly Record<string, unknown>[]) => ({
  toolName: 'list_files',
  effects: ['read-only'] as const,
  isError: false,
  biologyMatchesFound: entries.length > 0,
  input: { path: 'DNAForge Samples', biologyQuery: query, recursive: true },
  output: { biologyQuery: query, entries, count: entries.length },
});

describe('Hosted Codex completion grounding', () => {
  it('rejects the exact  false cross-project creation answer', () => {
    expect(
      validateHostedCodexCompletion({
        userMessage:
          'Create an E. coli amp-inducible MBP expression backbone in My Project using pGEX-4T-1 from DNAForge Samples. Use the source directly. Draft the assembly but do not finalize it.',
        answer:
          'I located pGEX-4T-1 and planned the source region, but DNAForge declined creation, so no assembly was created.',
        tools: [
          readOnly('get_workspace'),
          readOnly('list_files'),
          readOnly('list_files'),
          readOnly('get_sequence'),
          readOnly('plan_design_regions'),
        ],
      })
    ).toEqual({
      ok: false,
      code: 'ungrounded_action_rejection',
      missingToolNames: [],
    });
  });

  it('requires the complete durable draft chain for an explicit new assembly request', () => {
    const input = {
      userMessage:
        'Please build a plasmid construct from the named source and draft the assembly without finalizing it.',
      answer: 'The draft is ready.',
      tools: [readOnly('get_sequence'), completed('create_design', ['mutating', 'ui-bound'])],
    } as const;

    expect(validateHostedCodexCompletion(input)).toEqual({
      ok: false,
      code: 'requested_effect_unproven',
      missingToolNames: ['add_design_region', 'draft_design_assembly'],
    });

    expect(
      validateHostedCodexCompletion({
        ...input,
        tools: [
          ...input.tools,
          completed('add_design_region', ['mutating']),
          completed('draft_design_assembly', ['mutating']),
        ],
      })
    ).toEqual({ ok: true });
  });

  it('rejects the exact  false source-absence answer after a matching biology search', () => {
    expect(
      validateHostedCodexCompletion({
        userMessage:
          'Create an E. coli amp-inducible MBP expression backbone in My Project using pGEX-4T-1 from DNAForge Samples. Draft the assembly but do not finalize it.',
        answer:
          'No MBP feature or separate MBP source was identified. Please provide or identify the MBP sequence to insert.',
        tools: [
          biologySearch('MBP', [
            {
              name: 'ODC_0141',
              documentId: 'sample-8cb6db3c',
              biologyMatches: ['/label="N1N2_MBP"'],
            },
          ]),
          readOnly('get_sequence'),
        ],
      })
    ).toEqual({
      ok: false,
      code: 'ungrounded_source_absence',
      missingToolNames: [],
    });
  });

  it('requires a successful effect for clear revise and highlight requests', () => {
    expect(
      validateHostedCodexCompletion({
        userMessage: 'Revise the existing design to include the planned source region.',
        answer: 'I reviewed the design.',
        tools: [readOnly('get_design')],
      })
    ).toMatchObject({ ok: false, code: 'requested_effect_unproven' });

    expect(
      validateHostedCodexCompletion({
        userMessage: 'Highlight bases 101 through 160 in the open sequence.',
        answer: 'The range is highlighted.',
        tools: [readOnly('get_sequence')],
      })
    ).toEqual({
      ok: false,
      code: 'requested_effect_unproven',
      missingToolNames: ['highlight_range'],
    });

    expect(
      validateHostedCodexCompletion({
        userMessage: 'Highlight bases 101 through 160 in the open sequence.',
        answer: 'The range is highlighted.',
        tools: [completed('highlight_range', ['ui-bound'])],
      })
    ).toEqual({ ok: true });
  });

  it('allows a grounded failure report and does not turn explanation questions into effects', () => {
    expect(
      validateHostedCodexCompletion({
        userMessage: 'Create a plasmid construct from this source and draft the assembly.',
        answer: 'DNAForge declined creation because the destination project is read-only.',
        tools: [
          {
            toolName: 'create_design',
            effects: ['mutating', 'ui-bound'],
            isError: true,
          },
        ],
      })
    ).toEqual({ ok: true });

    expect(
      validateHostedCodexCompletion({
        userMessage: 'How do I create a plasmid design without finalizing it?',
        answer: 'Create a design, add regions, and draft it.',
        tools: [],
      })
    ).toEqual({ ok: true });
  });

  it('rejects terminal answers after recoverable draft-shape failures', () => {
    const input = {
      userMessage:
        'Create an E. coli amp-inducible MBP expression backbone and draft the assembly.',
      answer: 'I created the design, but DNAForge refused to draft it.',
      tools: [
        completed('create_design', ['mutating', 'ui-bound']),
        completed('add_design_region', ['mutating']),
      ],
    } as const;

    for (const failureCode of [
      'DESIGN_REGIONS_REQUIRED',
      'FULL_CIRCULAR_SOURCE_ASSEMBLY',
      'SPLIT_CIRCULAR_SOURCE_RANGE',
      'UNCHANGED_SOURCE_REASSEMBLY',
    ]) {
      expect(
        validateHostedCodexCompletion({
          ...input,
          tools: [
            ...input.tools,
            {
              toolName: 'draft_design_assembly',
              effects: ['mutating'] as const,
              isError: true,
              failureCode,
            },
          ],
        })
      ).toEqual({
        ok: false,
        code: 'requested_effect_unproven',
        missingToolNames: ['draft_design_assembly'],
      });
    }

    expect(
      validateHostedCodexCompletion({
        ...input,
        tools: [
          ...input.tools,
          {
            toolName: 'draft_design_assembly',
            effects: ['mutating'],
            isError: true,
            failureCode: 'DESIGN_REGIONS_REQUIRED',
          },
          completed('add_design_region', ['mutating']),
          completed('draft_design_assembly', ['mutating']),
        ],
      })
    ).toEqual({ ok: true });
  });
});
