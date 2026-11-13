'use client';
import { userMessage } from '@waypoint/user-messages';
import { referenceIconFor } from '../../entity-ref/reference-icon';

import { EmbedWrapper } from '../../embeds/components/EmbedWrapper';
import type { EmbedRendererProps } from '../../embeds/types';

interface GenericEmbedRendererProps extends EmbedRendererProps {
  storedVersion?: number;
  supportedVersion?: number;
}

export function GenericEmbedRenderer({
  type,
  selected,
  onRemove,
  onExpand,
}: GenericEmbedRendererProps) {
  const statusTitle = userMessage('document.unsupportedContent');
  const statusDescription = userMessage('document.unsupportedContentDetail');

  return (
    <EmbedWrapper
      type={type}
      label={statusTitle}
      selected={selected}
      onRemove={onRemove}
      onExpand={onExpand}
    >
      <div className="p-3 text-sm" data-testid="embed-version-compatibility">
        <div className="flex items-start gap-2">
          <TypeIcon type={type} />
          <div className="min-w-0">
            <div className="font-medium text-fg">{statusTitle}</div>
            <p className="mt-1 text-xs leading-5 text-fg-muted">{statusDescription}</p>
          </div>
        </div>
      </div>
    </EmbedWrapper>
  );
}

function TypeIcon({ type }: { type: string }) {
  return <>{referenceIconFor(type)}</>;
}
