import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyTabularSourceIntoWorkspace } from './tabular-file-copy';

const importFile = vi.fn(async () => ({
  destPath: '/ws/a.csv',
  relPath: 'a.csv',
  committed: true,
}));
const importFileFromContent = vi.fn(async () => ({
  destPath: '/ws/a.xlsx',
  relPath: 'a.xlsx',
  committed: true,
}));
vi.mock('../../../platform', () => ({
  platform: () => ({ workspace: { importFile, importFileFromContent } }),
}));

describe('copyTabularSourceIntoWorkspace — routes source bytes to the right writer ', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a native path → plain copy (importFile), never a content write', async () => {
    await copyTabularSourceIntoWorkspace('/ws', { fileName: 'a.csv', sourcePath: '/disk/a.csv' });
    expect(importFile).toHaveBeenCalledWith({ sourcePath: '/disk/a.csv', targetRoot: '/ws' });
    expect(importFileFromContent).not.toHaveBeenCalled();
  });

  it('a dropped BINARY xlsx (arrayBuffer) → content write via contentBytes (never utf8 text)', async () => {
    const buf = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
    await copyTabularSourceIntoWorkspace('/ws', { fileName: 'a.xlsx', arrayBuffer: buf });
    expect(importFileFromContent).toHaveBeenCalledWith({
      targetRoot: '/ws',
      fileName: 'a.xlsx',
      contentBytes: buf,
    });
    expect(importFileFromContent.mock.calls[0][0]).not.toHaveProperty('content');
    expect(importFile).not.toHaveBeenCalled();
  });

  it('dropped TEXT (csv content, no path) → content write via text', async () => {
    await copyTabularSourceIntoWorkspace('/ws', { fileName: 'a.csv', text: 'Name,Seq\nP1,ACGT' });
    expect(importFileFromContent).toHaveBeenCalledWith({
      targetRoot: '/ws',
      fileName: 'a.csv',
      content: 'Name,Seq\nP1,ACGT',
    });
    expect(importFile).not.toHaveBeenCalled();
  });

  it('a native path WINS over in-hand bytes (prefer the real file)', async () => {
    await copyTabularSourceIntoWorkspace('/ws', {
      fileName: 'a.csv',
      sourcePath: '/disk/a.csv',
      text: 'ignored',
      arrayBuffer: new Uint8Array([1]).buffer,
    });
    expect(importFile).toHaveBeenCalledTimes(1);
    expect(importFileFromContent).not.toHaveBeenCalled();
  });

  it('no bytes at all → throws (never a silent empty write)', async () => {
    await expect(copyTabularSourceIntoWorkspace('/ws', { fileName: 'a.csv' })).rejects.toThrow(
      /No source bytes/i
    );
  });
});
