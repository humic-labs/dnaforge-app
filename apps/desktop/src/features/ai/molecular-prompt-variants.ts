import { MOLECULAR_COMPARISON_PROFILES } from './molecular-comparison-profiles';
import type { MolecularPromptVariant } from './molecular-prompt-trials';

const CUSTOM_KEY = 'dnaforge:protein-prompt-custom-variants-v1';
const SELECTED_KEY = 'dnaforge:protein-prompt-selected-variants-v1';

export const BUILTIN_MOLECULAR_PROMPT_VARIANTS: MolecularPromptVariant[] =
  MOLECULAR_COMPARISON_PROFILES.map(({ id, label, instructions }) => ({
    id,
    label,
    instructions,
  }));

export function readCustomMolecularPromptVariants(): MolecularPromptVariant[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is MolecularPromptVariant =>
          item &&
          typeof item.id === 'string' &&
          item.id.startsWith('custom:') &&
          typeof item.label === 'string' &&
          item.label.trim().length > 0 &&
          typeof item.instructions === 'string' &&
          item.instructions.trim().length > 0
      )
      .slice(0, 50);
  } catch {
    return [];
  }
}

export function listMolecularPromptVariants(): MolecularPromptVariant[] {
  return [...BUILTIN_MOLECULAR_PROMPT_VARIANTS, ...readCustomMolecularPromptVariants()];
}

export function saveCustomMolecularPromptVariant(
  input: MolecularPromptVariant
): MolecularPromptVariant {
  const label = input.label.trim();
  const instructions = input.instructions.trim();
  if (
    !label ||
    label.length > 100 ||
    !instructions ||
    new TextEncoder().encode(instructions).length > 8_000
  )
    throw new Error('Name the prompt and keep its guidance under 8,000 bytes.');
  const existing = readCustomMolecularPromptVariants();
  if (input.id.startsWith('custom:')) {
    const previous = existing.find((item) => item.id === input.id);
    if (!previous) throw new Error('The custom prompt variant ID is unknown.');
    if (previous.label !== label || previous.instructions !== instructions)
      throw new Error('Prompt variants are immutable. Save the revision as a new variant.');
    return previous;
  }
  if (existing.length >= 50)
    throw new Error(
      'The 50 custom prompt choices are full. Remove an old choice before saving a new variant; recorded trials remain available.'
    );
  const id = `custom:${crypto.randomUUID()}`;
  const variant = { id, label, instructions };
  localStorage.setItem(CUSTOM_KEY, JSON.stringify([...existing, variant]));
  return variant;
}

export function removeCustomMolecularPromptVariant(id: string): void {
  if (!id.startsWith('custom:')) return;
  localStorage.setItem(
    CUSTOM_KEY,
    JSON.stringify(readCustomMolecularPromptVariants().filter((item) => item.id !== id))
  );
  writeSelectedMolecularPromptVariantIds(
    readSelectedMolecularPromptVariantIds().filter((selected) => selected !== id)
  );
}

export function readSelectedMolecularPromptVariantIds(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SELECTED_KEY) ?? 'null');
    const available = new Set(listMolecularPromptVariants().map((item) => item.id));
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter((id): id is string => typeof id === 'string' && available.has(id))
          ),
        ]
      : ['camera-v1', 'appearance-v1'];
  } catch {
    return ['camera-v1', 'appearance-v1'];
  }
}

export function writeSelectedMolecularPromptVariantIds(ids: string[]): void {
  localStorage.setItem(SELECTED_KEY, JSON.stringify(ids));
}
