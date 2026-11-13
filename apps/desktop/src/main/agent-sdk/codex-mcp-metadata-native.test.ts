import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readCodexConfiguredMcpServerNames } from './detect';

it('reads the complete finite CLI configuration when metadata exceeds the default process buffer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mcp-metadata-'));
  try {
    const executable = join(root, 'metadata.cjs');
    await writeFile(
      executable,
      'process.stdout.write(JSON.stringify([{name:"personal.large",detail:"x".repeat(2*1024*1024)},{name:"dnaforge"}]));\n'
    );
    await expect(readCodexConfiguredMcpServerNames(executable)).resolves.toEqual([
      'dnaforge',
      'personal.large',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
