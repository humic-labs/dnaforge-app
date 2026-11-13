import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export function hostedOfflinePlugin(base: string): Plugin {
  return {
    name: 'hosted-offline-shell',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const assets = [
          '/hosted.html',
          ...Object.keys(bundle)
            .filter((name) => name.startsWith('assets/') && !name.endsWith('.map'))
            .sort()
            .map((name) => `${base}${name}`),
        ];
        const template = readFileSync(
          resolve(__dirname, '../src/hosted/offline-worker.js'),
          'utf8'
        );
        const version = createHash('sha256')
          .update(template)
          .update(JSON.stringify(assets))
          .digest('hex')
          .slice(0, 20);
        this.emitFile({
          type: 'asset',
          fileName: 'offline-worker.js',
          source: `const SHELL_ASSETS = ${JSON.stringify(assets)};\nconst SHELL_CACHE = ${JSON.stringify(`dnaforge-hosted-shell-${version}`)};\n${template}`,
        });
      },
    },
  };
}
