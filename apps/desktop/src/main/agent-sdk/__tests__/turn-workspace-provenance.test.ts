import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWorkspaceProvenanceForTests,
  clearWorkspaceProvenanceForTurn,
  completedToolCallsForTurn,
  consumeWorkspaceProvenanceForTurn,
  openWorkspaceProvenanceForTurn,
  recordCompletedResourceRead,
  recordCompletedToolCall,
  workspaceProvenanceForTurn,
} from '../turn-workspace-provenance';

beforeEach(() => {
  __resetWorkspaceProvenanceForTests();
  openWorkspaceProvenanceForTurn('turn-1');
});

describe('turn workspace provenance', () => {
  it('reports a turn as NOT grounded when nothing ran', () => {
    expect(workspaceProvenanceForTurn('turn-1').grounded).toBe(false);
  });

  it('reports grounded once a workspace tool completes', () => {
    recordCompletedToolCall('turn-1', 'list_files');
    const provenance = workspaceProvenanceForTurn('turn-1');
    expect(provenance.grounded).toBe(true);
    expect(provenance.completedWorkspaceTools).toEqual(['list_files']);
  });

  it('does NOT count a UI-only tool as grounding', () => {
    recordCompletedToolCall('turn-1', 'highlight_range');
    expect(workspaceProvenanceForTurn('turn-1').grounded).toBe(false);
    expect(completedToolCallsForTurn('turn-1')).toEqual(['highlight_range']);
  });

  it('tracks every completed app tool separately from workspace grounding', () => {
    recordCompletedToolCall('turn-1', 'get_primer_tm_config');
    recordCompletedToolCall('turn-1', 'list_files');

    expect(completedToolCallsForTurn('turn-1')).toEqual(['get_primer_tm_config', 'list_files']);
    expect(workspaceProvenanceForTurn('turn-1').completedWorkspaceTools).toEqual(['list_files']);
  });

  it('does NOT count an app-wide settings read as workspace grounding', () => {
    recordCompletedToolCall('turn-1', 'get_primer_tm_config');
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: false,
      completedWorkspaceTools: [],
      completedWorkspaceResources: [],
    });
  });

  it('does NOT count a generic app-state observation as workspace-content grounding', () => {
    recordCompletedToolCall('turn-1', 'observe_app_state');
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: false,
      completedWorkspaceTools: [],
      completedWorkspaceResources: [],
    });
  });

  it('treats an unknown turn id as ungrounded rather than assuming', () => {
    recordCompletedToolCall('turn-1', 'list_files');
    expect(workspaceProvenanceForTurn('turn-does-not-exist').grounded).toBe(false);
  });

  it('treats a missing turn id as ungrounded', () => {
    recordCompletedToolCall(undefined, 'list_files');
    expect(workspaceProvenanceForTurn(undefined).grounded).toBe(false);
  });

  it('keeps turns independent so one turn cannot ground another', () => {
    openWorkspaceProvenanceForTurn('turn-a');
    openWorkspaceProvenanceForTurn('turn-b');
    recordCompletedToolCall('turn-a', 'list_files');
    expect(workspaceProvenanceForTurn('turn-a').grounded).toBe(true);
    expect(workspaceProvenanceForTurn('turn-b').grounded).toBe(false);
  });

  it('stops reporting grounded after the turn is cleared', () => {
    recordCompletedToolCall('turn-1', 'list_files');
    clearWorkspaceProvenanceForTurn('turn-1');
    expect(workspaceProvenanceForTurn('turn-1').grounded).toBe(false);
  });

  it('ignores late tool and resource completions after the turn is finalized', () => {
    clearWorkspaceProvenanceForTurn('turn-1');
    recordCompletedToolCall('turn-1', 'list_files');
    recordCompletedResourceRead('turn-1', 'selection-ref-late');
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: false,
      completedWorkspaceTools: [],
      completedWorkspaceResources: [],
    });
  });

  it('consumes a receipt exactly once', () => {
    recordCompletedToolCall('turn-1', 'list_files');
    expect(consumeWorkspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: true,
      completedWorkspaceTools: ['list_files'],
      completedWorkspaceResources: [],
    });
    expect(consumeWorkspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: false,
      completedWorkspaceTools: [],
      completedWorkspaceResources: [],
    });
  });

  it('records repeated calls in order', () => {
    recordCompletedToolCall('turn-1', 'list_files');
    recordCompletedToolCall('turn-1', 'find_features');
    expect(workspaceProvenanceForTurn('turn-1').completedWorkspaceTools).toEqual([
      'list_files',
      'find_features',
    ]);
  });

  it('counts read_file because it consulted real user data through the app', () => {
    recordCompletedToolCall('turn-1', 'read_file', { path: 'sequences/plasmid.gb' });
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: true,
      completedWorkspaceTools: ['read_file'],
      completedWorkspaceResources: [],
    });
  });

  it('does NOT count managed skill reads as workspace grounding', () => {
    recordCompletedToolCall('turn-1', 'read_file', { path: 'skill://primer-design/SKILL.md' });
    expect(workspaceProvenanceForTurn('turn-1').grounded).toBe(false);
    expect(completedToolCallsForTurn('turn-1')).toEqual(['read_file']);
  });

  it('counts staged-selection tools used by Ask AI about this', () => {
    recordCompletedToolCall('turn-1', 'selection_translate', { refId: 'selection-ref-1' });
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: true,
      completedWorkspaceTools: ['selection_translate'],
      completedWorkspaceResources: [],
    });
  });

  it('does NOT count selection compute over raw prompt input', () => {
    recordCompletedToolCall('turn-1', 'selection_translate', { sequence: 'ATG' });
    recordCompletedToolCall('turn-1', 'backtranslate', { sequence: 'M', host: 'E_COLI_K12' });
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: false,
      completedWorkspaceTools: [],
      completedWorkspaceResources: [],
    });
  });

  it('counts a registered-protein backtranslation because refId resolves app data', () => {
    recordCompletedToolCall('turn-1', 'backtranslate', {
      refId: 'registered-protein-1',
      host: 'E_COLI_K12',
    });
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: true,
      completedWorkspaceTools: ['backtranslate'],
      completedWorkspaceResources: [],
    });
  });

  it('counts get_workspace when the provider calls it during the turn', () => {
    recordCompletedToolCall('turn-1', 'get_workspace');
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: true,
      completedWorkspaceTools: ['get_workspace'],
      completedWorkspaceResources: [],
    });
  });

  it('counts app-backed tools whose workspace access is explicit manifest metadata', () => {
    recordCompletedToolCall('turn-1', 'virtual_digest', {
      path: '/workspace/pUC19.gb',
      enzymes: ['EcoRI'],
    });
    recordCompletedToolCall('turn-1', 'assembly.listEditableFields', {
      designId: 'design-1',
    });
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: true,
      completedWorkspaceTools: ['virtual_digest', 'assembly.listEditableFields'],
      completedWorkspaceResources: [],
    });
  });

  it('counts a successful staged-selection resource read as grounding', () => {
    recordCompletedResourceRead('turn-1', 'selection-ref-1');
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: true,
      completedWorkspaceTools: [],
      completedWorkspaceResources: ['waypoint://selection/selection-ref-1'],
    });
  });

  it('counts create_reference only when it resolves an app-owned staged reference', () => {
    recordCompletedToolCall('turn-1', 'create_reference', {
      entityType: 'structure',
      displayLabel: 'PDB 3OAA selection',
      selection: {
        kind: 'existing_reference',
        referenceId: 'staged-reference-1',
      },
    });
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: true,
      completedWorkspaceTools: ['create_reference'],
      completedWorkspaceResources: [],
    });
  });

  it('does not count a hand-authored create_reference locator as workspace grounding', () => {
    recordCompletedToolCall('turn-1', 'create_reference', {
      entityType: 'sequence',
      displayLabel: 'guide.gb',
      filePath: 'guide.gb',
    });
    expect(workspaceProvenanceForTurn('turn-1')).toEqual({
      grounded: false,
      completedWorkspaceTools: [],
      completedWorkspaceResources: [],
    });
  });

  it('does not grow without bound when turn ids leak', () => {
    for (let i = 0; i < 700; i += 1) {
      openWorkspaceProvenanceForTurn(`leak-${i}`);
      recordCompletedToolCall(`leak-${i}`, 'list_files');
    }

    expect(workspaceProvenanceForTurn('leak-699').grounded).toBe(true);
    expect(workspaceProvenanceForTurn('leak-0').grounded).toBe(false);
  });

  it('returns a copy so a caller cannot mutate the record', () => {
    recordCompletedToolCall('turn-1', 'list_files');
    workspaceProvenanceForTurn('turn-1').completedWorkspaceTools.push('forged_tool');
    expect(workspaceProvenanceForTurn('turn-1').completedWorkspaceTools).toEqual(['list_files']);
  });
});
