export interface FilesystemStat {
  readonly canonicalPath: string;
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly mtime: number;
  readonly ctime: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly device?: string;
  readonly inode?: string;
}
