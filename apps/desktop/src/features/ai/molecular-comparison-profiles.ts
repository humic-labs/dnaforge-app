export const MOLECULAR_BENCHMARK_CASES = [
  {
    id: 'kcsa',
    title: 'KcsA',
    question:
      'If potassium loses its surrounding waters as it enters KcsA, what takes their place in the selectivity filter?',
    fixtureIds: ['1K4C'],
    structureModes: ['assembly:1'],
    context:
      'Use experimental PDB 1K4C, biological assembly 1, with the KcsA tetramer and its modeled potassium ions. In the selectivity filter, backbone carbonyl oxygens coordinate K+ in place of much of its hydration shell. Waters near the pore entrance and the filter geometry are the relevant observed features; this static structure does not measure ion flux.',
  },
  {
    id: 'cas9',
    title: 'Cas9',
    question:
      'The DNA strands split inside Cas9’s R-loop. How does that place each one near a different nuclease?',
    fixtureIds: ['5F9R'],
    structureModes: ['model'],
    context:
      'Use experimental PDB 5F9R, the Cas9–guide-RNA–target-DNA complex. The guide-paired target DNA strand is chain C and the displaced DNA strand is chain D. HNH and RuvC are the two protein nuclease domains relevant to their routes. This is a static arrangement, not a movie of cleavage.',
  },
  {
    id: 'groel',
    title: 'GroEL–GroES',
    question:
      'GroES caps one GroEL ring. What apical-domain movement creates its chamber, and what happens to the opposite ring?',
    fixtureIds: ['1AON'],
    structureModes: ['model'],
    context:
      'Use experimental PDB 1AON, the asymmetric GroEL–GroES–ADP assembly. GroEL chains A–G form the capped cis ring, H–N the opposite trans ring, and GroES chains O–U form the cap. A single coordinate state can show the chamber and asymmetry but cannot by itself measure movement between states.',
  },
  {
    id: 'abl',
    title: 'Abl inhibitors',
    question:
      'Imatinib and PD173955 bind the same Abl kinase site. Why does only imatinib require the inactive activation-loop shape?',
    fixtureIds: ['1IEP', '1M52'],
    structureModes: ['model', 'model'],
    context:
      'Use experimental PDB 1IEP for imatinib and 1M52 for PD173955. Both include Abl kinase domains and their bound inhibitor. The comparison concerns inhibitor geometry and activation-loop shape; 1IEP captures an inactive loop arrangement and 1M52 a more active-like one.',
  },
  {
    id: 'pgt128',
    title: 'PGT128 and the HIV glycan shield',
    question:
      'For some HIV strains, losing the N332 glycan helps escape PGT128. Why does removing part of the glycan shield protect the virus from this antibody?',
    fixtureIds: ['3TYG'],
    structureModes: ['model'],
    context:
      'Use experimental PDB 3TYG: PGT128 Fab bound to an engineered glycosylated gp120 outer domain with miniV3. PGT128 contacts the N332 and N301 glycans and a short V3 segment. This isolated complex does not include a native Env trimer or show the effect of deleting either glycan; the neutralization result comes from the associated study.',
  },
  {
    id: 'h274y',
    title: 'H274Y neuraminidase',
    question:
      'Why does H274Y influenza neuraminidase resist oseltamivir but remain sensitive to zanamivir, even though both drugs bind the same active site?',
    fixtureIds: ['2HU4', '3CL0', '3CKZ'],
    structureModes: ['model', 'model', 'model'],
    context:
      'Use N1 neuraminidase structures 2HU4 (His274, oseltamivir), 3CL0 (H274Y, oseltamivir), and 3CKZ (H274Y, zanamivir). The H274Y substitution changes the Glu276 side-chain arrangement and the hydrophobic pocket used by oseltamivir. Oseltamivir is still present in its mutant crystal complex; resistance means weaker inhibition, not an empty binding site.',
  },
  {
    id: 'groel-asymmetry',
    title: 'GroEL ring asymmetry',
    question:
      'In the GroEL–GroES complex, why is one ring capped while the other stays open, even though the rings are made from identical subunits?',
    fixtureIds: ['1AON'],
    structureModes: ['model'],
    context:
      'Use experimental PDB 1AON, an asymmetric GroEL–GroES–ADP complex. GroEL chains A–G form the GroES-capped cis ring, H–N the open trans ring, and GroES chains O–U form the cap. The rings differ in nucleotide and conformational state in this snapshot; it does not directly show the transition between states.',
  },
  {
    id: 'streptavidin-w120f',
    title: 'Streptavidin W120F',
    question:
      'Why does replacing streptavidin Trp120 with phenylalanine leave a tetramer that still binds biotin, yet sharply weaken that binding?',
    fixtureIds: ['1MK5', '1SWP'],
    structureModes: ['assembly:1', 'assembly:1'],
    context:
      'Use 1MK5 for wild-type core streptavidin with biotin and 1SWP for the W120F mutant with biotin, both as biological assembly 1. Trp120 belongs to a neighboring subunit at the biotin-binding pocket, so the tetrameric interface matters. The mutant retains bound biotin but has reduced affinity. Check ligand identity when comparing sites: 1SWP also includes an epi-biotin site.',
  },
  {
    id: 'rsv-f-d25',
    title: 'RSV F and D25',
    question:
      'Why does D25 bind RSV F before membrane fusion but lose that epitope after F refolds?',
    fixtureIds: ['4JHW', '3RRR'],
    structureModes: ['assembly:1', 'assembly:1'],
    context:
      'Use 4JHW for D25 Fab bound at the prefusion RSV F trimer apex and 3RRR for postfusion RSV F, both as biological assembly 1. D25 recognizes a prefusion-specific quaternary epitope spanning the apex. The postfusion entry has no D25; compare the F conformations without implying that antibody dissociation was directly imaged.',
  },
  {
    id: 'f1-atpase',
    title: 'F1-ATPase catalytic asymmetry',
    question:
      'The three β subunits of F1-ATPase have the same sequence. Why is one nucleotide-free while the others hold different nucleotides?',
    fixtureIds: ['1BMF'],
    structureModes: ['model'],
    context:
      'Use experimental PDB 1BMF, bovine mitochondrial F1-ATPase. Its three catalytic beta subunits have distinct conformations: one carries an ATP analogue, one ADP, and one is nucleotide-free. The asymmetric central gamma subunit and adjacent alpha-beta interfaces are relevant. This is one static state supporting a rotational mechanism, not a direct movie of rotation.',
  },
  {
    id: 'ribosome-decoding',
    title: 'Ribosome decoding center',
    question:
      'Why does the ribosome police the first two codon–anticodon pairs much more tightly than the third?',
    fixtureIds: ['1IBM'],
    structureModes: ['model'],
    context:
      'Use experimental PDB 1IBM, a Thermus thermophilus 30S subunit with mRNA and a cognate A-site tRNA anticodon stem-loop. Conserved 16S rRNA bases A1492, A1493, and G530 inspect the minor-groove geometry of the first two codon–anticodon pairs. The third position accommodates wobble. This entry is a static decoding complex and does not show kinetic proofreading.',
  },
  {
    id: 'adenylate-closure',
    title: 'Adenylate kinase domain closure',
    question:
      'Adenylate kinase has to bring ATP and AMP together. How does its open form rearrange to enclose both binding sites?',
    fixtureIds: ['4AKE', '1AKE'],
    structureModes: ['model', 'model'],
    context:
      'Use experimental E. coli adenylate kinase structures 4AKE (unligated) and 1AKE (bound to AP5A, a single inhibitor mimicking both ATP and AMP). Both are wild-type enzyme with two crystallographic protein copies; the functional enzyme is a monomer. The structures model all 214 protein residues. Compare domain arrangement and ligand-site geometry. AP5A is not two separate substrate molecules, and the two static crystals do not establish the timing, energetic cause, or continuous trajectory of closure. Primary studies: Mueller and Schulz, J Mol Biol 1992, doi:10.1016/0022-2836(92)90582-5; Mueller et al., Structure 1996, doi:10.1016/S0969-2126(96)00018-4.',
  },
  {
    id: 'cas9-checkpoint',
    title: 'Cas9 checkpoint and cleavage states',
    question:
      'Cas9 can form a long R-loop without cutting. What changes between that checkpoint and the cleavage state?',
    fixtureIds: ['7Z4L', '7Z4J'],
    structureModes: ['model', 'model'],
    context:
      'Use experimental PDB 7Z4L (18-nucleotide-match checkpoint complex) and 7Z4J (18-nucleotide-match catalytic complex with cleaved DNA), from Pacesa et al., Nature 2022, doi:10.1038/s41586-022-05114-0. Both contain wild-type SpCas9, guide RNA, target DNA, and non-target DNA. Protein author-chain B is label-chain B in 7Z4L and label-chain E in 7Z4J. The target DNA is one modeled chain in 7Z4L and two deposited fragments in 7Z4J. Both model the HNH domain and intact Asp10 and His840; unresolved loops and DNA portions must not be interpreted as biological absence. These samples were prepared under different magnesium conditions. They are structural endpoints, not a continuous movie or an experiment establishing that matching length alone controls cleavage.',
  },
  {
    id: 'pgt128-recognition',
    title: 'PGT128 protein–glycan recognition',
    question:
      'How does PGT128 recognize a binding surface made of both protein and attached glycans?',
    fixtureIds: ['3TYG'],
    structureModes: ['model'],
    context:
      'Use experimental PDB 3TYG, PGT128 Fab bound to a glycosylated engineered gp120 outer domain with miniV3. This question concerns only the protein–glycan–antibody arrangement observed in the deposited complex. It is an isolated engineered domain, not a native Env trimer; the static coordinates do not measure binding energy or show a recognition trajectory. Primary structural source: Pejchal et al., Science 2011, doi:10.1126/science.1213256. This is a new static-recognition question; it does not continue the historical viral-escape question.',
  },
  {
    id: 'sn101-muc1',
    title: 'SN-101 recognition of MUC1 glycosylation',
    question:
      'How can SN-101 distinguish the single-sugar form of MUC1 from the same site with a longer sugar chain?',
    fixtureIds: ['6KX1'],
    structureModes: ['assembly:1'],
    context:
      'Use experimental PDB 6KX1, biological assembly 1: mouse SN-101 Fab bound to a synthetic human MUC1 glycopeptide bearing one alpha-GalNAc (Tn). Heavy chain A and light chain B form the antibody; peptide label-chain C carries the sugar, label-chain D (author-chain C, residue 101, component A2G), covalently attached to peptide author Thr7. The deposited coordinates model peptide author residues 1–10 and an acetyl cap, not the entire synthetic peptide or full-length MUC1. Primary source: Wakui et al., Chemical Science 2020, doi:10.1039/D0SC00317D. Its glycoform-focused microarray supports recognition of Tn-MUC1 and loss of recognition of the corresponding T-glycosylated form. The crystal shows contacts to both peptide and sugar and the surrounding pocket geometry; the extended sugar form is not deposited here. A steric explanation is an inference, not a modeled collision, measured binding energy, or a continuous recognition trajectory.',
  },
  {
    id: 'sn101-muc1-recognition',
    title: 'SN-101 peptide–sugar recognition',
    question:
      'Where does MUC1’s attached GalNAc sit relative to the peptide in SN-101’s binding groove, and how does the antibody contact both?',
    fixtureIds: ['6KX1'],
    structureModes: ['assembly:1'],
    context:
      'Use experimental PDB 6KX1, biological assembly 1: mouse SN-101 Fab bound to a synthetic human MUC1 glycopeptide bearing one alpha-GalNAc (Tn). Antibody heavy chain A and light chain B form the binding groove; peptide label-chain C carries the sugar, label-chain D (author-chain C, residue 101, component A2G), covalently attached to peptide author Thr7. The deposited coordinates model peptide author residues 1–10 and an acetyl cap. The question concerns their observed relative placement and antibody contacts. Primary structural source: Wakui et al., Chemical Science 2020, doi:10.1039/D0SC00317D. This isolated Fab–glycopeptide crystal does not measure contact energies or recognition kinetics.',
  },
] as const;

