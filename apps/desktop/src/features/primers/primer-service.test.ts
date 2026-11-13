import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  updatePrimer,
  deletePrimer,
  searchPrimers,
  deleteBinding,
  listBoundPrimers,
} from './primer-service';

const mockExecute = vi.fn();
const mockSelect = vi.fn();

vi.mock('../../platform', () => ({
  platform: () => ({
    db: {
      execute: mockExecute,
      select: mockSelect,
    },
  }),
}));

function mockDbRow(overrides?: Record<string, unknown>) {
  return {
    id: 'test-uuid-1',
    catalog_number: 'P042',
    name: 'lacZ_F1',
    sequence: 'ATCGATCGATCGATCGATCG',
    length: 20,
    tm: 58.4,
    gc_percent: 50.0,
    origin: 'manual',
    origin_details: null,
    status: 'designed',
    vendor: null,
    order_date: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stock_location: null,
    concentration: null,
    notes: null,
    workspace_id: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function mockBoundPrimerRow(overrides?: Record<string, unknown>) {
  return {
    ...mockDbRow(),
    binding_id: 'bind-1',
    binding_start: 100,
    binding_end: 120,
    strand: 1,
    source: 'manual',
    binding_created_at: Date.now(),
    binding_updated_at: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mockExecute.mockResolvedValue({ changes: 1, lastInsertRowid: 1 });
  mockSelect.mockResolvedValue([]);
});

describe('primer-service', () => {
  it('returns null when updating a missing primer', async () => {
    expect(await updatePrimer({ id: 'missing', name: 'No record' })).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns not_found when deleting a missing primer', async () => {
    expect(await deletePrimer('missing')).toEqual({ deleted: false, reason: 'not_found' });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  describe('searchPrimers', () => {
    it('searches by name substring (case-insensitive)', async () => {
      mockSelect.mockResolvedValue([
        mockDbRow({ name: 'lacZ_F1' }),
        mockDbRow({ name: 'lacZ_R1', id: 'test-uuid-2' }),
      ]);

      const results = await searchPrimers({ query: 'lacz' });

      expect(mockSelect).toHaveBeenCalledWith(
        expect.stringMatching(/LIKE/i),
        expect.arrayContaining(['%lacz%'])
      );
      expect(results).toHaveLength(2);
    });

    it('searches by sequence substring', async () => {
      mockSelect.mockResolvedValue([mockDbRow()]);

      const results = await searchPrimers({ query: 'ATCGATCG' });

      expect(mockSelect).toHaveBeenCalledWith(expect.stringMatching(/LIKE/i), expect.any(Array));
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', async () => {
      mockSelect.mockResolvedValue([mockDbRow({ status: 'ordered' })]);

      const results = await searchPrimers({ status: 'ordered' });

      expect(mockSelect).toHaveBeenCalledWith(
        expect.stringMatching(/status/i),
        expect.arrayContaining(['ordered'])
      );
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('ordered');
    });

    it('filters by application', async () => {
      mockSelect.mockResolvedValue([mockDbRow({ application: 'pcr' })]);

      const results = await searchPrimers({ application: 'pcr' });

      expect(mockSelect).toHaveBeenCalledWith(
        expect.stringMatching(/application/i),
        expect.arrayContaining(['pcr'])
      );
      expect(results).toHaveLength(1);
    });

    it('returns empty array for no matches', async () => {
      mockSelect.mockResolvedValue([]);

      const results = await searchPrimers({ query: 'nonexistent' });
      expect(results).toEqual([]);
    });

    it('paginates results', async () => {
      mockSelect.mockResolvedValue([]);

      await searchPrimers({ limit: 10, offset: 20 });

      expect(mockSelect).toHaveBeenCalledWith(
        expect.stringMatching(/LIMIT.*OFFSET/i),
        expect.arrayContaining([10, 20])
      );
    });
  });

  it('leaves a missing binding unchanged', async () => {
    await deleteBinding('missing');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  describe('listBoundPrimers', () => {
    it('returns primers bound to a specific sequence', async () => {
      mockSelect.mockResolvedValueOnce([mockBoundPrimerRow()]);

      const result = await listBoundPrimers(42);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-uuid-1');
      expect(result[0].name).toBe('lacZ_F1');
      expect(result[0].binding.id).toBe('bind-1');
      expect(result[0].binding.bindingStart).toBe(100);
      expect(result[0].binding.bindingEnd).toBe(120);
      expect(result[0].binding.strand).toBe(1);
      expect(result[0].binding.source).toBe('manual');

      expect(mockSelect).toHaveBeenCalledWith(
        expect.stringContaining('JOIN primers p ON pb.primer_id = p.id'),
        [42]
      );
      expect(mockSelect).toHaveBeenCalledWith(
        expect.stringContaining('WHERE pb.sequence_id = ?'),
        expect.any(Array)
      );
    });

    it('returns empty array for sequence with no bindings', async () => {
      mockSelect.mockResolvedValueOnce([]);

      const result = await listBoundPrimers(999);

      expect(result).toEqual([]);
    });

    it('returns multiple primers sorted by binding_start', async () => {
      mockSelect.mockResolvedValueOnce([
        mockBoundPrimerRow({ binding_start: 100, binding_id: 'b1' }),
        mockBoundPrimerRow({
          binding_start: 500,
          binding_id: 'b2',
          id: 'primer-2',
        }),
      ]);

      const result = await listBoundPrimers(42);

      expect(result).toHaveLength(2);
      expect(mockSelect).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY pb.binding_start'),
        expect.any(Array)
      );
    });
  });
});
