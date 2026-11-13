// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  HOSTED_FS_ROOT,
  hostedAbsolutePath,
  hostedWorkspaceIdFromInput,
  hostedWorkspaceRoot,
  parseHostedFsPath,
} from './paths';

describe('hosted filesystem paths', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';

  it('round-trips a workspace file path', () => {
    const absolute = hostedAbsolutePath(workspaceId, 'sequences/one.gbk');
    expect(parseHostedFsPath(absolute)).toEqual({
      workspaceId,
      relativePath: 'sequences/one.gbk',
    });
    expect(parseHostedFsPath(HOSTED_FS_ROOT)).toEqual({ workspaceId: null, relativePath: '' });
    expect(parseHostedFsPath('/tmp/local')).toBeNull();
  });

  it('does not turn a desktop folder into a hosted workspace id', () => {
    expect(parseHostedFsPath('/Users/scientist/projects/wp-assets')).toBeNull();
    expect(parseHostedFsPath('/hosted//Users/scientist/projects/wp-assets')).toBeNull();
    expect(parseHostedFsPath('/hosted/hosted/' + workspaceId)).toBeNull();
    expect(hostedWorkspaceIdFromInput('/Users/scientist/projects/wp-assets')).toBeNull();
    expect(hostedWorkspaceIdFromInput('/hosted//Users/x')).toBeNull();
    expect(hostedWorkspaceIdFromInput(workspaceId)).toBe(workspaceId);
    expect(hostedWorkspaceIdFromInput(`/hosted/${workspaceId}`)).toBe(workspaceId);
    expect(hostedWorkspaceIdFromInput(`/hosted/${workspaceId}/sequences/a.gbk`)).toBe(workspaceId);
    expect(() => hostedWorkspaceRoot('/Users/scientist/projects/wp-assets')).toThrow(
      /UUID folders/u
    );
  });
});
