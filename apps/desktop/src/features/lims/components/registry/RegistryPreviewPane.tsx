import type { LimsRegistryPreview, LimsRegistrySummary } from '../../../../shared/lims';
import type { TabViewState } from '../../../canvas/public/types';
import type { ExternalProviderSourceRequest } from '../../../../shared/benchling-migration-raw-source';
import { EntityDetails } from '../../../entity-details/public/EntityDetails';

export interface RegistryPreviewPaneProps {
  onClose?: () => void;
  registryPreview: LimsRegistryPreview;
  openRegistrySummary: (summary: LimsRegistrySummary, focus?: TabViewState) => void;
  onViewOriginalSource: (dialog: { request: ExternalProviderSourceRequest; label: string }) => void;
  onClassificationApplied?: () => Promise<void>;
  onMetadataSaved?: () => Promise<void>;
}

export function RegistryPreviewPane(props: RegistryPreviewPaneProps) {
  return (
    <div
      data-testid="lims-registry-preview"
      data-entity-id={props.registryPreview.entity.id}
      className="h-full min-h-0 min-w-0 overflow-hidden"
    >
      <EntityDetails
        target={{
          entityId: props.registryPreview.entity.id,
          recordFile:
            props.registryPreview.summary.representation.openTarget?.kind === 'record_file',
        }}
        host="registry"
        onClose={props.onClose ?? (() => {})}
        onOpenEntity={props.openRegistrySummary}
        onViewOriginalSource={props.onViewOriginalSource}
        onClassificationApplied={props.onClassificationApplied}
        onSaved={() => {
          void props.onMetadataSaved?.();
        }}
      />
    </div>
  );
}
