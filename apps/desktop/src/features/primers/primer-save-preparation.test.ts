import { describe, expect, it, vi } from 'vitest';
import { builtinPrimerSchemaView } from './primer-entity-schema';
import { parseIdtOligoNotation } from './oligo-modifications';
import { preparePrimerSaveInput, type PreparePrimerSaveInput } from './primer-save-preparation';

function saveInput(overrides: Partial<PreparePrimerSaveInput> = {}): PreparePrimerSaveInput {
  return {
    draft: {
      parsedOligo: parseIdtOligoNotation('ACGTACGTACGTACGTACGT'),
      orderType: 'dna',
      name: ' pUC19 forward ',
      schema: builtinPrimerSchemaView(),
      schemaFieldDrafts: {},
    },
    destination: {
      workspaceRoot: '/workspace/project',
      fixedArtifactPath: '/workspace/project/primers/pUC19-forward.primer.json',
      artifactDir: null,
      suggestedArtifactPath: '',
      ownerWorkspaceRoot: vi.fn().mockReturnValue('/workspace/project'),
    },
    binding: {
      direction: 'forward',
      threePrimeExt: 0,
      initialBindingStart: 100,
      initialBindingEnd: 120,
      targetFilePath: '/workspace/project/pUC19.gb',
      targetDocumentId: 'sequence-puc19',
      targetTopology: 'circular',
      sequenceId: 42,
      sequenceLength: 2686,
      circular: true,
    },
    workspaceId: 7,
    ...overrides,
  };
}

describe('preparePrimerSaveInput', () => {
  it.each(['suggested', 'selected'] as const)(
    'resolves a %s destination in a newly mounted nested project and drops the original project ID',
    (mode) => {
      const input = saveInput();
      input.binding = { direction: 'forward', threePrimeExt: 0 };
      input.destination = {
        ...input.destination,
        fixedArtifactPath: undefined,
        artifactDir: mode === 'selected' ? '/workspace/project/nested' : null,
        suggestedArtifactPath: '/workspace/project/nested/pUC19-forward.primer.json',
        ownerWorkspaceRoot: (path) =>
          path.startsWith('/workspace/project/nested')
            ? '/workspace/project/nested'
            : '/workspace/project',
      };
      const result = preparePrimerSaveInput(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.workspaceRoot).toBe('/workspace/project/nested');
      expect(result.value).not.toHaveProperty('workspaceId');
    }
  );

  it('rejects an unavailable destination before calling persistence', () => {
    const input = saveInput();
    input.destination.ownerWorkspaceRoot = () => undefined;
    expect(preparePrimerSaveInput(input)).toEqual({
      ok: false,
      error: 'Choose a save folder in an open project. Your primer draft is still here.',
    });
  });

  it('does not silently reparent an existing artifact edit', () => {
    const input = saveInput();
    input.destination.ownerWorkspaceRoot = () => '/workspace/project/primers';
    expect(preparePrimerSaveInput(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('reopen the primer from its owning project'),
    });
  });

  it('rejects a bound target in a different mounted project', () => {
    const input = saveInput();
    input.destination.fixedArtifactPath = undefined;
    input.destination.artifactDir = '/other';
    input.destination.ownerWorkspaceRoot = (path) =>
      path.startsWith('/other') ? '/other' : '/workspace/project';
    expect(preparePrimerSaveInput(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('same project as its target sequence'),
    });
  });

  it('builds one validated file-authoritative input with stable binding identity', () => {
    const result = preparePrimerSaveInput(saveInput());

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        name: 'pUC19 forward',
        sequence: 'ACGTACGTACGTACGTACGT',
        artifactPath: '/workspace/project/primers/pUC19-forward.primer.json',
        workspaceRoot: '/workspace/project',
        workspaceId: 7,
        requireRegistry: true,
        targetFilePath: '/workspace/project/pUC19.gb',
        targetDocumentId: 'sequence-puc19',
        targetLength: 2686,
        targetTopology: 'circular',
        bindingSequenceId: 42,
        bindingStart: 100,
        bindingEnd: 120,
        bindingStrand: 1,
      }),
    });
  });

  it('rejects a selected range without a stable sequence document identity', () => {
    const input = saveInput();
    input.binding = { ...input.binding, targetDocumentId: undefined };

    expect(preparePrimerSaveInput(input)).toEqual({
      ok: false,
      error: 'Reopen the target sequence from its project before attaching this primer.',
    });
  });

  it('rejects linear binding geometry that extends past the template', () => {
    const input = saveInput();
    input.binding = {
      ...input.binding,
      circular: false,
      targetTopology: 'linear',
      initialBindingStart: 0,
      initialBindingEnd: 10,
      sequenceLength: 100,
    };

    expect(preparePrimerSaveInput(input)).toEqual({
      ok: false,
      error:
        'Primer binding site runs past the template — shorten the primer or adjust the selection.',
    });
  });
});

describe('preparePrimerSaveInput with a host-owned binding', () => {
  const hostBinding = (binding: Partial<PreparePrimerSaveInput['binding']> = {}) =>
    saveInput({
      binding: {
        hostOwned: true,
        direction: 'forward',
        threePrimeExt: 0,
        initialBindingStart: 300,
        initialBindingEnd: 320,
        sequenceLength: 620,
        circular: false,
        ...binding,
      },
    });

  it('saves the primer unbound and returns the site in template coordinates', () => {
    const result = preparePrimerSaveInput(hostBinding());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostBinding).toEqual({ start: 300, end: 320, strand: 1 });
    expect(result.value).not.toHaveProperty('targetDocumentId');
    expect(result.value).not.toHaveProperty('bindingStart');
  });

  it('reports a reverse primer on the minus strand', () => {
    const result = preparePrimerSaveInput(hostBinding({ direction: 'reverse' }));
    expect(result.ok && result.hostBinding).toEqual({ start: 300, end: 320, strand: -1 });
  });

  it('refuses a site that runs past the loaded template', () => {
    const result = preparePrimerSaveInput(
      hostBinding({ initialBindingStart: 610, initialBindingEnd: 630 })
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/past the loaded template/),
    });
  });
});
