import { describe, it, expect, beforeEach } from 'vitest';
import { resolveFilePath, resolveFilePathWithFallback } from './resolveFilePath';
import { parseLocatorPath, resolveReference } from '../features/ai/references/resolver';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { DBEntityReference } from '../db/entity-references';

describe('regression: chip click with missing folder prefix', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      folders: [
        {
          path: '/Users/scientist/workspace/replasmidgenotyping',
          name: 'replasmidgenotyping',
          addedAt: 0,
        },
        { path: '/Users/scientist/workspace/Dev Assets', name: 'Dev Assets', addedAt: 0 },
      ],
      activeWorkspaceFile: null,
    });
  });

  it('parseLocatorPath extracts path from git:// locator WITHOUT folder prefix', () => {
    const path = parseLocatorPath('git://data/cas9-validation/cas9-delivery-of-30-kb-for-7030.gb');
    expect(path).toBe('data/cas9-validation/cas9-delivery-of-30-kb-for-7030.gb');
  });

  it('resolveFilePathWithFallback resolves path missing folder prefix', () => {
    const rawPath = 'data/cas9-validation/cas9-delivery-of-30-kb-for-7030.gb';
    const resolved = resolveFilePathWithFallback(rawPath);

    expect(resolved.startsWith('/')).toBe(true);
    expect(
      resolved.startsWith('/Users/scientist/workspace/replasmidgenotyping/') ||
        resolved.startsWith('/Users/scientist/workspace/Dev Assets/')
    ).toBe(true);
  });

  it('full flow: resolveReference keeps stable sequence identity and isolates the legacy path', () => {
    const ref: DBEntityReference = {
      id: 'ref-cas9',
      entity_type: 'sequence',
      display_label: 'cas9-delivery-30kb',
      locator: 'git://data/cas9-validation/cas9-delivery-of-30-kb-for-7030.gb',
      deep_link_params: null,
      data: JSON.stringify({ documentId: 'fixture:sequence:cas9-delivery-30kb' }),
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const { entityId, legacySequenceSourcePath } = resolveReference(ref);
    expect(entityId).toBe('fixture:sequence:cas9-delivery-30kb');
    expect(legacySequenceSourcePath?.startsWith('/')).toBe(true);
    expect(legacySequenceSourcePath).toMatch(
      /data\/cas9-validation\/cas9-delivery-of-30-kb-for-7030\.gb$/
    );
  });

  it('resolveFilePathWithFallback result passes through resolveFilePath unchanged (simulating useFileContent)', () => {
    const rawPath = 'data/cas9-validation/cas9-delivery-of-30-kb-for-7030.gb';
    const fromClick = resolveFilePathWithFallback(rawPath);

    const fromViewer = resolveFilePath(fromClick);

    expect(fromViewer).toBe(fromClick);
  });
});
