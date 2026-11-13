import { describe, expect, it } from 'vitest';
import { resolveFocusedDeepShareRow } from './DeepShareControl';

const sequenceRow = {
  repo_uuid: 'workspace-1',
  artifact_id: 'sequence-1',
  artifact_type: 'sequence',
  file_path: '/workspace/pUC19/pUC19.gb',
  file_kind: 'waypoint-sequence',
};

describe('resolveFocusedDeepShareRow', () => {
  it('resolves an exact current catalog file', () => {
    expect(resolveFocusedDeepShareRow([sequenceRow], sequenceRow.file_path)).toEqual(sequenceRow);
  });

  it('resolves the catalog entity carried by an open artifact tab', () => {
    expect(resolveFocusedDeepShareRow([sequenceRow], sequenceRow.artifact_id)).toEqual(sequenceRow);
  });

  it('maps a rendered sequence-package row to its product-file binding', () => {
    expect(resolveFocusedDeepShareRow([sequenceRow], '/workspace/pUC19', true)).toEqual(
      sequenceRow
    );
  });

  it('does not treat an ordinary parent folder as an artifact', () => {
    expect(resolveFocusedDeepShareRow([sequenceRow], '/workspace/pUC19', false)).toBeNull();
  });

  it('normalizes Windows separators at the package boundary', () => {
    const windows = { ...sequenceRow, file_path: 'C:\\workspace\\pUC19\\pUC19.gb' };
    expect(resolveFocusedDeepShareRow([windows], 'C:\\workspace\\pUC19\\', true)).toEqual(windows);
  });
});
