import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = join(__dirname, '../..');

describe('assembly protein search IPC surface', () => {
  it('exposes read-only query and cancellation without renderer-facing preparation', () => {
    const main = readFileSync(join(__dirname, 'genome-data.ts'), 'utf8');
    const preload = readFileSync(join(desktopRoot, 'preload/indexed-genome-ipc.ts'), 'utf8');
    const preloadTypes = readFileSync(join(desktopRoot, 'preload/index.d.ts'), 'utf8');
    const electronPlatform = readFileSync(join(desktopRoot, 'platform/electron.ts'), 'utf8');
    const platformContract = readFileSync(join(desktopRoot, 'platform/index.ts'), 'utf8');
    const browserMock = readFileSync(join(desktopRoot, 'platform/browser-mock.ts'), 'utf8');

    expect(main).toContain("'genome:queryAssemblyAnnotationSearch'");
    expect(main).toContain("'genome:cancelAssemblyAnnotationSearch'");
    expect(main).toContain("'genome:queryAssemblyProteinSearch'");
    expect(main).toContain("'genome:cancelAssemblyProteinSearch'");
    expect(main).not.toContain("'genome:prepareAssemblyAnnotationSearch'");
    expect(main).not.toContain("'genome:prepareAssemblyProteinSearch'");
    const annotationQueryStart = main.indexOf("'genome:queryAssemblyAnnotationSearch'");
    const annotationCancelStart = main.indexOf("'genome:cancelAssemblyAnnotationSearch'");
    const queryStart = main.indexOf("'genome:queryAssemblyProteinSearch'");
    const proteinCancelStart = main.indexOf("'genome:cancelAssemblyProteinSearch'");
    expect(main.slice(annotationQueryStart, annotationCancelStart)).toContain(
      'assemblyAnnotationSearchQueryLifecycle.begin'
    );
    expect(main.slice(annotationQueryStart, annotationCancelStart)).not.toContain(
      'assemblyProteinSearchQueryLifecycle.begin'
    );
    expect(main.slice(queryStart, proteinCancelStart)).toContain(
      'assemblyProteinSearchQueryLifecycle.begin'
    );
    expect(main.slice(queryStart, proteinCancelStart)).not.toContain(
      'assemblyAnnotationSearchQueryLifecycle.begin'
    );

    expect(preload).toContain("rendererIpc.invoke('genome:queryAssemblyAnnotationSearch', input)");
    expect(preload).toContain("rendererIpc.invoke('genome:cancelAssemblyAnnotationSearch', input)");
    expect(preload).toContain("rendererIpc.invoke('genome:queryAssemblyProteinSearch', input)");
    expect(preload).toContain("rendererIpc.invoke('genome:cancelAssemblyProteinSearch', input)");
    expect(preload).not.toContain('prepareAssemblyAnnotationSearch');
    expect(preload).not.toContain('prepareAssemblyProteinSearch');
    for (const surface of [preloadTypes, electronPlatform, platformContract, browserMock]) {
      expect(surface).not.toContain('prepareAssemblyAnnotationSearch');
      expect(surface).not.toContain('prepareAssemblyProteinSearch');
    }
  });
});
