import { expect, it } from 'vitest';
import { parseSequenceDataLayerPath } from './sequence-data-layer-path';

const id = `layer-${'a'.repeat(64)}`;
const member = `.dnaforge/sequence-data-layers/${id}.dnalayer.json`;

it.each(['/project/Engineering', 'C:/Projects/Engineering', '//server/share/Engineering'])(
  'preserves the exact absolute owning root %s',
  (workspaceRoot) => {
    expect(parseSequenceDataLayerPath(`${workspaceRoot}/${member}`)).toEqual({ workspaceRoot, id });
  }
);

it('preserves native Windows separators', () => {
  const workspaceRoot = 'C:\\Projects\\Engineering';
  expect(parseSequenceDataLayerPath(`${workspaceRoot}\\${member.replace(/\//gu, '\\')}`)).toEqual({
    workspaceRoot,
    id,
  });
});

it.each([
  member,
  `project/${member}`,
  `C:/${member}`.replace('/', ''),
  `\\project\\${member.replace(/\//gu, '\\')}`,
  `/project/../Engineering/${member}`,
  `/project/./Engineering/${member}`,
  `/project//Engineering/${member}`,
  `/project\\Engineering/${member}`,
  `/project\u0000/${member}`,
  `/project/${member}.bak`,
  `/project/${member.replace('.dnaforge/', '.waypoint/')}`,
  `/project/${member.replace(id, 'layer-invalid')}`,
  `/project/${member.replace(id, id.toUpperCase())}`,
])('refuses a path outside the exact canonical saved-layer shape: %s', (path) => {
  expect(parseSequenceDataLayerPath(path)).toBeNull();
});
