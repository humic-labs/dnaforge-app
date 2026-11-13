export function workspaceSyncManifestHashInput(manifest: {
  readonly schemaVersion: 1;
  readonly files: readonly {
    readonly path: string;
    readonly contentSha256: string;
    readonly sizeBytes: number;
    readonly contentType: string;
  }[];
}): string {
  const encoder = new TextEncoder();
  const files = [...manifest.files].map((file) => ({ file, pathBytes: encoder.encode(file.path) }));
  files.sort((left, right) => {
    const length = Math.min(left.pathBytes.length, right.pathBytes.length);
    for (let index = 0; index < length; index += 1) {
      const difference = left.pathBytes[index]! - right.pathBytes[index]!;
      if (difference) return difference;
    }
    return left.pathBytes.length - right.pathBytes.length;
  });
  const lines = ['dnaforge.workspace-sync-manifest/v1', String(files.length)];
  for (const { file, pathBytes } of files) {
    lines.push(
      `${pathBytes.length}:${file.path}`,
      file.contentSha256,
      String(file.sizeBytes),
      `${encoder.encode(file.contentType).length}:${file.contentType}`
    );
  }
  return `${lines.join('\n')}\n`;
}
