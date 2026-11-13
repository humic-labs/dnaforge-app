import { Structure, StructureElement, StructureSelection } from 'molstar/lib/mol-model/structure';
import { Script } from 'molstar/lib/mol-script/script';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';

export function molecularAtomKeys(source: Structure): Set<string> {
  return new Set(source.units.flatMap((u) => Array.from(u.elements, (a) => `${u.id}:${a}`)));
}

function subset(source: Structure, keys: Set<string>): Structure {
  const b = source.subsetBuilder(true);
  for (const u of source.units) {
    b.beginUnit(u.id);
    for (const a of Array.from(u.elements)) if (keys.has(`${u.id}:${a}`)) b.addElement(a);
    b.commitUnit();
  }
  return b.getStructure();
}

function around(source: Structure, selected: Structure, radius: number): Structure {
  if (!selected.elementCount) return subset(source, new Set());
  return StructureSelection.unionStructure(
    Script.getStructureSelection(
      MS.struct.modifier.includeSurroundings({
        0: StructureElement.Bundle.toExpression(
          StructureElement.Bundle.fromLoci(
            StructureElement.Loci.remap(Structure.toStructureElementLoci(selected), source)
          )
        ),
        radius,
        'as-whole-residues': true,
      }),
      source
    )
  );
}

export function molecularBindingDetail(
  source: Structure,
  seed: Structure,
  target: Structure,
  partner: Structure,
  radius: number,
  interfaceOnly: boolean,
  endpoints: readonly unknown[] = [],
  detailMode: 'neighborhood' | 'contact-residues' = 'neighborhood'
): Structure {
  const neighborhood = around(source, seed, radius);
  let included = molecularAtomKeys(neighborhood);
  if (interfaceOnly) {
    const nearbyPartner = subset(partner, included);
    const nearPartner = molecularAtomKeys(around(source, nearbyPartner, radius));
    const targetKeys = molecularAtomKeys(target);
    const partnerKeys = molecularAtomKeys(nearbyPartner);
    included = new Set(
      [...included].filter(
        (key) => partnerKeys.has(key) || (targetKeys.has(key) && nearPartner.has(key))
      )
    );
  }
  if (detailMode === 'contact-residues') included = new Set();
  const owners = new Set([...molecularAtomKeys(target), ...molecularAtomKeys(partner)]);
  for (const selector of endpoints) {
    const selected = substructureFromSelector(
      source,
      componentPropsFromSelector(selector as Parameters<typeof componentPropsFromSelector>[0])
    );
    const whole = StructureElement.Loci.toStructure(
      StructureElement.Loci.extendToWholeResidues(
        StructureElement.Loci.remap(Structure.toStructureElementLoci(selected), source)
      )
    );
    for (const key of molecularAtomKeys(whole)) if (owners.has(key)) included.add(key);
  }
  return subset(source, included);
}
