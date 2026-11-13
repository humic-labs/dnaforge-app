import { createTestHarness } from './test-harness';
import {
  setMockFileContent,
  getMockFileContent,
  setMockGitStatusPorcelain,
  setFileTree,
  clearFileTree,
} from './platform-mocks';

function isBrowserOnly(): boolean {
  if (typeof window === 'undefined' || 'electronAPI' in window) return false;
  if (
    typeof document !== 'undefined' &&
    (document.documentElement.dataset.dnaforgeRuntime === 'hosted-browser' ||
      document.documentElement.getAttribute('data-dnaforge-runtime') === 'hosted-browser')
  ) {
    return false;
  }
  return true;
}

export async function initializeMocks(): Promise<void> {
  if (!isBrowserOnly()) {
    return;
  }

  console.log('[MockSetup] Initializing browser mocks...');

  const workspacePath = '/mock/test/workspace';

  setFileTree(workspacePath, [
    {
      name: 'sample.fasta',
      isDirectory: false,
      content: generateLargeFastaContent('Sample', 500),
    },
    {
      name: 'plasmid.gb',
      isDirectory: false,
      content: generateLargeGenBankContent('plasmid', 2686),
    },
    {
      name: 'README.md',
      isDirectory: false,
      content: '# Test Workspace\n\nMock workspace for E2E testing.',
    },
    { name: 'notes.txt', isDirectory: false, content: 'Test notes file for E2E testing.' },
    {
      name: 'example.py',
      isDirectory: false,
      content: 'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n',
    },
    {
      name: 'example.ts',
      isDirectory: false,
      content: 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
    },
    {
      name: 'browser-structure.pdb',
      isDirectory: false,
      content: `HEADER    BROWSER ROUTING FIXTURE
ATOM      1  N   ALA A   1      11.104  13.207  14.115  1.00 20.00           N
ATOM      2  CA  ALA A   1      12.560  13.207  14.115  1.00 20.00           C
ATOM      3  C   ALA A   1      13.041  14.645  14.115  1.00 20.00           C
ATOM      4  O   ALA A   1      12.285  15.586  14.115  1.00 20.00           O
TER
END
`,
    },
    { name: 'sequences', isDirectory: true },
    { name: 'plasmids', isDirectory: true },
  ]);
  setFileTree(`${workspacePath}/plasmids`, [
    {
      name: 'pUC19.gb',
      isDirectory: false,
      content: generateLargeGenBankContent('pUC19', 2686),
    },
    {
      name: 'pBR322.gb',
      isDirectory: false,
      content: generateLargeGenBankContent('pBR322', 4361),
    },
  ]);
  setFileTree(`${workspacePath}/sequences`, [
    {
      name: 'gfp.fasta',
      isDirectory: false,
      content: generateLargeFastaContent('GFP', 720),
    },
  ]);

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('e2e') === 'true') {
    console.log('[MockSetup] E2E mode detected, preloading test files...');

    const mockAssetsRoot = '/mock-assets/test-data/desktop-perf/plasmid-variants';
    const testFiles = [
      {
        path: `${mockAssetsRoot}/ecoli-mg1655-region.gb`,
        content: generateLargeGenBankContent('ecoli-mg1655-region', 82000),
      },
      {
        path: `${mockAssetsRoot}/variant1.fasta`,
        content: generateLargeFastaContent('ecoli-region-variant1', 50000),
      },
    ];

    for (const file of testFiles) {
      setMockFileContent(file.path, file.content);
    }
  }

  // @ts-expect-error - Adding to window for E2E
  window.__mockUtils = {
    setMockFileContent,
    getMockFileContent,
    setMockGitStatusPorcelain,
    setFileTree,
    clearFileTree,
    seedEntityReference: async (params: {
      id: string;
      entity_type: string;
      display_label: string;
      locator: string;
      deep_link_params?: string | null;
      data?: string | null;
      source?: string;
      status?: string;
      workspace_scope?: string | null;
      workspace_root_path?: string | null;
      created_at?: number;
      updated_at?: number;
    }) => {
      const { getConnection } = await import('../db');
      const db = getConnection();
      const now = Date.now();
      await db.execute(
        `INSERT OR REPLACE INTO entity_references (
          id, entity_type, display_label, locator, deep_link_params, data,
          source, status, workspace_scope, workspace_root_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          params.id,
          params.entity_type,
          params.display_label,
          params.locator,
          params.deep_link_params ?? null,
          params.data ?? null,
          params.source ?? 'e2e-test',
          params.status ?? 'created',
          params.workspace_scope ?? null,
          params.workspace_root_path ?? null,
          params.created_at ?? now,
          params.updated_at ?? now,
        ]
      );
    },
    getEntityReferences: async () => {
      const { getConnection } = await import('../db');
      const db = getConnection();
      return db.select('SELECT * FROM entity_references', []);
    },
    seedLegacyReferenceConversation: async (input: {
      conversationId: string;
      title: string;
      workspacePath: string;
      messageId: string;
      referenceId: string;
      displayLabel: string;
      locator: string;
      workspaceScope: string | null;
    }) => {
      const { addMessage, createConversation, getConnection } = await import('../db');
      const db = getConnection();
      const now = Date.now();
      await createConversation(input.conversationId, input.title, input.workspacePath);
      await db.execute(
        `INSERT INTO entity_references
           (id, entity_type, display_label, locator, deep_link_params, data,
            source, status, workspace_scope, workspace_root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.referenceId,
          'sequence',
          input.displayLabel,
          input.locator,
          null,
          null,
          'ai',
          'created',
          input.workspaceScope,
          null,
          now,
          now,
        ]
      );
      await addMessage({
        id: input.messageId,
        conversation_id: input.conversationId,
        turn_id: null,
        role: 'assistant',
        content: `[pUC19](dnaforge-chat://reference/${input.referenceId})`,
        tool_name: null,
        tool_call_id: null,
        created_at: now,
      });
      await db.execute(
        'INSERT INTO message_references (message_id, reference_id, position) VALUES (?, ?, 0)',
        [input.messageId, input.referenceId]
      );
    },
  };

  // @ts-expect-error - Adding to window for E2E
  window.__testHarness = createTestHarness();

  console.log('[MockSetup] Browser mocks initialized');
}

