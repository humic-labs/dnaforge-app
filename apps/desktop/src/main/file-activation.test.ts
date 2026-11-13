import path from 'node:path';

import {
  FileActivationQueue,
  canonicalAssociationPath,
  extractAssociationPathsFromArgv,
  MCP_LAUNCH_ARG,
  shouldShowSecondInstanceError,
} from './file-activation';

describe(' file activation transport', () => {
  it('extracts ordinary supported paths from argv in first-seen order', () => {
    expect(
      extractAssociationPathsFromArgv(
        [
          '/Applications/DNAForge.app/Contents/MacOS/DNAForge',
          '--inspect=9223',
          'dnaforge://auth-callback?code=ignored',
          'folder/My design.gb',
          'folder/β construct.DNA',
          'notes.txt',
          'folder/My design.gb',
        ],
        '/Users/scientist'
      )
    ).toEqual([
      '/Users/scientist/folder/My design.gb',
      '/Users/scientist/folder/β construct.DNA',
      '/Users/scientist/folder/My design.gb',
    ]);
  });

  it('resolves Windows argv against the second-instance working directory', () => {
    expect(
      extractAssociationPathsFromArgv(
        ['C:\\Program Files\\DNAForge\\DNAForge.exe', 'inputs\\plasmid.gbk'],
        'D:\\Lab Work',
        'win32'
      )
    ).toEqual(['D:\\Lab Work\\inputs\\plasmid.gbk']);
  });

  it('suppresses the secondary-instance warning for supported file and protocol launches', () => {
    expect(shouldShowSecondInstanceError(true, ['D:\\Lab Work\\plasmid.gb'], null, [])).toBe(false);
    expect(shouldShowSecondInstanceError(true, [], 'dnaforge://auth-callback?code=ok', [])).toBe(
      false
    );
    expect(shouldShowSecondInstanceError(true, [], null, [])).toBe(true);
    expect(shouldShowSecondInstanceError(false, [], null, [])).toBe(false);
  });

  it('lets an MCP-launched second instance exit without a blocking dialog', () => {
    expect(
      shouldShowSecondInstanceError(true, [], null, ['/Applications/DNAForge', MCP_LAUNCH_ARG])
    ).toBe(false);
  });

  it('canonicalizes only registered extensions', () => {
    const realpath = (candidate: string): string => path.posix.normalize(candidate);
    expect(canonicalAssociationPath('/tmp/a/../design.gbff', '/tmp', 'darwin', realpath)).toBe(
      '/tmp/design.gbff'
    );
    expect(canonicalAssociationPath('/tmp/readme.txt', '/tmp', 'darwin', realpath)).toBeNull();
  });

  it('deduplicates the startup buffer, then admits later requests for the same path', () => {
    const queue = new FileActivationQueue({
      platform: 'darwin',
      cwd: '/tmp',
      realpath: (candidate) => path.posix.normalize(candidate),
    });

    expect(queue.enqueue(['/tmp/first.gb', '/tmp/nested/../first.gb', '/tmp/β.dna'])).toEqual([]);
    expect(queue.takePendingAndMarkReady()).toEqual([
      { deliveryId: 'file-activation-1', path: '/tmp/first.gb', familyId: 'genbank' },
      { deliveryId: 'file-activation-2', path: '/tmp/β.dna', familyId: 'snapgene' },
    ]);
    expect(queue.takePendingAndMarkReady()).toEqual([]);
    expect(queue.enqueue(['/tmp/first.gb', '/tmp/first.gb', '/tmp/later.genbank'])).toEqual([
      { deliveryId: 'file-activation-3', path: '/tmp/first.gb', familyId: 'genbank' },
      { deliveryId: 'file-activation-4', path: '/tmp/later.genbank', familyId: 'genbank' },
    ]);
    expect(queue.enqueue(['/tmp/first.gb'])).toEqual([
      { deliveryId: 'file-activation-5', path: '/tmp/first.gb', familyId: 'genbank' },
    ]);
  });

  it('rejects nonexistent paths without poisoning later delivery', () => {
    const queue = new FileActivationQueue({
      platform: 'darwin',
      cwd: '/tmp',
      realpath: (candidate) => {
        if (candidate.includes('missing')) throw new Error('ENOENT');
        return candidate;
      },
    });

    queue.takePendingAndMarkReady();
    expect(queue.enqueue(['/tmp/missing.gb', '/tmp/valid.gb'])).toEqual([
      { deliveryId: 'file-activation-1', path: '/tmp/valid.gb', familyId: 'genbank' },
    ]);
  });

  it('keeps case-distinct canonical files separate on case-sensitive macOS volumes', () => {
    const queue = new FileActivationQueue({
      platform: 'darwin',
      cwd: '/Volumes/case-sensitive',
      realpath: (candidate) => candidate,
    });
    queue.takePendingAndMarkReady();

    expect(queue.enqueue(['Design.gb', 'design.gb'])).toEqual([
      {
        deliveryId: 'file-activation-1',
        path: '/Volumes/case-sensitive/Design.gb',
        familyId: 'genbank',
      },
      {
        deliveryId: 'file-activation-2',
        path: '/Volumes/case-sensitive/design.gb',
        familyId: 'genbank',
      },
    ]);
  });
});
