import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { lazy, Suspense } from 'react';
import type { Structure3dPanelProps } from './Structure3dPanel';
import { useCatalogCoordinates } from '../../../../compute/public/molecular-catalog';

const Structure3dPanel = lazy(async () => {
  const module = await import('./Structure3dPanel');
  return { default: module.Structure3dPanel };
});

export function LazyStructure3dPanel(props: Structure3dPanelProps) {
  const catalog = useCatalogCoordinates(props.initialStructureAttrs?.catalogSource);
  if (props.initialStructureAttrs?.catalogSource && !catalog?.data)
    return (
      <div role={catalog?.error ? 'alert' : 'status'} className="p-3 text-sm">
        {catalog?.error != null
          ? toUserMessage(catalog?.error, 'failure.opening-saved-structure')
          : userMessage('failure.opening-saved-structure')}
      </div>
    );
  return (
    <Suspense
      fallback={
        <div
          aria-busy="true"
          data-testid="structure-panel-module-loading"
          className="h-full w-full bg-bg-muted"
        />
      }
    >
      <Structure3dPanel
        {...props}
        {...(catalog?.data
          ? { structureData: catalog.data, structureDataFormat: catalog.format }
          : {})}
      />
    </Suspense>
  );
}