function generateLargeGenBankContent(name: string, length: number): string {
  const date = new Date()
    .toLocaleDateString('en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
    .toUpperCase();

  const seqChunkSize = 10000;
  const numChunks = Math.ceil(length / seqChunkSize);
  let sequence = '';

  for (let i = 0; i < numChunks; i++) {
    const chunkLength = Math.min(seqChunkSize, length - i * seqChunkSize);
    sequence += generateDNASequence(chunkLength);
  }

  const features = `
     CDS             1000..2000
                     /label="Test_CDS_1"
                     /gene="testGene1"
                     /product="Test protein 1"
                     /note="Coding sequence for testing"
     promoter        500..600
                     /label="Test_Promoter"
                     /note="Strong constitutive promoter"
     terminator      2100..2200
                     /label="Test_Terminator"
                     /note="Transcriptional terminator"
     misc_feature    complement(3000..4000)
                     /label="Test_Feature_Rev"
                     /note="Feature on reverse strand"
     CDS             15000..16500
                     /label="Test_CDS_2"
                     /gene="testGene2"
                     /product="Test protein 2"
     RBS             14950..14960
                     /label="RBS"
                     /note="Ribosome binding site"
     misc_feature    40000..40100
                     /label="Position_40K_Marker"
                     /note="Marker at position 40,000 for scroll testing"`;

  const formattedSeq = formatGenBankSequence(sequence);

  return `LOCUS       ${name}    ${length} bp    DNA     circular SYN ${date}
DEFINITION  Test plasmid ${name} for E2E testing.
ACCESSION   .
VERSION     .
KEYWORDS    .
SOURCE      synthetic DNA construct
  ORGANISM  synthetic DNA construct
REFERENCE   1  (bases 1 to ${length})
  AUTHORS   E2E Test Generator
  TITLE     Direct Submission
  JOURNAL   Submitted (${date}) E2E Test Suite
FEATURES             Location/Qualifiers${features}
ORIGIN
${formattedSeq}
//`;
}

function generateLargeFastaContent(name: string, length: number): string {
  const sequence = generateDNASequence(length);

  const formattedSeq = sequence.match(/.{1,80}/g)?.join('\n') || sequence;

  return `>${name} ${length}bp circular DNA
${formattedSeq}`;
}

function generateDNASequence(length: number): string {
  const bases = ['A', 'T', 'C', 'G'];
  let sequence = '';

  const weights = [0.25, 0.25, 0.25, 0.25];

  for (let i = 0; i < length; i++) {
    const random = Math.random();
    let cumulative = 0;
    for (let j = 0; j < bases.length; j++) {
      cumulative += weights[j];
      if (random < cumulative) {
        sequence += bases[j];
        break;
      }
    }
  }

  return sequence;
}

function formatGenBankSequence(sequence: string): string {
  const lines: string[] = [];
  const lineLength = 60;

  for (let i = 0; i < sequence.length; i += lineLength) {
    const lineNum = i + 1;
    const lineNumStr = lineNum.toString().padStart(9, ' ');
    const basesInLine = sequence.slice(i, i + lineLength);

    const groups: string[] = [];
    for (let j = 0; j < basesInLine.length; j += 10) {
      groups.push(basesInLine.slice(j, j + 10).toLowerCase());
    }

    lines.push(`${lineNumStr} ${groups.join(' ')}`);
  }

  return lines.join('\n');
}

if (isBrowserOnly()) {
  initializeMocks().catch(console.error);
}
