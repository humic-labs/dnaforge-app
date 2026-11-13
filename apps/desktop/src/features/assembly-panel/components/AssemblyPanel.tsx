'use client';

import { useCallback, useMemo, useRef } from 'react';
import { useAssemblyJourneyTelemetry } from '../../assembly/public/hooks/useAssemblyJourneyTelemetry';
import { useDesignStore } from '../../design/public/store';
import { deriveAssemblyIssues } from '../../assembly/public/issues/assembly-issues';
import { collectInternalCutSiteMarkers } from '../../design/public/internal-cut-sites';
import { AssemblyPartsSection } from './AssemblyPartsSection';
import { AssemblyMethodSection } from './AssemblyMethodSection';
import { ExportSection } from './ExportSection';
import { InternalCutSiteStepper } from './InternalCutSiteStepper';
import {
  resolveAssemblyDrawerWheelInteraction,
  type AssemblyDrawerWheelAxisLock,
} from './AssemblyPanelWheel';
import { AssemblyDrawerStep } from './AssemblyDrawerStep';
import { ASSEMBLY_DRAWER_SECTIONS } from './assembly-drawer-sections';
import type { AssemblySchemaPickerRequest } from '../schema-picker-request';
import { selectPhysicalDesignPrimerPairs } from '../../design/public/restriction-digest';
import { AssemblyMethodSelector } from '../../design/public/components/AssemblyMethodSelector';
import { preferredGoldenGateEnzymeForDesign } from '../../design/public/assembly-method-drafts';

interface AssemblyPanelContentProps {
  designId: string;
  projectRoot?: string | null;
  schemaPickerRequest?: AssemblySchemaPickerRequest | null;
}

export function AssemblyPanelContent({
  designId,
  projectRoot = null,
  schemaPickerRequest,
}: AssemblyPanelContentProps) {
  const design = useDesignStore((s) => s.designs[designId]);
  useAssemblyJourneyTelemetry(design);
  const stepInternalCutSite = useDesignStore((s) => s.stepInternalCutSite);
  const setAssemblyMethod = useDesignStore((s) => s.setAssemblyMethod);
  const primers = useMemo(
    () => (design ? selectPhysicalDesignPrimerPairs(design) : null),
    [design?.regions, design?.designPrimers]
  );
  const wheelAxisLockRef = useRef<AssemblyDrawerWheelAxisLock | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const assemblyIssues = useMemo(() => (design ? deriveAssemblyIssues({ design }) : []), [design]);
  const internalCutSiteCount = useMemo(
    () => (design ? collectInternalCutSiteMarkers(design, assemblyIssues).length : 0),
    [design, assemblyIssues]
  );

  const handleScrollWheelCapture = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const decision = resolveAssemblyDrawerWheelInteraction({
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      target: event.target,
      lock: wheelAxisLockRef.current,
      nowMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    });
    wheelAxisLockRef.current = decision.lock;
    if (decision.action === null || decision.action === 'horizontal-scroll') return;

    event.preventDefault();
    event.stopPropagation();
    if (decision.action === 'vertical-scroll') {
      event.currentTarget.scrollTop += event.deltaY;
    }
  }, []);

  if (!design) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-fg-muted">
        <div className="text-center">
          <div className="mb-2 text-lg font-medium">Design Not Found</div>
          <div className="text-sm">Design ID: {designId}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg-subtle">
      <div
        ref={scrollRef}
        data-testid="assembly-panel-scroll"
        className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
        style={{ overflowAnchor: 'auto' }}
        onWheelCapture={handleScrollWheelCapture}
      >
        <AssemblyDrawerStep
          step={ASSEMBLY_DRAWER_SECTIONS[0]}
          headerRight={
            <InternalCutSiteStepper
              cutSiteCount={internalCutSiteCount}
              activeCutSiteIndex={design.activeCutSiteIndex ?? null}
              onStep={(direction) => stepInternalCutSite(designId, direction)}
            />
          }
        >
          <div data-testid="assembly-method-section" className="mb-3 flex items-center gap-2">
            <span className="w-12 shrink-0 text-xs font-medium text-fg-muted">Cloning method</span>
            <AssemblyMethodSelector
              method={design.assemblyMethod}
              enzyme={
                preferredGoldenGateEnzymeForDesign(design) ??
                design.goldenGateConfig?.enzyme ??
                'BsaI'
              }
              regions={design.regions}
              onChange={(method, enzyme) => setAssemblyMethod(design.id, method, enzyme)}
            />
          </div>
          <AssemblyPartsSection
            design={design}
            projectRoot={projectRoot}
            schemaPickerRequest={schemaPickerRequest}
          />
        </AssemblyDrawerStep>

        <AssemblyDrawerStep step={ASSEMBLY_DRAWER_SECTIONS[1]}>
          <AssemblyMethodSection design={design} />
        </AssemblyDrawerStep>

        <AssemblyDrawerStep step={ASSEMBLY_DRAWER_SECTIONS[2]}>
          <ExportSection design={design} primers={primers} projectRoot={projectRoot} />
        </AssemblyDrawerStep>
      </div>
    </div>
  );
}
