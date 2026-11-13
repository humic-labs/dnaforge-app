'use client';

import type { SequenceDesign } from '../../design/public/types';
import { JunctionWorkbench } from '../../junction-workbench/public';

interface AssemblyMethodSectionProps {
  design: SequenceDesign;
}

export function AssemblyMethodSection({ design }: AssemblyMethodSectionProps) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      <JunctionWorkbench key={`${design.id}:${design.assemblyMethod}`} design={design} />
    </div>
  );
}
