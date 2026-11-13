import { withSequenceTab } from './canvas';
import { sidecarScenarios } from './sidecar';
import type { AppScenario } from './types';
import { WP_ASSETS } from './wp-assets';

export interface SangerFixture {
  id:
    | 'clean-forward'
    | 'clean-rc'
    | 'clean-rc-with-indels'
    | 'heterozygous'
    | 'failed-low-quality'
    | 'origin-spanning';
  label: string;
  demonstrates: string;
  ab1Path: string;
  refPath: string;
}

const [labFixtures] = Object.values(
  import.meta.glob<{ LAB_SANGER_FIXTURES: ReadonlyArray<SangerFixture> }>(
    './lab/sanger-fixtures.ts',
    { eager: true }
  )
);

export const SANGER_FIXTURES: ReadonlyArray<SangerFixture> = labFixtures?.LAB_SANGER_FIXTURES ?? [];

export function withSangerFixture(fixture: SangerFixture): AppScenario {
  const base: AppScenario = {
    sidecar: sidecarScenarios.fullyReady(),
    workspace: {
      folders: [{ path: WP_ASSETS, name: 'Dev Assets' }],
      selectedPath: WP_ASSETS,
    },
    dev: {
      scenarioId: `sanger-${fixture.id}`,
    },
  };
  const withRef = withSequenceTab(base, {
    documentId: `fixture:sequence:sanger:${fixture.id}:reference`,
    sourcePath: fixture.refPath,
    label: fixture.refPath.split('/').pop() ?? 'Reference',
  });
  const withReadAndRef = withSequenceTab(withRef, {
    documentId: `fixture:sequence:sanger:${fixture.id}:read`,
    sourcePath: fixture.ab1Path,
    label: fixture.ab1Path.split('/').pop() ?? 'Sanger read',
  });
  return {
    ...withReadAndRef,
    canvas: {
      ...withReadAndRef.canvas!,
      activeTabIndex: 1,
    },
  };
}

export function sangerFixture(id: SangerFixture['id']): SangerFixture {
  const found = SANGER_FIXTURES.find((f) => f.id === id);
  if (!found) throw new Error(`Unknown Sanger fixture: ${id}`);
  return found;
}
