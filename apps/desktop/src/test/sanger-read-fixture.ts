export function sangerRead() {
  const tags = [
    { tag: 'FWO_', id: 1, size: 1, values: [...Buffer.from('GATC')] },
    { tag: 'PBAS', id: 2, size: 1, values: [...Buffer.from('AC')] },
    { tag: 'PCON', id: 2, size: 1, values: [27, 39] },
    { tag: 'PLOC', id: 2, size: 2, values: [1, 4] },
    ...[9, 10, 11, 12].map((id) => ({
      tag: 'DATA',
      id,
      size: 2,
      values: Array.from({ length: 33_000 }, (_, i) => i % 17),
    })),
  ];
  const offset = 34;
  let dataOffset = offset + tags.length * 28;
  const bytes = Buffer.alloc(dataOffset + 4 * 33_000 * 2);
  bytes.write('ABIF');
  bytes.writeUInt16BE(101, 4);
  bytes.writeInt32BE(tags.length, 18);
  bytes.writeInt32BE(offset, 26);
  tags.forEach(({ tag, id, size, values }, index) => {
    const entry = offset + index * 28;
    bytes.write(tag, entry);
    bytes.writeInt32BE(id, entry + 4);
    bytes.writeInt16BE(size, entry + 10);
    bytes.writeInt32BE(values.length, entry + 12);
    bytes.writeInt32BE(values.length * size, entry + 16);
    let payload = entry + 20;
    if (values.length * size > 4) {
      payload = dataOffset;
      bytes.writeInt32BE(payload, entry + 20);
      dataOffset += values.length * size;
    }
    for (let i = 0; i < values.length; i++) bytes.writeUIntBE(values[i], payload + i * size, size);
  });
  return new Uint8Array(bytes);
}