export type MolecularBenchmarkCaseId = (typeof MOLECULAR_BENCHMARK_CASES)[number]['id'];

export const MOLECULAR_V1_BENCHMARK_CASE_IDS = [
  'ribosome-decoding',
  'f1-atpase',
  'rsv-f-d25',
  'streptavidin-w120f',
  'sn101-muc1-recognition',
  'groel-asymmetry',
  'cas9',
  'kcsa',
  'adenylate-closure',
  'cas9-checkpoint',
] as const satisfies readonly MolecularBenchmarkCaseId[];

export const MOLECULAR_ACTIVE_BENCHMARK_CASES = MOLECULAR_BENCHMARK_CASES.filter((item) =>
  MOLECULAR_V1_BENCHMARK_CASE_IDS.some((id) => id === item.id)
);

export const MOLECULAR_HARNESS_ELIGIBILITY = [
  {
    id: 'dnaforge-mvs',
    label: 'DNAForge MolViewSpec',
    eligible: true,
    reason: 'The agent can set camera target, position, and up vector in MolViewSpec.',
  },
  {
    id: 'molstar-mcp',
    label: 'Molstar-MCP',
    eligible: false,
    reason: 'Its checked scene builder and MCP tools do not expose camera pose control.',
  },
  {
    id: 'burette',
    label: 'Burette',
    eligible: false,
    reason:
      'Its full-scene path is documented, but its agent planning path is not integrated here.',
  },
] as const;

