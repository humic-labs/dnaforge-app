import type { InventoryPhysicalItem } from './inventory-types';

export const INVENTORY_LABEL_TEMPLATE = 'dnaforge.inventory-label.qr.v1' as const;
export const INVENTORY_LABEL_MEDIA_PROFILE_IDS = ['qr-50x30-300dpi', 'qr-80x50-300dpi'] as const;
export const INVENTORY_LABEL_ENCODER = { name: 'qrcode', version: '1.5.4' } as const;
export const INVENTORY_LABEL_FONT = {
  name: 'DNAForgeInventoryLabelAscii',
  sourceFamily: 'JetBrains Mono',
  sourcePackage: '@fontsource/jetbrains-mono',
  sourceVersion: '5.3.0',
  sourceFile: 'files/jetbrains-mono-latin-400-normal.woff',
  sourceSha256: 'sha256:658b9ee07b0249cf910a8d6f3d812d46c962bae81d7379a0355b1db35c61586f',
  sizeDots: 33,
  generator: { name: 'opentype.js', version: '2.0.0' },
} as const;

export type InventoryLabelMediaProfileId = (typeof INVENTORY_LABEL_MEDIA_PROFILE_IDS)[number];

export interface InventoryLabelSpec {
  readonly scope: { readonly projectId: string; readonly inventoryId: string };
  readonly sourceRevision: number;
  readonly binding: {
    readonly id: string;
    readonly namespace: string;
    readonly value: string;
    readonly item: InventoryPhysicalItem;
  };
  readonly mediaProfileId: InventoryLabelMediaProfileId;
}

export interface InventoryLabelMedia {
  readonly profileId: InventoryLabelMediaProfileId;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly dpi: 300;
  readonly widthDots: number;
  readonly heightDots: number;
}

export interface InventoryLabelTextLine {
  readonly text: string;
  readonly xDots: number;
  readonly baselineDots: number;
  readonly widthDots: number;
  readonly heightDots: number;
}

export interface InventoryRenderedLabel {
  readonly spec: InventoryLabelSpec;
  readonly template: typeof INVENTORY_LABEL_TEMPLATE;
  readonly encoder: typeof INVENTORY_LABEL_ENCODER;
  readonly font: typeof INVENTORY_LABEL_FONT;
  readonly media: InventoryLabelMedia;
  readonly symbol: {
    readonly symbology: 'qrcode';
    readonly errorCorrection: 'M';
    readonly modules: number;
    readonly dotsPerModule: 4;
    readonly quietZoneModules: 4;
    readonly xDots: number;
    readonly yDots: number;
    readonly sizeDots: number;
  };
  readonly humanText: readonly {
    readonly role: 'namespace' | 'code' | 'target';
    readonly text: string;
    readonly lines: readonly InventoryLabelTextLine[];
  }[];
  readonly svg: string;
}

export type InventoryLabelRenderResult =
  | { readonly kind: 'rendered'; readonly artifact: InventoryRenderedLabel }
  | {
      readonly kind: 'refused';
      readonly code: 'INVALID_SPEC' | 'UNSUPPORTED_TEXT' | 'LAYOUT_OVERFLOW' | 'ENCODER_FAILED';
      readonly message: string;
    };
