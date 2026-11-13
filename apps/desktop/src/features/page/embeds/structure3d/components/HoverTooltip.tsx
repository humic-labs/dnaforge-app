'use client';

import { memo } from 'react';
import type { ResidueLocation } from '../types';

const AMINO_ACID_NAMES: Record<string, string> = {
  ALA: 'Alanine',
  ARG: 'Arginine',
  ASN: 'Asparagine',
  ASP: 'Aspartic acid',
  CYS: 'Cysteine',
  GLU: 'Glutamic acid',
  GLN: 'Glutamine',
  GLY: 'Glycine',
  HIS: 'Histidine',
  ILE: 'Isoleucine',
  LEU: 'Leucine',
  LYS: 'Lysine',
  MET: 'Methionine',
  PHE: 'Phenylalanine',
  PRO: 'Proline',
  SER: 'Serine',
  THR: 'Threonine',
  TRP: 'Tryptophan',
  TYR: 'Tyrosine',
  VAL: 'Valine',
  SEC: 'Selenocysteine',
  PYL: 'Pyrrolysine',
  MSE: 'Selenomethionine',
  HYP: 'Hydroxyproline',
  TPO: 'Phosphothreonine',
  SEP: 'Phosphoserine',
  PTR: 'Phosphotyrosine',
  MLY: 'N,N-dimethyllysine',
  MLZ: 'N-methyllysine',
  M3L: 'N,N,N-trimethyllysine',
  ALY: 'N-acetyllysine',
  CSO: 'S-hydroxycysteine',
  CSD: '3-sulfinoalanine',
  OCS: 'Cysteinesulfonic acid',
  NEP: 'N1-phosphonohistidine',
  HIC: '3-methylhistidine',
  CGU: 'Gamma-carboxyglutamic acid',
  DA: 'Deoxyadenosine',
  DC: 'Deoxycytidine',
  DG: 'Deoxyguanosine',
  DT: 'Deoxythymidine',
  A: 'Adenosine',
  C: 'Cytidine',
  G: 'Guanosine',
  U: 'Uridine',
};

const LIGAND_NAMES: Record<string, string> = {
  MG: 'Magnesium ion',
  CA: 'Calcium ion',
  ZN: 'Zinc ion',
  FE: 'Iron ion',
  MN: 'Manganese ion',
  CU: 'Copper ion',
  NA: 'Sodium ion',
  K: 'Potassium ion',
  CL: 'Chloride ion',
  ATP: 'Adenosine triphosphate',
  ADP: 'Adenosine diphosphate',
  AMP: 'Adenosine monophosphate',
  GTP: 'Guanosine triphosphate',
  GDP: 'Guanosine diphosphate',
  NAD: 'Nicotinamide adenine dinucleotide',
  FAD: 'Flavin adenine dinucleotide',
  HEM: 'Heme',
  EST: 'Estradiol',
};

interface HoverTooltipProps {
  hovered: ResidueLocation | null;
  residueName3?: string;
}

export const HoverTooltip = memo(function HoverTooltip({
  hovered,
  residueName3,
}: HoverTooltipProps) {
  if (!hovered) return null;

  const isLigand = !!hovered.compId;
  const name3 = hovered.compId || residueName3 || '';
  const fullName = isLigand ? LIGAND_NAMES[name3] || name3 : AMINO_ACID_NAMES[name3] || name3;
  return (
    <div
      data-testid="structure-hover-tooltip"
      data-placement="below-controls"
      className="absolute right-2 top-12 z-20 pointer-events-none"
    >
      <div className="bg-bg border border-border rounded-md shadow-lg px-2.5 py-1.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg-muted">
            {hovered.chain}:{hovered.position}
          </span>

          {name3 && (
            <>
              <span className="text-fg-subtle">•</span>
              <span className="font-semibold text-fg">{isLigand ? name3 : fullName}</span>
            </>
          )}

          {isLigand && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-600">
              {LIGAND_NAMES[name3]?.includes('ion') ? 'Ion' : 'Ligand'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
