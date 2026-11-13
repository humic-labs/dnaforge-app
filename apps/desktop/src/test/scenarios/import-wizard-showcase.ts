import type { AppScenario } from './types';
import type { ImportItem } from '../../features/workspace-loader/import-wizard-state';

const MY_WS = '/scenario/My Workspace';
const OTHER_WS = '/scenario/E. coli project';

function file(
  name: string,
  format: string | undefined,
  extra: Partial<ImportItem> = {}
): ImportItem {
  const size = 640 + name.length * 211 + (format?.length ?? 0) * 1500;
  return { path: `/scenario/${name}`, name, kind: 'file', format, size, ...extra };
}

export function importWizardShowcaseScenario(): AppScenario {
  const items: ImportItem[] = [
    file('pUC19.gb', 'genbank'),
    file('backbone.fasta', 'fasta'),
    file('sample_R1.fastq', 'fastq'),
    file('trace_A01.ab1', 'ab1'),
    file('pool.fasta', 'fasta', {
      block: {
        kind: 'multi-record-fasta',
        recordCount: 7,
        message: '7 sequences — not supported yet',
      },
    }),
    file('plate_layout.xlsx', 'unknown'),
    file('primers.csv', 'unknown'),
    file('protocol.pdf', 'unknown'),
    file('gel_2026.png', 'unknown'),
    file('mystery.dat', 'unknown'),
    { path: '/scenario/Raw Data', name: 'Raw Data', kind: 'folder' },
    {
      path: '/scenario/Raw Data/well_A01.ab1',
      name: 'well_A01.ab1',
      kind: 'file',
      format: 'ab1',
      size: 8421,
    },
    {
      path: '/scenario/Raw Data/well_A02.ab1',
      name: 'well_A02.ab1',
      kind: 'file',
      format: 'ab1',
      size: 8710,
    },
    {
      path: '/scenario/Raw Data/plate_map.csv',
      name: 'plate_map.csv',
      kind: 'file',
      format: 'unknown',
      size: 1180,
    },
    file('insert.gb', 'genbank'),
    file('vector.gb', 'genbank'),
  ];

  return {
    importWizard: {
      items,
      destination: { kind: 'existing-root', rootPath: MY_WS },
      availableRoots: [
        { path: MY_WS, name: 'My Workspace' },
        { path: OTHER_WS, name: 'E. coli project' },
      ],
      requiresExplicitChoice: false,
      destinationChosen: true,
      agentRequested: false,
    },
  };
}
