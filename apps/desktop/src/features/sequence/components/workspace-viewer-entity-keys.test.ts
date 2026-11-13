// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  workspaceViewerEntityKeys,
  workspaceViewerOwnsTabCommands,
} from './workspace-viewer-entity-keys';

describe('workspace viewer tab command ownership', () => {
  it.each([
    ['sequence', 'sequence', true],
    ['assembly', 'design', true],
    ['sequence', 'design', false],
    ['assembly', 'sequence', false],
  ] as const)('routes %s shortcuts to the matching %s tab: %s', (surface, type, expected) => {
    expect(workspaceViewerOwnsTabCommands(surface, 'owner', { type, entityId: 'owner' })).toBe(
      expected
    );
  });

  it('does not route shortcuts to another pane or an absent tab', () => {
    expect(
      workspaceViewerOwnsTabCommands('assembly', 'owner', { type: 'design', entityId: 'other' })
    ).toBe(false);
    expect(workspaceViewerOwnsTabCommands('sequence', 'owner', undefined)).toBe(false);
    expect(
      workspaceViewerOwnsTabCommands('sequence', undefined, {
        type: 'sequence',
        entityId: 'owner',
      })
    ).toBe(false);
  });
});

describe('workspaceViewerEntityKeys', () => {
  it('prefers the tab entity id for every derived key', () => {
    expect(workspaceViewerEntityKeys('tab-1', 'seq-1', 'plasmid')).toEqual({
      tabStateKey: 'tab-1',
      sequenceViewportScopeKey: 'tab-1',
      residueSelectionReferenceId: 'tab-1',
      commandEntityId: 'tab-1',
      cutSitesScopeKey: 'tab-1',
    });
  });

  it('falls back to sequence id, then plasmid name, then empty/null', () => {
    expect(workspaceViewerEntityKeys(undefined, 'seq-1', 'plasmid')).toEqual({
      tabStateKey: '',
      sequenceViewportScopeKey: 'seq-1',
      residueSelectionReferenceId: 'seq-1',
      commandEntityId: 'seq-1',
      cutSitesScopeKey: 'seq-1',
    });
    expect(workspaceViewerEntityKeys(undefined, undefined, 'plasmid')).toEqual({
      tabStateKey: '',
      sequenceViewportScopeKey: 'plasmid',
      residueSelectionReferenceId: 'plasmid',
      commandEntityId: 'plasmid',
      cutSitesScopeKey: 'plasmid',
    });
    expect(workspaceViewerEntityKeys(undefined, undefined, undefined)).toEqual({
      tabStateKey: '',
      sequenceViewportScopeKey: '',
      residueSelectionReferenceId: null,
      commandEntityId: undefined,
      cutSitesScopeKey: undefined,
    });
  });
});
