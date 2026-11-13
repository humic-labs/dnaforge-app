/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  MOLECULAR_BENCHMARK_CASES,
  MOLECULAR_ACTIVE_BENCHMARK_CASES,
  MOLECULAR_V1_BENCHMARK_CASE_IDS,
  MOLECULAR_COMPARISON_PROFILES,
  MOLECULAR_HARNESS_ELIGIBILITY,
  molecularBenchmarkCase,
  molecularComparisonInstructions,
  readMolecularBenchmarkCase,
  readMolecularComparisonProfile,
  writeMolecularBenchmarkCase,
  writeMolecularComparisonProfile,
} from './molecular-comparison-profiles';
import { buildAgentSdkPrompt } from './prompts/cli-prompt';
import { buildSystemPrompt } from './prompts/system-prompt';
import {
  createMolecularPromptTrial,
  molecularSceneStructureSignature,
  molecularTrialUnexpectedTools,
  writeMolecularPromptTrial,
} from './molecular-prompt-trials';

describe('fixed-input protein visualization prompt trials', () => {
  beforeEach(() => localStorage.clear());

  it('offers only a camera-capable integrated path for new prompt trials', () => {
    expect(
      MOLECULAR_HARNESS_ELIGIBILITY.filter((path) => path.eligible).map((path) => path.id)
    ).toEqual(['dnaforge-mvs']);
    expect(MOLECULAR_HARNESS_ELIGIBILITY.find((path) => path.id === 'molstar-mcp')).toMatchObject({
      eligible: false,
      reason: expect.stringMatching(/camera/i),
    });
    expect(MOLECULAR_HARNESS_ELIGIBILITY.find((path) => path.id === 'burette')).toMatchObject({
      eligible: false,
      reason: expect.stringMatching(/planning path/i),
    });
  });

  it('keeps one scientific fixture identical while changing only the versioned prompt module', () => {
    expect(MOLECULAR_BENCHMARK_CASES.map((item) => item.id)).toEqual([
      'kcsa',
      'cas9',
      'groel',
      'abl',
      'pgt128',
      'h274y',
      'groel-asymmetry',
      'streptavidin-w120f',
      'rsv-f-d25',
      'f1-atpase',
      'ribosome-decoding',
      'adenylate-closure',
      'cas9-checkpoint',
      'pgt128-recognition',
      'sn101-muc1',
      'sn101-muc1-recognition',
    ]);
    for (const benchmark of MOLECULAR_BENCHMARK_CASES) {
      expect(benchmark.fixtureIds).toHaveLength(benchmark.structureModes.length);
      expect(new Set(benchmark.fixtureIds).size).toBe(benchmark.fixtureIds.length);
      expect(benchmark.question).toMatch(/\?$/);
    }
    const fixtureInput = {
      pdbId: '1K4C',
      referenceId: '748e6760-42fb-4704-94af-240286343123',
      savedViewId: 'saved-view:fixed-kcsa',
      coordinateSha256: 'a'.repeat(64),
      initialSceneSha256: 'b'.repeat(64),
      initialCameraSignature: '[]',
      structureSignature: '["assembly:1"]',
    };
    const claimId = '00000000-0000-4000-8000-000000000001';
    const cameraId = '00000000-0000-4000-8000-000000000002';
    writeMolecularPromptTrial(
      createMolecularPromptTrial({
        conversationId: claimId,
        caseId: 'kcsa',
        profileId: 'claim-v1',
        fixtures: [fixtureInput],
      })
    );
    writeMolecularPromptTrial(
      createMolecularPromptTrial({
        conversationId: cameraId,
        caseId: 'kcsa',
        profileId: 'camera-v1',
        fixtures: [fixtureInput],
      })
    );
    writeMolecularBenchmarkCase('cas9');
    writeMolecularComparisonProfile('appearance-v1');
    const claimPrompt = buildSystemPrompt([], false, undefined, undefined, claimId);
    const cameraPrompt = buildSystemPrompt([], false, undefined, undefined, cameraId);
    const fixture = molecularBenchmarkCase('kcsa')!;

    for (const prompt of [claimPrompt, cameraPrompt]) {
      expect(prompt.split(fixture.context).length - 1).toBe(1);
      expect(prompt).toContain('1K4C');
      expect(prompt).toContain(fixtureInput.coordinateSha256);
      expect(prompt).not.toContain('5F9R');
      expect(prompt).not.toContain('1AON');
      expect(new TextEncoder().encode(prompt).length).toBeLessThan(65536);
    }
    expect(claimPrompt).toContain('Prompt module claim-v1');
    expect(claimPrompt).not.toContain('Prompt module camera-v1');
    expect(cameraPrompt).toContain('Prompt module camera-v1');
    expect(cameraPrompt).not.toContain('Prompt module claim-v1');

    const cliPrompt = buildAgentSdkPrompt(
      [],
      [{ id: 'user-kcsa', role: 'user', content: fixture.question, createdAt: 1 }],
      'native-cli',
      false,
      [],
      'auto',
      'codex-sdk',
      cameraId
    );
    expect(cliPrompt.split(fixture.context).length - 1).toBe(1);
    expect(cliPrompt).toContain('mol_select_residues');
    expect(cliPrompt).toContain(
      "protein_get_context is limited to source:'protein-mcp', operation:'annotations'"
    );
    expect(new TextEncoder().encode(cliPrompt).length).toBeLessThan(60 * 1024);
    expect(
      buildSystemPrompt([], false, undefined, undefined, '00000000-0000-4000-8000-000000000003')
    ).not.toContain('Fixed protein benchmark context');
  });

  it('uses the nonviral MUC1 case for V1 while retaining historical HIV case identities', () => {
    expect(MOLECULAR_ACTIVE_BENCHMARK_CASES.map((item) => item.id).sort()).toEqual(
      [...MOLECULAR_V1_BENCHMARK_CASE_IDS].sort()
    );
    expect(MOLECULAR_ACTIVE_BENCHMARK_CASES.map((item) => item.id)).toContain(
      'sn101-muc1-recognition'
    );
    expect(MOLECULAR_ACTIVE_BENCHMARK_CASES.map((item) => item.id)).not.toContain('sn101-muc1');
    expect(MOLECULAR_ACTIVE_BENCHMARK_CASES.map((item) => item.id)).not.toContain(
      'pgt128-recognition'
    );
    expect(MOLECULAR_ACTIVE_BENCHMARK_CASES.map((item) => item.id)).not.toContain('pgt128');
    expect(molecularBenchmarkCase('pgt128-recognition')?.fixtureIds).toEqual(['3TYG']);
    expect(molecularBenchmarkCase('sn101-muc1-recognition')).toMatchObject({
      fixtureIds: ['6KX1'],
      structureModes: ['assembly:1'],
    });
  });

  it('falls back to no fixture and the baseline prompt for unknown saved selections', () => {
    expect(readMolecularBenchmarkCase()).toBeNull();
    expect(readMolecularComparisonProfile()).toBe('dnaforge');
    localStorage.setItem('dnaforge:protein-comparison-case-v1', 'unrecognized');
    localStorage.setItem('dnaforge:protein-comparison-profile', 'molstar-mcp');
    expect(readMolecularBenchmarkCase()).toBeNull();
    expect(readMolecularComparisonProfile()).toBe('dnaforge');
    expect(buildSystemPrompt([], false)).not.toContain('Fixed protein benchmark context');
  });

  it('keeps style guidance independent of a particular structure, residue, or palette', () => {
    for (const profile of MOLECULAR_COMPARISON_PROFILES) {
      const instructions = molecularComparisonInstructions(profile.id, null);
      expect(instructions).not.toMatch(/\b(?:1K4C|5F9R|1AON|1IEP|1M52)\b/i);
      expect(instructions).not.toMatch(/#[0-9a-f]{6}\b/i);
      expect(instructions).not.toMatch(/\b(?:Ser195|His57|Asp102|Trp120)\b/);
      expect(new TextEncoder().encode(instructions).length).toBeLessThan(1600);
    }
  });

  it('flags outside scientific lookups even when they appear only in persisted CLI activity', () => {
    const messages = [
      {
        role: 'activity',
        content: JSON.stringify({
          event: {
            toolCalls: [
              { name: 'mol_get_scene', status: 'completed' },
              { name: 'mol_select_residues', status: 'completed' },
              { name: 'protein_get_context', status: 'completed' },
              { name: 'external_fetch', status: 'completed' },
            ],
          },
        }),
      },
      { role: 'tool', tool_name: 'mol_save_view', content: '{}' },
    ];
    expect(molecularTrialUnexpectedTools(messages)).toEqual(['external_fetch']);
  });

  it('treats model versus biological assembly as part of the pinned structure', () => {
    const assembly = JSON.stringify({
      kind: 'multiple',
      snapshots: [
        {
          root: {
            kind: 'root',
            children: [{ kind: 'structure', params: { type: 'assembly', assembly_id: '1' } }],
          },
        },
        {
          root: {
            kind: 'root',
            children: [{ kind: 'structure', params: { type: 'assembly', assembly_id: '1' } }],
          },
        },
      ],
    });
    expect(molecularSceneStructureSignature(assembly)).toBe('["assembly:1"]');
    expect(() =>
      createMolecularPromptTrial({
        conversationId: '00000000-0000-4000-8000-000000000004',
        caseId: 'kcsa',
        profileId: 'dnaforge',
        fixtures: [
          {
            pdbId: '1K4C',
            referenceId: '748e6760-42fb-4704-94af-240286343123',
            savedViewId: 'saved-view:wrong-assembly',
            coordinateSha256: 'a'.repeat(64),
            initialSceneSha256: 'b'.repeat(64),
            initialCameraSignature: '[]',
            structureSignature: '["model"]',
          },
        ],
      })
    ).toThrow(/wrong model or assembly/);
  });
});
