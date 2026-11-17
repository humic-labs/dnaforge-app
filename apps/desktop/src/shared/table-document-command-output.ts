import type { TableDocumentCommandResult } from './table-document-command';

export function tableDocumentAgentResult(result: TableDocumentCommandResult) {
  if (!('table' in result) || result.table.owner.kind !== 'saved-version') return result;
  const { snapshot, snapshotSha256 } = result.table.owner;
  const data = snapshot.data;
  const rows = data.rows ?? data.cells?.length ?? 0;
  const columns = data.cols ?? data.cells?.[0]?.length ?? 0;
  let truncated = rows > 5 || columns > 5 || snapshot.title.length > 1000;
  const cells = (data.cells ?? []).slice(0, 5).map((row) =>
    row.slice(0, 5).map((cell) => {
      if (cell.value.length > 200) truncated = true;
      return { type: cell.type, value: cell.value.slice(0, 200) };
    })
  );
  return {
    ...result,
    table: {
      ...result.table,
      owner: { kind: 'saved-version' as const, snapshotSha256 },
      inspection: {
        title: snapshot.title.slice(0, 1000),
        rows,
        columns,
        rowOffset: 0,
        columnOffset: 0,
        cells,
        truncated,
      },
    },
  };
}
