import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  restorePrimerArtifactBytes,
  rewriteAffectedPrimerArtifacts,
} from '../relocate-primer-artifacts';

function primerArtifact(selfRel: string, targetRels: string[] = []): string {
  return JSON.stringify({
    schema: 'dnaforge.primer',
    schemaVersion: 1,
    id: 'p',
    name: 'p',
    file: { workspaceRelativePath: selfRel },
    bindings: targetRels.map((rel, i) => ({
      id: `b${i}`,
      relation: 'binds_to_sequence',
      target: { workspaceRelativePath: rel },
    })),
  });
}
const readSelf = (p: string) =>
  JSON.parse(readFileSync(p, 'utf8')).file.workspaceRelativePath as string;
const readTargets = (p: string) =>
  (
    JSON.parse(readFileSync(p, 'utf8')).bindings as Array<{
      target: { workspaceRelativePath: string };
    }>
  ).map((b) => b.target.workspaceRelativePath);

describe('rewriteAffectedPrimerArtifacts', () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'reloc-primer-'));
    mkdirSync(join(ws, 'primers'), { recursive: true });
  });

  it('(a) rewrites the moved primer file’s own workspaceRelativePath', () => {
    mkdirSync(join(ws, 'primers', 'moved'), { recursive: true });
    const p = join(ws, 'primers', 'moved', 'x.primer.json');
    writeFileSync(p, primerArtifact('primers/old/x.primer.json'));
    const r = rewriteAffectedPrimerArtifacts({
      workspaceRoot: ws,
      oldAbs: join(ws, 'primers/old'),
      newAbs: join(ws, 'primers/moved'),
    });
    expect(r.rewritten).toBe(1);
    expect(readSelf(p)).toBe('primers/moved/x.primer.json');
  });

  it('(b) rewrites a binding target when the bound .gb moved (primer itself unmoved)', () => {
    const p = join(ws, 'primers', 'a.primer.json');
    writeFileSync(p, primerArtifact('primers/a.primer.json', ['seqs/target.gb', 'other/keep.gb']));
    const r = rewriteAffectedPrimerArtifacts({
      workspaceRoot: ws,
      oldAbs: join(ws, 'seqs'),
      newAbs: join(ws, 'moved'),
    });
    expect(r.rewritten).toBe(1);
    expect(readSelf(p)).toBe('primers/a.primer.json');
    expect(readTargets(p)).toEqual(['moved/target.gb', 'other/keep.gb']);
  });

  it('(c) leaves unaffected artifacts untouched, (d) returns original bytes for compensation', () => {
    const affected = join(ws, 'primers', 'a.primer.json');
    const untouched = join(ws, 'primers', 'b.primer.json');
    writeFileSync(affected, primerArtifact('seqs/a.primer.json'));
    const untouchedRaw = primerArtifact('primers/b.primer.json');
    writeFileSync(untouched, untouchedRaw);

    const r = rewriteAffectedPrimerArtifacts({
      workspaceRoot: ws,
      oldAbs: join(ws, 'seqs'),
      newAbs: join(ws, 'moved'),
    });
    expect(r.rewritten).toBe(1);
    expect(readFileSync(untouched, 'utf8')).toBe(untouchedRaw);
    expect(r.originalBytes.has(affected)).toBe(true);
    expect(JSON.parse(r.originalBytes.get(affected)!).file.workspaceRelativePath).toBe(
      'seqs/a.primer.json'
    );
    restorePrimerArtifactBytes(r.originalBytes);
    expect(readSelf(affected)).toBe('seqs/a.primer.json');
  });

  it('(e) leaves no .reloc.tmp sibling after a successful atomic write', () => {
    const p = join(ws, 'primers', 'a.primer.json');
    writeFileSync(p, primerArtifact('seqs/a.primer.json'));
    rewriteAffectedPrimerArtifacts({
      workspaceRoot: ws,
      oldAbs: join(ws, 'seqs'),
      newAbs: join(ws, 'moved'),
    });
    expect(existsSync(`${p}.reloc.tmp`)).toBe(false);
  });

  it('(f) rewrites a workspace-scoped primer file regardless of any DB workspaceId (closes the DB-skip residual)', () => {
    const p = join(ws, 'primers', 'nullws.primer.json');
    writeFileSync(p, primerArtifact('primers/old/nullws.primer.json'));
    const r = rewriteAffectedPrimerArtifacts({
      workspaceRoot: ws,
      oldAbs: join(ws, 'primers/old'),
      newAbs: join(ws, 'primers/new'),
    });
    expect(r.rewritten).toBe(1);
    expect(readSelf(p)).toBe('primers/new/nullws.primer.json');
  });

  it('(g) an unwritable artifact does NOT abort the batch — other files still rebase, it is skipped', () => {
    const blocked = join(ws, 'primers', 'blocked.primer.json');
    const ok = join(ws, 'primers', 'ok.primer.json');
    writeFileSync(blocked, primerArtifact('seqs/blocked.gb'));
    writeFileSync(ok, primerArtifact('seqs/ok.gb'));
    mkdirSync(`${blocked}.reloc.tmp`, { recursive: true });

    let r: ReturnType<typeof rewriteAffectedPrimerArtifacts> | undefined;
    expect(() => {
      r = rewriteAffectedPrimerArtifacts({
        workspaceRoot: ws,
        oldAbs: join(ws, 'seqs'),
        newAbs: join(ws, 'moved'),
      });
    }).not.toThrow();

    expect(r!.rewritten).toBe(1);
    expect(readSelf(ok)).toBe('moved/ok.gb');
    expect(readSelf(blocked)).toBe('seqs/blocked.gb');
    expect(r!.originalBytes.has(blocked)).toBe(false);
    expect(r!.originalBytes.has(ok)).toBe(true);
    expect(r!.failedPaths).toEqual([blocked]);
  });
});
