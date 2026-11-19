import { useCallback, useMemo, useState } from 'react';
import { getStructureFileFormat } from '../../shared/scientific-file-types';
import { SOFT_WARN_BYTES } from '../../shared/oversized-guard';
import { LazyMolstarViewer } from '../page/public/embeds/structure3d/LazyMolstarViewer';
import type { MolstarPlugin } from '../page/public/embeds/structure3d/molstar/cache';
import { useDisplayedSnapshot, usePreviewSource, type PreviewProps } from './use-preview-source';

function readCoordinates(bytes: Uint8Array, path: string) {
  const format = getStructureFileFormat(path);
  if (!format) throw new Error('Unrecognized coordinate file format.');
  if (!bytes.length) throw new Error('The coordinate file is empty.');
  const data =
    format.encoding === 'binary' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (typeof data === 'string') {
    const hasAtoms =
      format.parser === 'pdb'
        ? /^(?:ATOM  |HETATM)/m.test(data)
        : /^\s*_atom_site[._]/im.test(data);
    if (!hasAtoms) throw new Error('This file contains no macromolecular atom coordinates.');
  }
  return { data, format: format.parser };
}

function CoordinateViewer({
  document,
  sha256,
  onSnapshot,
}: {
  document: ReturnType<typeof readCoordinates>;
  sha256: string;
  onSnapshot?: PreviewProps['onSnapshot'];
}) {
  const [plugin, setPlugin] = useState<MolstarPlugin | null>(null);
  const [ready, setReady] = useState(false);
  const loaded = useCallback(() => setReady(true), []);
  const failed = useCallback(() => setReady(false), []);
  const summary = useMemo(() => {
    if (!ready || !plugin) return null;
    const chainIds = new Set<string>();
    let elements = 0;
    for (const entry of plugin.managers.structure.hierarchy.current.structures) {
      const structure = entry.cell.obj?.data;
      if (!structure) continue;
      elements += structure.elementCount;
      for (const model of structure.models) {
        const chains = model.atomicHierarchy.chains;
        for (let i = 0; i < chains._rowCount; i++) {
          chainIds.add(chains.auth_asym_id.value(i) || chains.label_asym_id.value(i));
        }
      }
    }
    return { elements, chainIds: [...chainIds].filter(Boolean) };
  }, [ready, plugin]);
  useDisplayedSnapshot(onSnapshot, summary?.elements ? sha256 : null);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="external-structure-preview">
      {summary &&
        (summary.elements ? (
          <p
            className="px-4 py-2 text-xs text-fg-muted"
            data-testid="external-structure-chains"
          >
            {summary.elements.toLocaleString()} coordinate sites
            {summary.chainIds.length > 0 && ` · Model chains ${summary.chainIds.join(', ')}`}
          </p>
        ) : (
          <p role="alert" className="p-4">
            No coordinate sites could be displayed.
          </p>
        ))}
      <div className="relative min-h-0 flex-1">
        <LazyMolstarViewer
          structureData={document.data}
          structureDataFormat={document.format}
          structureKeyOverride={`external-${document.format}-${sha256}`}
          fillContainer
          scrollZoom
          onPluginReady={setPlugin}
          onLoad={loaded}
          onError={failed}
        />
      </div>
    </div>
  );
}

export function StructurePreview({ path, onSnapshot }: PreviewProps) {
  const source = usePreviewSource(path, SOFT_WARN_BYTES, readCoordinates);
  useDisplayedSnapshot(source?.status === 'loaded' ? undefined : onSnapshot, null);
  if (!source)
    return (
      <p role="status" className="p-4 text-sm">
        Reading coordinates…
      </p>
    );
  if (source.status === 'error')
    return (
      <p role="alert" className="p-4 text-sm">
        {source.message}
      </p>
    );
  return (
    <CoordinateViewer
      key={source.sha256}
      document={source.document}
      sha256={source.sha256}
      onSnapshot={onSnapshot}
    />
  );
}
