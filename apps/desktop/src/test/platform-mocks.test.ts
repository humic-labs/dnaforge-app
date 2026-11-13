// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MockFsModule, setMockFileContent } from './platform-mocks';

describe('MockFsModule.writeTextFile', () => {
  it('persists content that can be read back via readTextFile', async () => {
    await MockFsModule.writeTextFile('/test/file.gb', 'LOCUS test');
    const content = await MockFsModule.readTextFile('/test/file.gb');
    expect(content).toBe('LOCUS test');
  });

  it('overwrites previously set content', async () => {
    setMockFileContent('/test/overwrite.gb', 'original');
    await MockFsModule.writeTextFile('/test/overwrite.gb', 'updated');
    const content = await MockFsModule.readTextFile('/test/overwrite.gb');
    expect(content).toBe('updated');
  });
});
