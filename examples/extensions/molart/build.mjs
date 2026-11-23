import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('./', import.meta.url);
const license = await readFile(new URL('upstream/LICENSE', directory), 'utf8');
const bundled = await build({
  absWorkingDir: fileURLToPath(directory),
  entryPoints: ['worker.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  banner: { js: `/*\n${license}\n*/` },
});
const manifest = {
  schemaVersion: 1,
  id: 'org.molart.klimt',
  label: 'MolArt · Klimt',
  kind: 'protein-representation',
  source: {
    repository: 'https://github.com/martin-steinegger/molart',
    revision: '712b984b42b51b314badd869155f0d1842e34822',
    license: 'MIT',
  },
  workerSource: bundled.outputFiles[0].text,
};
const output = new URL('dist/klimt.dnaforge-extension.json', directory);
await mkdir(new URL('dist/', directory), { recursive: true });
await writeFile(output, JSON.stringify(manifest) + '\n');
console.log(fileURLToPath(output));