const CLAIM_MODULE =
  'Decide the exact physical relationship the question asks the image to explain. Make those atoms, residues, domains, or chains visually dominant; retain only context needed to locate or interpret them. Subdue unrelated structure. A colorful whole-protein overview is insufficient if the answer remains hard to see.';
const CAMERA_MODULE =
  'Set an intentional camera position, target, orientation, and scale for that relationship. Inspect the rendered image at chat-card size. If the target is tiny, hidden, or clipped, change the camera and inspect again before saving. A centered default fit is not evidence of a useful view.';
const APPEARANCE_MODULE =
  'Choose representations and a cohesive, energetic palette for this question. When showing specific side chains or chemical contacts atomistically, prefer element-based atom colors so chemistry remains legible. Consider selective pocket or interface surfaces when they reveal shape; avoid surfaces that hide the relevant atoms. Treat these as visual judgments, not mandatory renderer rules.';
const CONTEXT_MODULE =
  'Decide which surrounding parts let a viewer locate and interpret the answer. Prefer drawing that context quietly over deleting most of the loaded structure. If a broad view obscures the crucial detail at chat-card size, make related overview and detail story steps with intentional cameras. This is a judgment for each question, not a requirement to show every chain or residue.';

export const MOLECULAR_COMPARISON_PROFILES = [
  {
    id: 'dnaforge',
    label: 'Current prompt',
    summary: 'DNAForge’s existing protein-view instructions, with no added visual module.',
    instructions: '',
  },
  {
    id: 'claim-v1',
    label: 'Claim first · v1',
    summary: 'Choose the exact visual claim and reduce irrelevant context.',
    instructions: CLAIM_MODULE,
  },
  {
    id: 'camera-v1',
    label: 'Claim + camera · v1',
    summary: 'Add deliberate angle, target, scale, and rendered-image review.',
    instructions: `${CLAIM_MODULE}\n${CAMERA_MODULE}`,
  },
  {
    id: 'appearance-v1',
    label: 'Claim + camera + appearance · v1',
    summary: 'Add atom-color, selective-surface, and palette guidance.',
    instructions: `${CLAIM_MODULE}\n${CAMERA_MODULE}\n${APPEARANCE_MODULE}`,
  },
  {
    id: 'context-v1',
    label: 'Claim + camera + context · v1',
    summary:
      'Keep enough subdued 3D context to orient the viewer; use related views when detail and overview conflict.',
    instructions: `${CLAIM_MODULE}\n${CAMERA_MODULE}\n${APPEARANCE_MODULE}\n${CONTEXT_MODULE}`,
  },
] as const;

