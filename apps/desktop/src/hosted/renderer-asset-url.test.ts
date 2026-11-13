// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { resolveRendererAssetUrl } from './renderer-asset-url';

describe('resolveRendererAssetUrl', () => {
  it('keeps packaged Electron assets relative to the loaded renderer document', () => {
    expect(
      resolveRendererAssetUrl({
        path: 'data/rebase/merged-enzymes.json',
        documentUrl:
          'file:///Applications/DNAForge.app/Contents/Resources/app.asar/out/renderer/index.html',
        baseUrl: '/',
        hostedBrowser: false,
      })
    ).toBe(
      'file:///Applications/DNAForge.app/Contents/Resources/app.asar/out/renderer/data/rebase/merged-enzymes.json'
    );
  });

  it('uses the published hosted prefix for the static Next surface', () => {
    expect(
      resolveRendererAssetUrl({
        path: '/data/rebase/merged-enzymes.json',
        documentUrl: 'http://127.0.0.1:3198/hosted.html',
        baseUrl: '/hosted/',
        hostedBrowser: true,
      })
    ).toBe('http://127.0.0.1:3198/hosted/data/rebase/merged-enzymes.json');
  });

  it('uses the document path when Vite development keeps its base at root', () => {
    expect(
      resolveRendererAssetUrl({
        path: 'data/rebase/merged-enzymes.json',
        documentUrl: 'http://127.0.0.1:1420/hosted.html',
        baseUrl: '/',
        hostedBrowser: true,
      })
    ).toBe('http://127.0.0.1:1420/hosted/data/rebase/merged-enzymes.json');
  });
});
