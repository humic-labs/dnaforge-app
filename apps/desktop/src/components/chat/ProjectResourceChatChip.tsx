import { useEffect, useState } from 'react';
import { platform } from '../../platform';
import {
  projectResourceReferenceHref,
  type ProjectResourceReference,
  type ResolvedProjectResourceReference,
} from '../../shared/project-resource-reference';
import { ChatEntityReferenceChip } from './ChatEntityReferenceChip';

export function ProjectResourceChatChip({
  reference,
  label,
  busy,
  onOpen,
  onReveal,
  testId,
}: {
  reference: ProjectResourceReference;
  label: string;
  busy: boolean;
  onOpen(): void;
  onReveal(): void;
  testId: string;
}) {
  const href = projectResourceReferenceHref(reference);
  const [state, setState] = useState<{
    href: string;
    resource: ResolvedProjectResourceReference | null;
  } | null>(null);
  const resource = state?.href === href ? state.resource : null;
  const loading = state?.href !== href;
  useEffect(() => {
    let current = true;
    const resolve = platform().fs.resolveProjectResourceReference;
    if (!resolve) {
      setState({ href, resource: null });
      return;
    }
    void resolve(href).then(
      (value) => {
        if (current) setState({ href, resource: value });
      },
      () => {
        if (current) setState({ href, resource: null });
      }
    );
    return () => {
      current = false;
    };
  }, [href]);
  const directory =
    resource?.reference.kind === 'path' && resource.reference.resourceKind === 'directory';
  return (
    <ChatEntityReferenceChip
      entityType={directory ? 'folder' : (resource?.entityType ?? 'file')}
      iconContext={resource?.iconContext ?? { path: resource?.path, isDirectory: directory }}
      label={label}
      detail={resource?.path}
      busy={busy || loading}
      unavailable={!loading && !resource}
      primaryAction={directory ? 'reveal' : 'open'}
      onOpen={resource ? onOpen : undefined}
      onReveal={resource ? onReveal : undefined}
      testId={testId}
    />
  );
}