export type MolecularComparisonProfileId = (typeof MOLECULAR_COMPARISON_PROFILES)[number]['id'];

const PROFILE_STORAGE_KEY = 'dnaforge:protein-comparison-profile';
const CASE_STORAGE_KEY = 'dnaforge:protein-comparison-case-v1';
export const MOLECULAR_COMPARISON_CHANGE_EVENT = 'dnaforge:protein-comparison-profile-change';

export function molecularBenchmarkCase(id: MolecularBenchmarkCaseId | null) {
  return MOLECULAR_BENCHMARK_CASES.find((item) => item.id === id) ?? null;
}

export function readMolecularBenchmarkCase(): MolecularBenchmarkCaseId | null {
  try {
    const stored = localStorage.getItem(CASE_STORAGE_KEY);
    return MOLECULAR_BENCHMARK_CASES.find((item) => item.id === stored)?.id ?? null;
  } catch {
    return null;
  }
}

export function writeMolecularBenchmarkCase(id: MolecularBenchmarkCaseId | null): void {
  if (id !== null && !molecularBenchmarkCase(id)) return;
  try {
    if (id) localStorage.setItem(CASE_STORAGE_KEY, id);
    else localStorage.removeItem(CASE_STORAGE_KEY);
  } catch {
    return;
  }
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(MOLECULAR_COMPARISON_CHANGE_EVENT));
}

