import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveReference, parseLocatorPath } from './resolver';
import type { DBEntityReference } from '../../../db/entity-references';
import { useWorkspaceStore } from '../../../stores/workspaceStore';

describe('resolveReference', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      folders: [{ path: '/workspace/lab', name: 'lab', addedAt: 0 }],
      activeWorkspaceFile: null,
    });
  });

  it('resolves a sequence reference to absolute path', () => {
    const ref: DBEntityReference = {
      id: 'ref-1',
      entity_type: 'sequence',
      display_label: 'pUC19',
      locator: 'git://lab/plasmids/pUC19.gb',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const action = resolveReference(ref);
    expect(action).toEqual({
      tabType: 'sequence',
      entityId: 'lab/plasmids/pUC19.gb',
      label: 'pUC19',
      viewState: undefined,
      legacySequenceSourcePath: '/workspace/lab/plasmids/pUC19.gb',
    });
  });

  it('resolves a sequence_region with deep-link params (1-indexed → 0-indexed conversion)', () => {
    const ref: DBEntityReference = {
      id: 'ref-2',
      entity_type: 'sequence_region',
      display_label: 'GFP region',
      locator: 'git://lab/plasmids/pUC19.gb',
      deep_link_params: JSON.stringify({ start: 1204, end: 1228 }),
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const action = resolveReference(ref);
    expect(action).toEqual({
      tabType: 'sequence',
      entityId: 'lab/plasmids/pUC19.gb',
      label: 'GFP region',
      viewState: {
        scrollPosition: 1204,
        highlightRange: { start: 1203, end: 1227 },
      },
      legacySequenceSourcePath: '/workspace/lab/plasmids/pUC19.gb',
    });
  });

  it('resolves a sequence_region with wraps param', () => {
    const ref: DBEntityReference = {
      id: 'ref-2b',
      entity_type: 'sequence_region',
      display_label: 'Wrapping region',
      locator: 'git://lab/plasmids/pUC19.gb',
      deep_link_params: JSON.stringify({ start: 2600, end: 100, wraps: true }),
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const action = resolveReference(ref);
    expect(action.viewState).toEqual({
      scrollPosition: 2600,
      highlightRange: { start: 2599, end: 99, wraps: true },
    });
  });

  it('resolves an annotation through the live exact-selection path', () => {
    const ref: DBEntityReference = {
      id: 'ref-annotation',
      entity_type: 'annotation',
      display_label: 'bla',
      locator: 'git://lab/plasmids/pUC19.gb',
      deep_link_params: JSON.stringify({ featureName: 'bla', start: 1629, end: 2489 }),
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    expect(resolveReference(ref)).toEqual({
      tabType: 'sequence',
      entityId: 'lab/plasmids/pUC19.gb',
      label: 'bla',
      viewState: {
        scrollPosition: 1629,
        highlightRange: { start: 1628, end: 2488 },
      },
      legacySequenceSourcePath: '/workspace/lab/plasmids/pUC19.gb',
    });
  });

  it('retains the legacy annotation featureStart scroll path without pretending it selected', () => {
    const ref: DBEntityReference = {
      id: 'ref-annotation-legacy',
      entity_type: 'annotation',
      display_label: 'legacy annotation',
      locator: 'git://lab/plasmids/pUC19.gb',
      deep_link_params: JSON.stringify({ featureName: 'legacy', featureStart: 900 }),
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    expect(resolveReference(ref).viewState).toEqual({ scrollPosition: 900 });
  });

  it('resolves a page reference', () => {
    const ref: DBEntityReference = {
      id: 'ref-3',
      entity_type: 'notebook',
      display_label: 'Cloning Protocol',
      locator: 'entity://page/page-uuid-123',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const action = resolveReference(ref);
    expect(action).toEqual({
      tabType: 'page',
      entityId: 'page-uuid-123',
      label: 'Cloning Protocol',
      viewState: undefined,
    });
  });

  it.each([
    ['notebook', 'notes/qualification.md'],
    ['alignment', 'alignments/pUC19-vs-variant.aln'],
  ])('opens a file-backed %s in the real text viewer', (entityType, relativePath) => {
    const ref: DBEntityReference = {
      id: `ref-${entityType}`,
      entity_type: entityType,
      display_label: relativePath.split('/').at(-1) ?? relativePath,
      locator: `git://lab/${relativePath}`,
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    expect(resolveReference(ref)).toEqual({
      tabType: 'text',
      entityId: `/workspace/lab/${relativePath}`,
      label: relativePath.split('/').at(-1) ?? relativePath,
      viewState: undefined,
    });
  });

  it('resolves a structure with highlightGroups deep-link params', () => {
    const highlightGroups = [
      {
        id: 'ask-ai-selection',
        label: 'Selected residues',
        selections: [
          {
            chain: 'G',
            baseChain: 'G',
            operator: null,
            ranges: [
              [57, 57],
              [102, 102],
              [195, 195],
            ],
          },
        ],
        color: '#ff6699',
      },
    ];

    const ref: DBEntityReference = {
      id: 'ref-5',
      entity_type: 'structure',
      display_label: 'p53 binding domain',
      locator: 'entity://structure/1TUP',
      deep_link_params: JSON.stringify({
        highlightGroups,
        representation: 'cartoon',
        colorMode: 'chain',
      }),
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const action = resolveReference(ref);
    expect(action).toEqual({
      tabType: 'structure',
      entityId: '1TUP',
      label: 'p53 binding domain',
      viewState: {
        highlightGroups,
        representation: 'cartoon',
        colorMode: 'chain',
      },
    });
  });

  it('resolves a structure with cameraSnapshot deep-link param', () => {
    const cameraSnapshot = JSON.stringify({
      position: [10, 20, 30],
      target: [0, 0, 0],
    });

    const ref: DBEntityReference = {
      id: 'ref-6',
      entity_type: 'structure',
      display_label: '1TUP overview',
      locator: 'entity://structure/1TUP',
      deep_link_params: JSON.stringify({ cameraSnapshot }),
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const action = resolveReference(ref);
    expect(action.viewState).toEqual({ cameraSnapshot });
  });

  it('resolves a structure with no deep-link params', () => {
    const ref: DBEntityReference = {
      id: 'ref-7',
      entity_type: 'structure',
      display_label: '1TUP',
      locator: 'entity://structure/1TUP',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const action = resolveReference(ref);
    expect(action).toEqual({
      tabType: 'structure',
      entityId: '1TUP',
      label: '1TUP',
      viewState: undefined,
    });
  });

  it('resolves a primer with 1-indexed → 0-indexed coordinate conversion', () => {
    const ref: DBEntityReference = {
      id: 'ref-primer',
      entity_type: 'primer',
      display_label: 'GFP_F1',
      locator: 'entity://primer/p1',
      deep_link_params: JSON.stringify({ bindingStart: 1204, bindingEnd: 1228 }),
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const action = resolveReference(ref);
    expect(action).toEqual({
      tabType: 'sequence',
      entityId: 'p1',
      label: 'GFP_F1',
      viewState: {
        scrollPosition: 1204,
        highlightRange: { start: 1203, end: 1227 },
      },
    });
  });

  it('opens a primer binding on its target sequence when the reference carries targetPath', () => {
    const ref: DBEntityReference = {
      id: 'ref-primer-target',
      entity_type: 'primer',
      display_label: 'qualification-primer-f1',
      locator: 'entity://primer/qualification-primer-f1',
      deep_link_params: JSON.stringify({ bindingStart: 121, bindingEnd: 137 }),
      data: JSON.stringify({
        name: 'qualification-primer-f1',
        targetPath: 'sequences/pUC19.gb',
      }),
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    expect(resolveReference(ref)).toEqual({
      tabType: 'sequence',
      entityId: 'qualification-primer-f1',
      label: 'qualification-primer-f1',
      viewState: {
        scrollPosition: 121,
        highlightRange: { start: 120, end: 136 },
      },
      legacySequenceSourcePath: '/workspace/lab/sequences/pUC19.gb',
    });
  });

  it('falls back to file tab for unknown entity types', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ref: DBEntityReference = {
      id: 'ref-4',
      entity_type: 'unknown_thing',
      display_label: 'Mystery',
      locator: 'entity://unknown/123',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const action = resolveReference(ref);
    expect(action.tabType).toBe('file');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown_thing'));

    warnSpy.mockRestore();
  });

  it('resolves a protein reference to a protein tab , entityId is the bare LIMS id', () => {
    const ref: DBEntityReference = {
      id: 'ref-6',
      entity_type: 'protein',
      display_label: 'GFP',
      locator: 'entity://protein/aa-uuid-1',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const action = resolveReference(ref);
    expect(action).toEqual({
      tabType: 'protein',
      entityId: 'aa-uuid-1',
      label: 'GFP',
      viewState: undefined,
    });
  });
});

describe('parseLocatorPath', () => {
  it('returns folder-prefixed relative path for git:// locators', () => {
    const result = parseLocatorPath('git://Lab Data/plasmids/pUC19.gb');
    expect(result).toBe('Lab Data/plasmids/pUC19.gb');
  });

  it('returns id for entity:// locators', () => {
    const result = parseLocatorPath('entity://primer/abc-123');
    expect(result).toBe('abc-123');
  });

  it('returns raw string for unrecognized locators', () => {
    const result = parseLocatorPath('/absolute/path/to/file.gb');
    expect(result).toBe('/absolute/path/to/file.gb');
  });

  it('strips @sha suffix from git:// locators', () => {
    const result = parseLocatorPath('git://workspace/path/file.gb@abc123');
    expect(result).toBe('workspace/path/file.gb');
  });
});
