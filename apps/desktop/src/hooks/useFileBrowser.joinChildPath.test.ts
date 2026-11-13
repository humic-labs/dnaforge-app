import { describe, expect, it } from 'vitest';

import { joinChildPath } from './useFileBrowser';

describe('joinChildPath  separator consistency)', () => {
  it('preserves the backslash separator for Windows paths', () => {
    expect(joinChildPath('C:\\Users\\user\\project', 'seq.gb')).toBe(
      'C:\\Users\\user\\project\\seq.gb'
    );
    expect(joinChildPath('C:\\ws\\sub', 'a.gb')).toBe('C:\\ws\\sub\\a.gb');
  });

  it('uses a forward slash for POSIX paths', () => {
    expect(joinChildPath('/home/user/project', 'seq.gb')).toBe('/home/user/project/seq.gb');
    expect(joinChildPath('/ws', 'notes')).toBe('/ws/notes');
  });

  it('joins at a Windows drive root without doubling the separator', () => {
    expect(joinChildPath('C:\\', 'seq.gb')).toBe('C:\\seq.gb');
  });

  it('never emits a MIXED-separator path — the exact  regression', () => {
    const win = joinChildPath('C:\\Users\\user\\project', 'seq.gb');
    expect(win.includes('/')).toBe(false);

    const posix = joinChildPath('/home/user/project', 'seq.gb');
    expect(posix.includes('\\')).toBe(false);
  });

  it('falls back to `/` when the parent already contains both separators', () => {
    expect(joinChildPath('C:/ws/sub', 'x.gb')).toBe('C:/ws/sub/x.gb');
  });
});
