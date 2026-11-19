import { useCallback, useMemo, useState } from 'react';
import { getStructureFileFormat } from '../../shared/scientific-file-types';
import { SOFT_WARN_BYTES } from '../../shared/oversized-guard';
import { LazyMolstarViewer } from '../page/public/embeds/structure3d/LazyMolstarViewer';
import type { MolstarPlugin } from '../page/public/embeds/structure3d/molstar/cache';
import { DocumentInfoRow } from './DocumentInfoRow';
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
  controls,
}: {
  document: ReturnType<typeof readCoordinates>;
  sha256: string;
  onSnapshot?: PreviewProps['onSnapshot'];
  controls?: PreviewProps['controls'];
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
      <DocumentInfoRow controls={controls}>
        {summary &&
          (summary.elements ? (
            <span data-testid="external-structure-chains">
              {summary.elements.toLocaleString()} coordinate sites
              {summary.chainIds.length > 0 && ` · Model chains ${summary.chainIds.join(', ')}`}
            </span>
          ) : (
            <span role="alert">No coordinate sites could be displayed.</span>
          ))}
      </DocumentInfoRow>
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

export function StructurePreview({
  path,
  onSnapshot,
  controls,
  expectedSourceSha256,
}: PreviewProps & { expectedSourceSha256?: string }) {
  const source = usePreviewSource(path, SOFT_WARN_BYTES, readCoordinates);
  useDisplayedSnapshot(source?.status === 'loaded' ? undefined : onSnapshot, null);
  if (source?.status !== 'loaded')
    return (
      <DocumentInfoRow controls={controls}>
        <span role={source ? 'alert' : 'status'}>
          {source ? source.message : 'Reading coordinates…'}
        </span>
      </DocumentInfoRow>
    );
  if (expectedSourceSha256 && source.sha256 !== expectedSourceSha256)
    return (
      <p role="alert" className="p-4 text-sm">
        The project file has changed since import. Open the current file from Files.
      </p>
    );
  return (
    <CoordinateViewer
      key={source.sha256}
      document={source.document}
      sha256={source.sha256}
      onSnapshot={onSnapshot}
      controls={controls}
    />
  );
}
