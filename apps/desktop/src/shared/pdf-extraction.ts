export type StructuredPdfElementKind = 'heading' | 'paragraph' | 'caption' | 'list-item' | 'table';

export type StructuredPdfParserIdentity = Readonly<{
  name: string;
  version: string;
  mode: string;
  configuration?: string;
}>;

export type PdfPointBoundingBox = readonly [
  left: number,
  bottom: number,
  right: number,
  top: number,
];

export type StructuredPdfElement = Readonly<{
  blockId: string;
  page: number;
  kind: StructuredPdfElementKind;
  text: string;
  boundingBox: PdfPointBoundingBox;
}>;

export type StructuredPdfExtractionRequest = Readonly<{
  path: string;
  pages: number[];
  maxCharacters: number;
  clampTrailingPages?: boolean;
}>;

export type StructuredPdfExtractionResult = Readonly<{
  parser: StructuredPdfParserIdentity;
  pageCount: number;
  pages: ReadonlyArray<
    Readonly<{
      page: number;
      elements: ReadonlyArray<StructuredPdfElement>;
    }>
  >;
  truncated: boolean;
}>;
