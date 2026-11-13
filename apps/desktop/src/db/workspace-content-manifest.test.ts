// @vitest-environment node

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_CONTENT_KINDS,
  kindForPath,
  violationForPath,
} from './workspace-content-manifest';
import { scanWorkspaceShape } from './scan-workspace-shape';

const TEMPLATE = join(__dirname, '../../resources/sample-workspaces/standard-samples/workspace');

describe('workspace content manifest', () => {
  it('declares a shape and a rationale for every kind', () => {
    expect(WORKSPACE_CONTENT_KINDS.length).toBeGreaterThan(0);
    for (const spec of WORKSPACE_CONTENT_KINDS) {
      expect(spec.extensions.length, `${spec.kind} declares no extensions`).toBeGreaterThan(0);
      expect(spec.rationale.length, `${spec.kind} has no rationale`).toBeGreaterThan(30);
      if (spec.form === 'package') {
        expect(spec.markerFile, `${spec.kind} is a package with no marker file`).toBeTruthy();
      }
    }
  });

  it('classifies a GenBank file as a plasmid', () => {
    expect(kindForPath('sequences/pUC19.gb')?.kind).toBe('sequence');
    expect(kindForPath('a/b/thing.gbk')?.kind).toBe('sequence');
  });

  it('classifies a primer artifact as a loose file, not a package', () => {
    const spec = kindForPath('primers/p1.primer.json');
    expect(spec?.kind).toBe('primer');
    expect(spec?.form).toBe('file');
  });

  it('leaves unmanaged user content alone', () => {
    expect(kindForPath('notes/plate-reader.xlsx')).toBeNull();
    expect(kindForPath('paper.pdf')).toBeNull();
    expect(violationForPath({ relativePath: 'paper.pdf', insidePackage: false })).toBeNull();
  });

  it('🟥 flags a LOOSE GenBank file as a violation', () => {
    const v = violationForPath({ relativePath: 'sequences/E1010m_CD.gb', insidePackage: false });
    expect(v).not.toBeNull();
    expect(v?.kind).toBe('sequence');
    expect(v?.expected).toBe('package');
  });

  it('accepts the SAME file inside its package', () => {
    expect(
      violationForPath({
        relativePath: 'sequences/E1010m_CD/E1010m_CD.gb',
        insidePackage: true,
      })
    ).toBeNull();
  });

  it('never judges anything under the .forge marker directory', () => {
    expect(
      violationForPath({ relativePath: 'x/.forge/plasmid.json', insidePackage: true })
    ).toBeNull();
  });

  it('does not require a loose-form kind to be packaged', () => {
    expect(
      violationForPath({ relativePath: 'primers/p1.primer.json', insidePackage: false })
    ).toBeNull();
  });
});

describe('🟥 the SHIPPED sample template obeys the manifest', () => {
  it('exists, so this gate cannot pass vacuously', () => {
    expect(existsSync(TEMPLATE), `template missing at ${TEMPLATE}`).toBe(true);
  });

  it('contains no content in an illegal shape', () => {
    const violations = scanWorkspaceShape(TEMPLATE);
    const report = violations
      .slice(0, 25)
      .map((v) => `  ${v.path}\n    ${v.reason}`)
      .join('\n');
    expect(
      violations,
      `${violations.length} shipped file(s) are in a shape the app does not produce:\n${report}`
    ).toEqual([]);
  });
});
