import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Benchling tutorial media packaging', () => {
  const builderConfig = readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8');
  const packageVerifier = readFileSync(
    resolve(__dirname, '../../scripts/verify-package.cjs'),
    'utf8'
  );

  it('unpacks MP4 assets and verifies the packaged tutorial bytes', () => {
    expect(builderConfig).toContain("- 'out/renderer/assets/*.mp4'");
    expect(packageVerifier).toContain('benchling-export-flow-');
    expect(packageVerifier).toContain('Benchling tutorial media is unpacked');
  });
});
