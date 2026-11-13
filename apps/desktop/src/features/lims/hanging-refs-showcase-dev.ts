import { platform } from '../../platform';
import { createLimsImportPlan, applyAcceptedLimsImportPlan } from './ingress';
import { emitLimsRegistrationChanged } from './events';

async function importStrainCsv(text: string): Promise<void> {
  const plan = await createLimsImportPlan({ fileName: 'showcase-strains.csv', text });
  await applyAcceptedLimsImportPlan(plan, { actor: 'hanging-refs-showcase' });
}

export async function runHangingRefsShowcase(): Promise<void> {
  const lims = platform().lims;
  await lims.resetRegistry();

  await importStrainCsv(
    [
      'Strain,Genotype,Parent Strain',
      'MG1655-derivative,ΔlacZ,MG1655',
      'ACME-7,ΔaraB,ACME-3',
      'CRISTAL-child,dCas9+,Backbone',
    ].join('\n')
  );

  await importStrainCsv(['Strain,Genotype', 'MG1655,wild-type'].join('\n'));

  await lims.registerEntity({
    kind: 'strain',
    name: 'Backbone',
    fields: { genotypeCanonical: 'pSC101-ori', species: 'E. coli' },
  });
  await lims.registerEntity({
    kind: 'strain',
    name: 'Backbone',
    fields: { genotypeCanonical: 'p15A-ori', species: 'E. coli' },
  });

  emitLimsRegistrationChanged();

  window.dispatchEvent(new CustomEvent('waypoint:open-lims-registry'));
}
