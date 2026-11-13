import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { digestGeneratedTree, extractGeneratedMethodUnion, hashFramedFiles } from './provenance';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(HERE, 'generated');

describe('codex-app-server-contract manifest', () => {
  it('pins the exact accepted App Server version', () => {
    expect(manifest.codexAppServerVersion).toBe('0.148.0');
    expect(manifest.upstream.tag).toBe('rust-v0.148.0');
    expect(manifest.upstream.commit).toBe('3ba0f711642a888aec92a611a3f3b2211157ff89');
  });

  it('binds the checked-in generated tree by relative path and file boundary', () => {
    expect(manifest.generation.command).toBe(
      'codex app-server generate-ts --experimental --out <dir>'
    );
    expect(manifest.generation.schemaDigestAlgorithm).toBe(
      'sha256-length-framed-relative-path-and-content-v1'
    );
    expect(digestGeneratedTree(GENERATED_DIR)).toBe(manifest.generation.schemaDigestSha256);

    expect(hashFramedFiles([{ relativePath: 'a', content: Buffer.from('bc') }])).not.toBe(
      hashFramedFiles([{ relativePath: 'ab', content: Buffer.from('c') }])
    );
  });

  it('records the exact generated method unions without claiming authority', () => {
    const generated = {
      client: extractGeneratedMethodUnion(
        readFileSync(path.join(GENERATED_DIR, 'ClientRequest.ts'), 'utf8')
      ),
      server: extractGeneratedMethodUnion(
        readFileSync(path.join(GENERATED_DIR, 'ServerRequest.ts'), 'utf8')
      ),
      notification: extractGeneratedMethodUnion(
        readFileSync(path.join(GENERATED_DIR, 'ServerNotification.ts'), 'utf8')
      ),
    };

    expect(manifest.upstreamProtocolMethods).toEqual(generated);
    expect(manifest.upstreamProtocolMethods.client).toContain('initialize');
    expect(manifest.upstreamProtocolMethods.client).toContain('fs/writeFile');
    expect(manifest.upstreamProtocolMethods.server).toContain('item/tool/call');
    expect(manifest.upstreamProtocolMethods.notification).toContain('turn/completed');
  });

  it('records complete immutable package inventories for all six targets', () => {
    expect(Object.keys(manifest.supportedTargets).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);

    for (const target of Object.values(manifest.supportedTargets)) {
      expect(target.verified).toBe(true);
      expect(target.npmPackageTarball).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(target.npmPackageIntegrity).toMatch(/^sha512-/);
      expect(target.npmPackageShasum).toMatch(/^[0-9a-f]{40}$/);
      expect(target.resources.length).toBeGreaterThanOrEqual(5);
      expect(new Set(target.resources.map((entry) => entry.pathInPackage)).size).toBe(
        target.resources.length
      );
      for (const resource of target.resources) {
        expect(resource.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof resource.executable).toBe('boolean');
      }
      expect(target.resources.map((entry) => entry.pathInPackage)).toContain(
        target.codexBinaryPathInPackage
      );
      expect(target.resources.map((entry) => entry.pathInPackage)).toContain(
        target.codexPackageJsonPathInPackage
      );
      expect(
        target.resources.find((entry) => entry.pathInPackage === target.codexBinaryPathInPackage)
          ?.sha256
      ).toBe(target.codexBinarySha256);
      expect(
        target.resources.find(
          (entry) => entry.pathInPackage === target.codexPackageJsonPathInPackage
        )?.sha256
      ).toBe(target.codexPackageJsonSha256);
    }
  });

  it('ships the pinned upstream license and DNAForge notice', () => {
    expect(manifest.license.spdx).toBe('Apache-2.0');
    for (const entry of manifest.license.files) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      const content = readFileSync(path.join(HERE, '..', entry.path));
      expect(content.length).toBeGreaterThan(100);
      expect(createHash('sha256').update(content).digest('hex')).toBe(entry.sha256);
    }
  });

  it('keeps every pinned license file free of end-of-line rewriting on checkout', () => {
    for (const entry of manifest.license.files) {
      const attributes = execFileSync(
        'git',
        [
          'check-attr',
          'text',
          'eol',
          '--',
          path.join('packages/core/codex-app-server-contract', entry.path),
        ],
        { cwd: path.join(HERE, '..', '..', '..', '..'), encoding: 'utf8' }
      );
      expect(attributes).toContain(': text: set');
      expect(attributes).toContain(': eol: lf');
    }
  });
});
