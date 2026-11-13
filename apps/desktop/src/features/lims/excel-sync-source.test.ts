import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { readExcelSyncSource, type ExcelSyncSource } from './excel-sync-source';

const fs = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock('../../platform', () => ({ platform: () => ({ fs }) }));
vi.mock('../../db', () => ({ ensureSequenceIdentity: vi.fn(async () => 1) }));
vi.mock('./operations', () => ({
  queryLimsEntities: vi.fn(async () => []),
  applyLimsImportBatch: vi.fn(),
}));
const source: ExcelSyncSource = {
  path: '/chosen/master.xlsx',
  sheetName: 'Primers',
  keyColumn: 'Stable ID',
  forcedKind: 'oligo',
  columnMappings: [],
};
function workbook(name: string, sheetName = 'Primers') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['Stable ID', 'Name', 'Sequence'],
      ['001', name, 'GTAAAACGACGGCCAGT'],
    ]),
    sheetName
  );
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
}
beforeEach(() => vi.clearAllMocks());

describe('local Excel source pull', () => {
  it('binds each parsed snapshot to the exact bytes read and never modifies the master', async () => {
    const firstBytes = workbook('Before');
    const secondBytes = workbook('After');
    fs.readFile.mockResolvedValueOnce(firstBytes).mockResolvedValueOnce(secondBytes);
    const first = await readExcelSyncSource(source);
    const second = await readExcelSyncSource(source);
    expect(first.revision).toBe(`sha256:${createHash('sha256').update(firstBytes).digest('hex')}`);
    expect(second.revision).not.toBe(first.revision);
    expect(first.rows[0]).toMatchObject({ key: '001', record: { name: 'Before' } });
    expect(second.rows[0]).toMatchObject({ key: '001', record: { name: 'After' } });
    expect(fs.readFile).toHaveBeenNthCalledWith(1, source.path);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('fails when the chosen worksheet disappears rather than switching to another sheet', async () => {
    fs.readFile.mockResolvedValue(workbook('Other', 'Unrelated'));
    await expect(readExcelSyncSource(source)).rejects.toThrow();
  });

  it('propagates source access failures without writing', async () => {
    fs.readFile.mockRejectedValue(new Error('Permission denied'));
    await expect(readExcelSyncSource(source)).rejects.toThrow('Permission denied');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a removed mapped column rather than clearing its previously imported field', async () => {
    fs.readFile.mockResolvedValue(workbook('Before'));
    await expect(
      readExcelSyncSource({
        ...source,
        columnMappings: [
          { sourceColumn: 'Notes', mappingMode: 'mapped', mappedField: 'fields.notes' },
        ],
      })
    ).rejects.toThrow('Mapped spreadsheet columns are missing: Notes');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});
