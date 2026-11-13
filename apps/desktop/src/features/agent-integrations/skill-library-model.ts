import { selectManagedSkills } from '../../shared/agent-capability-controls';
import type {
  AgentCapabilityControl,
  AgentCapabilitySnapshot,
  AgentManagedSkill,
} from '../../shared/agent-capability-controls';
import type { AgentTransport } from '../../shared/agent-runtime-ipc';

export interface NativeInstalledSkill {
  control: AgentCapabilityControl;
  snapshot: AgentCapabilitySnapshot;
}

export interface DiscoveredBiologyPlugin {
  control: AgentCapabilityControl;
  snapshot: AgentCapabilitySnapshot;
}

export type InstalledSkillSourceKey = AgentTransport | 'dnaforge';

export interface InstalledSkillRow {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  toggleable: boolean;
  unavailableReason: string | null;
  managedSkill: AgentManagedSkill | null;
  nativeSkill: NativeInstalledSkill | null;
  runtimes: AgentTransport[];
  sourceKey: InstalledSkillSourceKey;
  sourceLabel: string;
}

const RUNTIME_ORDER: AgentTransport[] = ['codex-sdk', 'claude-agent-sdk', 'grok-acp'];

const BIOLOGY_PLUGIN_PHRASES = [
  'drug discovery',
  'life science',
  'molecular biology',
  'single cell',
] as const;

const BIOLOGY_PLUGIN_TOKENS = new Set([
  'bio',
  'bioconda',
  'bioconductor',
  'bioinformatics',
  'biological',
  'biology',
  'biomedical',
  'biorender',
  'bioscience',
  'biosciences',
  'biotech',
  'biotechnology',
  'crispr',
  'dna',
  'genetic',
  'medchem',
  'nextflow',
  'ngs',
  'omics',
  'pharma',
  'plasmid',
  'primer',
  'protein',
  'pubmed',
  'rna',
  'rosalind',
  'sequencing',
]);

export function agentRuntimeLabel(provider: AgentTransport): string {
  if (provider === 'codex-sdk') return 'Codex';
  if (provider === 'claude-agent-sdk') return 'Claude Code';
  return 'Grok Build';
}

function canonicalSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[$/]+/u, '');
}

export function normalizeCapabilitySearchText(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function looksLikeBiologyPlugin(control: AgentCapabilityControl): boolean {
  const searchable = normalizeCapabilitySearchText(
    [control.nativeId, control.label, control.description].filter(Boolean).join(' ')
  );
  if (BIOLOGY_PLUGIN_PHRASES.some((phrase) => searchable.includes(phrase))) return true;
  return searchable
    .split(' ')
    .some(
      (token) =>
        BIOLOGY_PLUGIN_TOKENS.has(token) ||
        token.startsWith('genom') ||
        token.startsWith('proteom') ||
        token.startsWith('transcriptom') ||
        token.startsWith('metabolom')
    );
}

export function buildDiscoveredBiologyPlugins(
  providerSnapshots: readonly AgentCapabilitySnapshot[]
): DiscoveredBiologyPlugin[] {
  return providerSnapshots
    .flatMap((snapshot) =>
      snapshot.controls.flatMap((control) =>
        control.kind === 'plugin' && looksLikeBiologyPlugin(control) ? [{ control, snapshot }] : []
      )
    )
    .sort(
      (left, right) =>
        RUNTIME_ORDER.indexOf(left.control.provider) -
          RUNTIME_ORDER.indexOf(right.control.provider) ||
        left.control.label.localeCompare(right.control.label)
    );
}

export function buildInstalledSkillRows(
  managedSkills: readonly AgentManagedSkill[],
  providerSnapshots: readonly AgentCapabilitySnapshot[],
  workspacePath?: string | null
): InstalledSkillRow[] {
  const effectiveManagedSkills = new Map<
    string,
    { skill: AgentManagedSkill; runtimes: AgentTransport[] }
  >();
  for (const provider of RUNTIME_ORDER) {
    for (const skill of selectManagedSkills(managedSkills, provider, workspacePath)) {
      const key = `${skill.provider}:${canonicalSkillName(skill.name)}`;
      const row = effectiveManagedSkills.get(key) ?? { skill, runtimes: [] };
      row.runtimes.push(provider);
      effectiveManagedSkills.set(key, row);
    }
  }
  const rows: InstalledSkillRow[] = [...effectiveManagedSkills.entries()].map(
    ([key, { skill, runtimes }]) => ({
      key: `app:${key}`,
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      toggleable: true,
      unavailableReason: null,
      managedSkill: skill,
      nativeSkill: null,
      runtimes,
      sourceKey: skill.provider === 'all' ? 'dnaforge' : skill.provider,
      sourceLabel: skill.provider === 'all' ? 'DNAForge' : agentRuntimeLabel(skill.provider),
    })
  );

  for (const snapshot of providerSnapshots) {
    for (const control of snapshot.controls) {
      if (control.kind !== 'skill' || control.source?.startsWith('dnaforge-skill:')) continue;
      const policyDisabled = control.dnaforgePolicy?.enabled === false;
      const providerAvailable =
        control.availability.state === 'supported' && control.stages.invocable;
      rows.push({
        key: `native:${control.provider}:${control.id}`,
        name: control.label,
        description: control.description,
        enabled: providerAvailable && !policyDisabled,
        toggleable: policyDisabled || providerAvailable,
        unavailableReason:
          !policyDisabled && !providerAvailable
            ? (control.availability.reason ?? 'Enable this skill in its CLI before using it here.')
            : null,
        managedSkill: null,
        nativeSkill: { control, snapshot },
        runtimes: [control.provider],
        sourceKey: control.provider,
        sourceLabel: agentRuntimeLabel(control.provider),
      });
    }
  }

  return rows.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      Number(Boolean(right.managedSkill)) - Number(Boolean(left.managedSkill)) ||
      left.sourceLabel.localeCompare(right.sourceLabel)
  );
}