export function molecularComparisonProfile(id: string) {
  return (
    MOLECULAR_COMPARISON_PROFILES.find((profile) => profile.id === id) ??
    MOLECULAR_COMPARISON_PROFILES[0]
  );
}

export function readMolecularComparisonProfile(): MolecularComparisonProfileId {
  try {
    const stored = localStorage.getItem(PROFILE_STORAGE_KEY);
    return MOLECULAR_COMPARISON_PROFILES.find((profile) => profile.id === stored)?.id ?? 'dnaforge';
  } catch {
    return 'dnaforge';
  }
}

export function writeMolecularComparisonProfile(id: MolecularComparisonProfileId): void {
  if (!MOLECULAR_COMPARISON_PROFILES.some((profile) => profile.id === id)) return;
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, id);
  } catch {
    return;
  }
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(MOLECULAR_COMPARISON_CHANGE_EVENT));
}

export function molecularComparisonInstructions(
  id: MolecularComparisonProfileId,
  caseId: MolecularBenchmarkCaseId | null = null
): string {
  const profile = molecularComparisonProfile(id);
  const fixture = molecularBenchmarkCase(caseId);
  if (!fixture)
    return profile.instructions ? `Prompt module ${profile.id}:\n${profile.instructions}` : '';
  const fixtureInstructions = `Fixed protein benchmark context (v1): Use only the specified experimental structure identity and supplied scientific context for this trial. Do not switch to a different PDB entry or add outside scientific claims. Inspect the loaded coordinates to verify selectors. If the fixed resource is unavailable, report that failure instead of substituting another. The user’s message is only the ordinary question.\nStructure: ${fixture.fixtureIds.join(' + ')}.\n${fixture.context}`;
  const moduleInstructions = profile.instructions
    ? `\nPrompt module ${profile.id}:\n${profile.instructions}`
    : '';
  return `${fixtureInstructions}${moduleInstructions}`;
}
