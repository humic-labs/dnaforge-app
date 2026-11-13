import { describe, expect, it } from 'vitest';

import {
  commandApprovalRule,
  commandProgram,
  displayApprovalCommand,
  displayApprovalPath,
  writeApprovalRule,
} from './approval-rules';

const roots = [
  { path: '/data/chats/conv-1', name: 'Chat files' },
  { path: '/data/chats/conv-1/My Project', name: 'My Project' },
  { path: '/data/projects/a', name: 'My Project' },
];

describe('approval rules', () => {
  it('names the program a command runs, through env assignments and shell wrappers', () => {
    expect(commandProgram('blastn -query in.fa')).toBe('blastn');
    expect(commandProgram('OMP_NUM_THREADS=4 /opt/bin/mafft --auto in.fa > out.fa')).toBe('mafft');
    expect(commandProgram("bash -lc 'cd x && diamond blastp -q in.fa'")).toBe('diamond');
    expect(commandProgram('cd /tmp')).toBe('cd');
    expect(commandProgram('/bin/zsh -c "pip install biopython"')).toBe('pip');
    expect(commandApprovalRule('mafft in.fa')).toEqual({
      key: 'command:mafft',
      label: 'mafft commands',
      catalogMessage: { key: 'approval.commandScope', values: { programs: 'mafft' } },
    });
    expect(commandApprovalRule('')).toEqual({ key: 'command-exact:', label: 'this exact command' });
  });

  it('names the program in a Codex shell wrapper whose script quotes a project path', () => {
    expect(
      commandApprovalRule(`/bin/zsh -lc "set -C\nprintf hi > 'My Project/hello.txt'"`)
    ).toEqual({
      key: 'command:printf',
      label: 'printf commands',
      catalogMessage: { key: 'approval.commandScope', values: { programs: 'printf' } },
    });
  });

  it('covers every program in a command, so an added program asks again', () => {
    expect(commandApprovalRule('cd run && blastn -query in.fa | sort')).toEqual({
      key: 'command:blastn+sort',
      label: 'blastn + sort commands',
      catalogMessage: { key: 'approval.commandScope', values: { programs: 'blastn + sort' } },
    });
    expect(commandApprovalRule("bash -lc 'blastn -q x && rm -rf ~/data'").key).toBe(
      'command:blastn+rm'
    );
    expect(commandApprovalRule('blastn -q x').key).not.toBe(
      commandApprovalRule('blastn -q x; curl https://example.test').key
    );
  });

  it('shows project names instead of storage paths', () => {
    expect(displayApprovalPath('/data/projects/a/analyses/out.fa', roots)).toBe(
      'My Project/analyses/out.fa'
    );
    expect(displayApprovalPath('/data/chats/conv-1/My Project/x.txt', roots)).toBe(
      'My Project/x.txt'
    );
    expect(displayApprovalPath('/data/chats/conv-1/run.sh', roots)).toBe('Chat files/run.sh');
    expect(displayApprovalPath('/elsewhere/file', roots)).toBe('/elsewhere/file');
    expect(displayApprovalCommand('cat /data/projects/a/in.fa', roots)).toBe(
      'cat My Project/in.fa'
    );
  });

  it('scopes write rules to the project that contains the path', () => {
    expect(writeApprovalRule('/data/projects/a/analyses/out.fa', roots)).toEqual({
      key: 'write:/data/projects/a',
      label: 'changes in My Project',
      catalogMessage: { key: 'approval.writeScope', values: { folder: 'My Project' } },
    });
    expect(writeApprovalRule('/elsewhere/dir/file', roots)).toEqual({
      key: 'write:/elsewhere/dir',
      label: 'changes in /elsewhere/dir',
      catalogMessage: { key: 'approval.writeScope', values: { folder: '/elsewhere/dir' } },
    });
  });
});
