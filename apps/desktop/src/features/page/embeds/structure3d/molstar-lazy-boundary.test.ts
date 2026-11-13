import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

describe('optional Mol* runtime boundary', () => {
  it('loads the heavy viewer only through the explicit lazy component', () => {
    const lazyBoundary = source('./LazyMolstarViewer.tsx');
    const loadedViewer = source('./components/LoadedViewer.tsx');
    const panel = source('./components/Structure3dPanel.tsx');

    expect(lazyBoundary).toContain("await import('./MolstarViewer')");
    expect(loadedViewer).not.toMatch(/from ['"]\.\.\/MolstarViewer['"]/);
    expect(panel).not.toMatch(/from ['"]\.\.\/MolstarViewer['"]/);
  });

  it('places the feature boundary before 3D panel and embed interaction hooks', () => {
    const lazyPanel = source('./components/LazyStructure3dPanel.tsx');
    const lazyEmbed = source('./components/LazyLoadedViewer.tsx');
    const panelContent = source('../../../canvas/components/PanelContent.tsx');
    const structureFile = source('../../../structure-files/StructureFileTabContent.tsx');
    const drawer = source('../../../structure-drawer/components/StructureDrawerContent.tsx');
    const embedRenderer = source('./Renderer.tsx');

    expect(lazyPanel).toContain("await import('./Structure3dPanel')");
    expect(lazyEmbed).toContain("await import('./LoadedViewer')");
    expect(panelContent).not.toContain("components/Structure3dPanel'");
    expect(structureFile).not.toContain("components/Structure3dPanel'");
    expect(drawer).not.toContain("components/Structure3dPanel'");
    expect(embedRenderer).not.toContain("components/LoadedViewer'");
  });

  it('keeps always-mounted canvas code off the heavy compatibility barrel', () => {
    const portalManager = source('../../../canvas/components/TabContentPortalManager.tsx');
    const projection = source('../../../structure-drawer/utils/to-structure-attrs.ts');

    expect(portalManager).toContain("embeds/structure3d/molstar/cache'");
    expect(projection).toContain("embeds/structure3d/molstar/cache'");
    expect(portalManager).not.toContain("embeds/structure3d/viewerCache'");
    expect(projection).not.toContain("embeds/structure3d/viewerCache'");
  });
});
