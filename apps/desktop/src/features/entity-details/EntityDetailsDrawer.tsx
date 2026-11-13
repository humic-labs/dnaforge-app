import { useState } from 'react';
import { EntityDetails } from './EntityDetails';
import { SequenceDrawer } from '../sequence/public/components/SequenceDrawer';

export function EntityDetailsDrawer({
  entityId,
  onClose,
}: {
  entityId: string;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(420);
  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 max-w-full shadow-lg"
      style={{ width }}
      aria-label="Entity metadata"
    >
      <SequenceDrawer
        width={width}
        onWidthChange={(next) => setWidth(Math.max(320, Math.min(560, next)))}
      >
        <EntityDetails target={{ entityId }} onClose={onClose} />
      </SequenceDrawer>
    </aside>
  );
}
