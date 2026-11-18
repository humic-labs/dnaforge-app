import { useEffect, useState } from 'react';
import { platform } from '../../../platform';
import {
  contactProjectionViewStateSchema,
  type ContactProjectionViewState,
  type ContactSourceReadResult,
} from '../../../shared/contact-source';
import { assertContactProjectionReference } from '../contact-projection-binding';

type ContactResource =
  | { status: 'inactive' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; value: ContactSourceReadResult }
  | { status: 'error'; key: string; message: string };

export function useContactProjectionSource(
  view: ContactProjectionViewState | undefined,
  chromosomes: readonly { chrom: string; length: number }[]
): ContactResource {
  const sourceKey = view
    ? JSON.stringify({ project: view.project, source: view.source, chromosomes })
    : '';
  const [resource, setResource] = useState<ContactResource>({ status: 'inactive' });
  useEffect(() => {
    if (!view) {
      setResource({ status: 'inactive' });
      return;
    }
    let cancelled = false;
    setResource({ status: 'loading', key: sourceKey });
    void (async () => {
      try {
        const request = contactProjectionViewStateSchema.parse(view);
        assertContactProjectionReference(request.source, chromosomes);
        const value = await platform().contactSources.read({
          project: request.project,
          source: request.source,
        });
        if (!cancelled) setResource({ status: 'ready', key: sourceKey, value });
      } catch (error) {
        if (!cancelled)
          setResource({
            status: 'error',
            key: sourceKey,
            message: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceKey]);
  if (!view) return { status: 'inactive' };
  return 'key' in resource && resource.key === sourceKey
    ? resource
    : { status: 'loading', key: sourceKey };
}
