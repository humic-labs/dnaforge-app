// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isValidChainId,
  extractChainId,
  isValidCompId,
  getUnitOperatorName,
  getOperatorSuffix,
  extractEffectiveChainInfo,
  parseEffectiveChainId,
  WATER_RESIDUES,
  STANDARD_RESIDUES,
} from './molstarChainUtils';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('molstarChainUtils', () => {
  describe('isValidChainId', () => {
    it('should accept single letter chain IDs', () => {
      expect(isValidChainId('A')).toBe(true);
      expect(isValidChainId('B')).toBe(true);
      expect(isValidChainId('Z')).toBe(true);
    });

    it('should accept multi-letter chain IDs (up to 4 chars)', () => {
      expect(isValidChainId('AA')).toBe(true);
      expect(isValidChainId('ABC')).toBe(true);
      expect(isValidChainId('ABCD')).toBe(true);
    });

    it('should accept alphanumeric chain IDs', () => {
      expect(isValidChainId('A1')).toBe(true);
      expect(isValidChainId('1A')).toBe(true);
      expect(isValidChainId('123')).toBe(true);
    });

    it('should reject empty string', () => {
      expect(isValidChainId('')).toBe(false);
    });

    it('should reject chain IDs longer than 4 chars', () => {
      expect(isValidChainId('ABCDE')).toBe(false);
    });

    it('should reject non-alphanumeric characters', () => {
      expect(isValidChainId('A-B')).toBe(false);
      expect(isValidChainId('A_B')).toBe(false);
      expect(isValidChainId('A B')).toBe(false);
    });

    it('should reject non-string types', () => {
      expect(isValidChainId(null)).toBe(false);
      expect(isValidChainId(undefined)).toBe(false);
      expect(isValidChainId(123)).toBe(false);
      expect(isValidChainId({})).toBe(false);
    });
  });

  describe('extractChainId', () => {
    it('should prefer label_asym_id over auth_asym_id', () => {
      const chainTable = {
        label_asym_id: { value: () => 'B' },
        auth_asym_id: { value: () => 'A' },
      };
      expect(extractChainId(chainTable, 0)).toBe('B');
    });

    it('should fall back to auth_asym_id if label_asym_id is invalid', () => {
      const chainTable = {
        label_asym_id: { value: () => '' },
        auth_asym_id: { value: () => 'A' },
      };
      expect(extractChainId(chainTable, 0)).toBe('A');
    });

    it('should return null if both are invalid', () => {
      const chainTable = {
        label_asym_id: { value: () => '' },
        auth_asym_id: { value: () => null },
      };
      expect(extractChainId(chainTable, 0)).toBe(null);
    });

    it('should handle missing label_asym_id', () => {
      const chainTable = {
        auth_asym_id: { value: () => 'A' },
      };
      expect(extractChainId(chainTable, 0)).toBe('A');
    });

    it('should handle missing auth_asym_id', () => {
      const chainTable = {
        label_asym_id: { value: () => 'A' },
      };
      expect(extractChainId(chainTable, 0)).toBe('A');
    });

    it('should pass chainIdx to value function', () => {
      const valueFn = vi.fn().mockReturnValue('A');
      const chainTable = {
        label_asym_id: { value: valueFn },
      };
      extractChainId(chainTable, 5);
      expect(valueFn).toHaveBeenCalledWith(5);
    });
  });

  describe('isValidCompId', () => {
    it('should accept standard amino acid codes', () => {
      expect(isValidCompId('ALA')).toBe(true);
      expect(isValidCompId('GLY')).toBe(true);
      expect(isValidCompId('TRP')).toBe(true);
    });

    it('should accept ligand codes', () => {
      expect(isValidCompId('NAG')).toBe(true);
      expect(isValidCompId('MG')).toBe(true);
      expect(isValidCompId('ATP')).toBe(true);
    });

    it('should accept modified residue codes', () => {
      expect(isValidCompId('TPO')).toBe(true);
      expect(isValidCompId('SEP')).toBe(true);
    });

    it('should reject empty string', () => {
      expect(isValidCompId('')).toBe(false);
    });

    it('should reject codes longer than 10 chars', () => {
      expect(isValidCompId('VERYLONGCODE')).toBe(false);
    });

    it('should reject non-alphanumeric', () => {
      expect(isValidCompId('ALA-1')).toBe(false);
    });
  });

  describe('WATER_RESIDUES', () => {
    it('should contain common water residue names', () => {
      expect(WATER_RESIDUES.has('HOH')).toBe(true);
      expect(WATER_RESIDUES.has('WAT')).toBe(true);
      expect(WATER_RESIDUES.has('H2O')).toBe(true);
    });

    it('should not contain amino acids', () => {
      expect(WATER_RESIDUES.has('ALA')).toBe(false);
    });
  });

  describe('STANDARD_RESIDUES', () => {
    it('should contain all 20 standard amino acids', () => {
      const standardAA = [
        'ALA',
        'ARG',
        'ASN',
        'ASP',
        'CYS',
        'GLU',
        'GLN',
        'GLY',
        'HIS',
        'ILE',
        'LEU',
        'LYS',
        'MET',
        'PHE',
        'PRO',
        'SER',
        'THR',
        'TRP',
        'TYR',
        'VAL',
      ];
      for (const aa of standardAA) {
        expect(STANDARD_RESIDUES.has(aa)).toBe(true);
      }
    });

    it('should contain nucleotides', () => {
      expect(STANDARD_RESIDUES.has('DA')).toBe(true);
      expect(STANDARD_RESIDUES.has('A')).toBe(true);
      expect(STANDARD_RESIDUES.has('U')).toBe(true);
    });

    it('should not contain PTM codes', () => {
      expect(STANDARD_RESIDUES.has('TPO')).toBe(false);
      expect(STANDARD_RESIDUES.has('SEP')).toBe(false);
    });
  });

  describe('getUnitOperatorName', () => {
    it('should extract operator name from unit.conformation.operator', () => {
      const unit = {
        conformation: {
          operator: {
            name: '2_555',
          },
        },
      };
      expect(getUnitOperatorName(unit)).toBe('2_555');
    });

    it('should handle biological assembly operators', () => {
      const unit = {
        conformation: {
          operator: {
            name: 'ASM_2',
          },
        },
      };
      expect(getUnitOperatorName(unit)).toBe('ASM_2');
    });

    it('should return identity operator if no operator present', () => {
      expect(getUnitOperatorName({})).toBe('1_555');
      expect(getUnitOperatorName({ conformation: {} })).toBe('1_555');
      expect(getUnitOperatorName({ conformation: { operator: {} } })).toBe('1_555');
    });

    it('should return identity operator for empty operator name', () => {
      const unit = {
        conformation: {
          operator: {
            name: '',
          },
        },
      };
      expect(getUnitOperatorName(unit)).toBe('1_555');
    });
  });

  describe('getOperatorSuffix', () => {
    describe('crystal symmetry operators', () => {
      it('should return empty string for identity operator 1_555', () => {
        expect(getOperatorSuffix('1_555')).toBe('');
      });

      it('should return "2" for operator 2_555', () => {
        expect(getOperatorSuffix('2_555')).toBe('2');
      });

      it('should return "3" for operator 3_555', () => {
        expect(getOperatorSuffix('3_555')).toBe('3');
      });

      it('should handle higher numbers', () => {
        expect(getOperatorSuffix('10_555')).toBe('10');
      });
    });

    describe('biological assembly operators (underscore format)', () => {
      it('should return empty string for ASM_1 (identity)', () => {
        expect(getOperatorSuffix('ASM_1')).toBe('');
      });

      it('should return "2" for ASM_2', () => {
        expect(getOperatorSuffix('ASM_2')).toBe('2');
      });

      it('should return "3" for ASM_3', () => {
        expect(getOperatorSuffix('ASM_3')).toBe('3');
      });
    });

    describe('biological assembly operators (hyphen format)', () => {
      it('should handle ASM-1 (hyphen variant)', () => {
        expect(getOperatorSuffix('ASM-1')).toBe('');
      });

      it('should handle ASM-2 (hyphen variant)', () => {
        expect(getOperatorSuffix('ASM-2')).toBe('2');
      });
    });

    describe('edge cases', () => {
      it('should return empty string for empty input', () => {
        expect(getOperatorSuffix('')).toBe('');
      });

      it('should return empty string for unrecognized format', () => {
        expect(getOperatorSuffix('UNKNOWN')).toBe('');
      });
    });
  });

  describe('extractEffectiveChainInfo', () => {
    it('should create simple chain ID for identity operator', () => {
      const unit = {
        id: 0,
        conformation: {
          operator: {
            name: '1_555',
          },
        },
      };
      const chainTable = {
        label_asym_id: { value: () => 'A' },
      };

      const result = extractEffectiveChainInfo(unit, chainTable, 0);

      expect(result).toMatchObject({
        effectiveChainId: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        operator: '1_555',
        isPrimary: true,
      });
    });

    it('should create suffixed chain ID for non-identity operator', () => {
      const unit = {
        id: 1,
        conformation: {
          operator: {
            name: '2_555',
          },
        },
      };
      const chainTable = {
        label_asym_id: { value: () => 'A' },
      };

      const result = extractEffectiveChainInfo(unit, chainTable, 0);

      expect(result).toMatchObject({
        effectiveChainId: 'A2',
        baseChain: 'A',
        labelAsymId: 'A',
        operator: '2_555',
        isPrimary: false,
      });
    });

    it('should handle ASM_1 as primary', () => {
      const unit = {
        id: 0,
        conformation: {
          operator: {
            name: 'ASM_1',
          },
        },
      };
      const chainTable = {
        label_asym_id: { value: () => 'B' },
      };

      const result = extractEffectiveChainInfo(unit, chainTable, 0);

      expect(result).toMatchObject({
        effectiveChainId: 'B',
        baseChain: 'B',
        labelAsymId: 'B',
        operator: 'ASM_1',
        isPrimary: true,
      });
    });

    it('should handle ASM_2 with suffix', () => {
      const unit = {
        id: 1,
        conformation: {
          operator: {
            name: 'ASM_2',
          },
        },
      };
      const chainTable = {
        label_asym_id: { value: () => 'A' },
      };

      const result = extractEffectiveChainInfo(unit, chainTable, 0);

      expect(result).toMatchObject({
        effectiveChainId: 'A2',
        baseChain: 'A',
        labelAsymId: 'A',
        operator: 'ASM_2',
        isPrimary: false,
      });
    });

    it('should preserve label_entity_id for RCSB entity scope matching', () => {
      const unit = {
        id: 0,
        conformation: {
          operator: {
            name: '1_555',
          },
        },
      };
      const chainTable = {
        label_asym_id: { value: () => 'A' },
        auth_asym_id: { value: () => 'H' },
        label_entity_id: { value: () => '1' },
      };

      const result = extractEffectiveChainInfo(unit, chainTable, 0);

      expect(result).toMatchObject({
        effectiveChainId: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
      });
    });

    it('should return null for invalid chain ID', () => {
      const unit = { id: 0 };
      const chainTable = {
        label_asym_id: { value: () => '' },
        auth_asym_id: { value: () => null },
      };

      const result = extractEffectiveChainInfo(unit, chainTable, 0);

      expect(result).toBe(null);
    });

    it('should handle dimer with same base chain ID', () => {
      const unit1 = {
        id: 0,
        conformation: { operator: { name: 'ASM_1' } },
      };
      const chainTable = { label_asym_id: { value: () => 'A' } };

      const result1 = extractEffectiveChainInfo(unit1, chainTable, 0);
      expect(result1?.effectiveChainId).toBe('A');

      const unit2 = {
        id: 1,
        conformation: { operator: { name: 'ASM_2' } },
      };

      const result2 = extractEffectiveChainInfo(unit2, chainTable, 0);
      expect(result2?.effectiveChainId).toBe('A2');

      expect(result1?.effectiveChainId).not.toBe(result2?.effectiveChainId);
    });
  });

  describe('parseEffectiveChainId', () => {
    it('should parse simple chain ID', () => {
      expect(parseEffectiveChainId('A')).toEqual({
        baseChain: 'A',
        operatorSuffix: '',
      });
    });

    it('should parse chain ID with single digit suffix', () => {
      expect(parseEffectiveChainId('A2')).toEqual({
        baseChain: 'A',
        operatorSuffix: '2',
      });
    });

    it('should parse chain ID with multi-digit suffix', () => {
      expect(parseEffectiveChainId('A10')).toEqual({
        baseChain: 'A',
        operatorSuffix: '10',
      });
    });

    it('should parse multi-letter chain ID with suffix', () => {
      expect(parseEffectiveChainId('BC3')).toEqual({
        baseChain: 'BC',
        operatorSuffix: '3',
      });
    });

    it('should handle chain ID that is just letters', () => {
      expect(parseEffectiveChainId('ABC')).toEqual({
        baseChain: 'ABC',
        operatorSuffix: '',
      });
    });

    it('should handle numeric-only chain IDs as fallback', () => {
      expect(parseEffectiveChainId('123')).toEqual({
        baseChain: '123',
        operatorSuffix: '',
      });
    });

    it('should be the inverse of effectiveChainId creation', () => {
      const baseChain = 'A';
      const suffix = '2';
      const effectiveChainId = baseChain + suffix;

      const parsed = parseEffectiveChainId(effectiveChainId);
      expect(parsed.baseChain).toBe(baseChain);
      expect(parsed.operatorSuffix).toBe(suffix);
    });
  });
});
