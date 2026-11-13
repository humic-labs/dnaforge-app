import { describe, expect, it } from 'vitest';
import { ENZYME_SPECS } from './types';
import { loadMocloKitTemplates, findMocloKitTemplate } from './moclo-kit-templates';
import { mocloAssemblySchemaOptions, parseMocloKitDefinition } from './moclo-kit-definition';
import { validateGoldenGateSchema } from './golden-gate-schema';
import CIDAR_RAW from '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/cidar.json?raw';

const templates = await loadMocloKitTemplates();

describe('bundled MoClo kit templates', () => {
  it('ships a substantial, uniquely identified library', () => {
    expect(templates.length).toBeGreaterThanOrEqual(50);
    expect(
      templates.flatMap((template) => template.definition.assemblySchemas).length
    ).toBeGreaterThanOrEqual(120);
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
    expect(new Set(templates.map((template) => template.definition.id)).size).toBe(
      templates.length
    );
  });

  it('carries no part sequences, only architecture', () => {
    for (const template of templates) {
      expect(template.definition.members, template.id).toEqual([]);
    }
  });

  it('cites a source for every kit', () => {
    for (const template of templates) {
      expect(template.definition.citations.length, template.id).toBeGreaterThan(0);
      for (const citation of template.definition.citations) {
        expect(citation.label.trim().length, template.id).toBeGreaterThan(0);
      }
    }
  });

  it('points at a real Addgene kit whenever it claims one', () => {
    for (const template of templates) {
      if (!template.addgene) continue;
      expect(template.addgene.kitId, template.id).toMatch(/^\d{10}$/);
      expect(template.addgene.url, template.id).toMatch(/^https:\/\/www\.addgene\.org\//);
    }
  });

  it('defines at least one usable layout per kit', () => {
    for (const template of templates) {
      const options = mocloAssemblySchemaOptions(template.definition);
      expect(options.length, template.id).toBeGreaterThan(0);
    }
  });

  it('passes the product validator that a saved kit must pass', () => {
    for (const template of templates) {
      for (const option of mocloAssemblySchemaOptions(template.definition)) {
        const validation = validateGoldenGateSchema(option.schema, option.topology);
        expect(
          validation.ok,
          `${template.id} / ${option.schema.id}: ${validation.ok ? '' : validation.issues.map((issue) => issue.message).join(' ')}`
        ).toBe(true);
      }
    }
  });

  it('uses overhangs of the length its enzyme actually leaves', () => {
    for (const template of templates) {
      for (const layout of template.definition.assemblySchemas) {
        const expected = ENZYME_SPECS[layout.enzyme].overhangLength;
        for (const slot of layout.slots) {
          if (slot.outgoingOverhang === null) continue;
          expect(
            slot.outgoingOverhang,
            `${template.id} / ${layout.id} / ${slot.id} (${layout.enzyme})`
          ).toMatch(new RegExp(`^[ACGT]{${expected}}$`));
        }
      }
    }
  });

  it('never repeats a junction inside one layout, which would ligate wrongly', () => {
    for (const template of templates) {
      for (const layout of template.definition.assemblySchemas) {
        const overhangs = layout.slots
          .map((slot) => slot.outgoingOverhang)
          .filter((overhang): overhang is string => overhang !== null);
        expect(new Set(overhangs).size, `${template.id} / ${layout.id}`).toBe(overhangs.length);
      }
    }
  });

  it('defines at least one real junction in every layout', () => {
    for (const template of templates) {
      for (const layout of template.definition.assemblySchemas) {
        const defined = layout.slots.filter((slot) => slot.outgoingOverhang !== null);
        expect(defined.length, `${template.id} / ${layout.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('survives a save/reload round trip through the kit parser', () => {
    for (const template of templates) {
      const reparsed = parseMocloKitDefinition(JSON.stringify(template.definition), template.id);
      expect(reparsed, template.id).toEqual(template.definition);
    }
  });

  it('agrees with the independently bundled CIDAR kit on its transcription unit', () => {
    const bundled = parseMocloKitDefinition(CIDAR_RAW);
    const bundledUnit = mocloAssemblySchemaOptions(bundled).find(
      (option) => option.schema.slots.length === 5
    );
    const template = templates.find((entry) => entry.definition.name.includes('CIDAR'));
    expect(template).toBeDefined();
    const templateUnit = mocloAssemblySchemaOptions(template!.definition).find(
      (option) => option.schema.slots.length === 5
    );
    expect(templateUnit).toBeDefined();
    expect(templateUnit!.schema.enzyme).toBe(bundledUnit!.schema.enzyme);
    expect(templateUnit!.schema.slots.map((slot) => slot.outgoingOverhang)).toEqual(
      bundledUnit!.schema.slots.map((slot) => slot.outgoingOverhang)
    );
  });

  it('finds a template by id', async () => {
    const first = templates[0];
    expect((await findMocloKitTemplate(first.id))?.definition.name).toBe(first.definition.name);
    expect(await findMocloKitTemplate('no-such-kit')).toBeUndefined();
  });
});
