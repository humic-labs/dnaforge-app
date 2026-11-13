import { Renderer, RendererType, type Texture } from 'pixi.js';
import { compiledBroadSurfaceCellIdV2 } from '../overview/bounded-annotation-broad-surface';
import type { BroadSurfaceIsoformModeV2 } from '../overview/bounded-annotation-broad-surface';
import { compiledBroadSurfaceOwnedCellKey } from './annotation-compiled-broad-address';
import {
  createCompiledBroadSurfaceRgbaTextureV2,
  type CompiledBroadSurfaceCellAdmissionResultV2,
  type CompiledBroadSurfaceDecodedCellTextureV2,
  type CompiledBroadSurfaceRgbaTextureV2,
} from '../overview/compiled-broad-surface-pixi-presenter';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';

export interface CompiledBroadSurfaceRgbaCellAdmissionInputV2 {
  readonly demandLeaseId: string;
  readonly manifestFingerprint: string;
  readonly cellId: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly level: number;
  readonly tileX: number;
  readonly laneSlabIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly premultipliedRgba: Uint8Array;
}

export interface CompiledBroadSurfaceTransparentCellAdmissionInputV2 {
  readonly demandLeaseId: string;
  readonly manifestFingerprint: string;
  readonly cellId: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly level: number;
  readonly tileX: number;
  readonly laneSlabIndex: number;
}

export interface CompiledBroadSurfaceTextureCellAdmissionInputV2 extends CompiledBroadSurfaceDecodedCellTextureV2 {
  readonly demandLeaseId: string;
  readonly manifestFingerprint: string;
}

export type CompiledBroadSurfaceRgbaCellAdmissionResultV2 = Readonly<
  | {
      status: 'admitted' | 'already-resident';
      cellId: string;
      gpuPreuploaded: boolean;
      explicitCopyByteLength: 0;
      uploadedByteLength: number;
    }
  | {
      status: 'rejected';
      cellId: string | null;
      reason: string;
      gpuPreuploaded: false;
      explicitCopyByteLength: 0;
      uploadedByteLength: 0;
    }
>;

export type CompiledBroadAdmitHost = {
  admissionOwner(manifestFingerprint: string | undefined): CompiledBroadSurfaceTrackOwnerV2 | null;
  admissionLeaseFailure(
    demandLeaseId: string | undefined,
    manifestFingerprint: string,
    cellId: string
  ): string | null;
  pixiRenderer: Renderer | null;
  gpuPreuploadedCellIds: Set<string>;
  ownedCellTextures: Map<string, Texture>;
  noteGpuPreuploadFailure(): void;
  noteGpuPreupload(
    explicitCopyByteLength: number,
    uploadByteLength: number,
    presenterWasVisible: boolean
  ): void;
  noteRgbaAdmission(): void;
};

function rejectedRgbaAdmission(
  cellId: string | null,
  reason: string
): CompiledBroadSurfaceRgbaCellAdmissionResultV2 {
  return Object.freeze({
    status: 'rejected',
    cellId,
    reason,
    gpuPreuploaded: false,
    explicitCopyByteLength: 0,
    uploadedByteLength: 0,
  });
}

export function admitCompiledBroadSurfaceCellTexture(
  host: CompiledBroadAdmitHost,
  input: CompiledBroadSurfaceTextureCellAdmissionInputV2
): CompiledBroadSurfaceCellAdmissionResultV2 {
  const owner = host.admissionOwner(input?.manifestFingerprint);
  if (!owner) {
    return Object.freeze({
      status: 'rejected',
      cellId: null,
      reason: 'compiled-broad-surface-manifest-not-loaded',
    });
  }
  let cellId: string;
  try {
    cellId = compiledBroadSurfaceCellIdV2({ manifest: owner.manifest, ...input });
  } catch (error) {
    return Object.freeze({
      status: 'rejected',
      cellId: null,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const leaseFailure = host.admissionLeaseFailure(
    input?.demandLeaseId,
    owner.manifest.manifestFingerprint,
    cellId
  );
  if (leaseFailure) {
    return Object.freeze({ status: 'rejected', cellId, reason: leaseFailure });
  }
  return owner.presenter.admitCellTexture(input);
}

export function admitCompiledBroadSurfaceTransparentCell(
  host: CompiledBroadAdmitHost,
  input: CompiledBroadSurfaceTransparentCellAdmissionInputV2
): CompiledBroadSurfaceRgbaCellAdmissionResultV2 {
  const owner = host.admissionOwner(input?.manifestFingerprint);
  const manifest = owner?.manifest ?? null;
  const presenter = owner?.presenter ?? null;
  if (!manifest || !presenter) {
    return rejectedRgbaAdmission(null, 'compiled-broad-surface-manifest-not-loaded');
  }
  if (input?.manifestFingerprint !== manifest.manifestFingerprint) {
    return rejectedRgbaAdmission(
      input?.cellId ?? null,
      'compiled-broad-surface-manifest-fingerprint-mismatch'
    );
  }
  let cellId: string;
  try {
    cellId = compiledBroadSurfaceCellIdV2({ manifest, ...input });
  } catch (error) {
    return rejectedRgbaAdmission(
      input?.cellId ?? null,
      error instanceof Error ? error.message : String(error)
    );
  }
  if (input.cellId !== cellId) {
    return rejectedRgbaAdmission(cellId, 'compiled-broad-surface-cell-id-mismatch');
  }
  const leaseFailure = host.admissionLeaseFailure(
    input?.demandLeaseId,
    manifest.manifestFingerprint,
    cellId
  );
  if (leaseFailure) return rejectedRgbaAdmission(cellId, leaseFailure);
  const result = presenter.admitTransparentCell(input);
  return result.status === 'rejected'
    ? rejectedRgbaAdmission(result.cellId, result.reason)
    : Object.freeze({
        status: result.status,
        cellId: result.cellId,
        gpuPreuploaded: true,
        explicitCopyByteLength: 0,
        uploadedByteLength: 0,
      });
}

export function admitCompiledBroadSurfaceRgbaCell(
  host: CompiledBroadAdmitHost,
  input: CompiledBroadSurfaceRgbaCellAdmissionInputV2
): CompiledBroadSurfaceRgbaCellAdmissionResultV2 {
  const owner = host.admissionOwner(input?.manifestFingerprint);
  const manifest = owner?.manifest ?? null;
  const presenter = owner?.presenter ?? null;
  if (!manifest || !presenter) {
    return rejectedRgbaAdmission(null, 'compiled-broad-surface-manifest-not-loaded');
  }
  if (input?.manifestFingerprint !== manifest.manifestFingerprint) {
    return rejectedRgbaAdmission(
      input?.cellId ?? null,
      'compiled-broad-surface-manifest-fingerprint-mismatch'
    );
  }
  let cellId: string;
  try {
    cellId = compiledBroadSurfaceCellIdV2({ manifest, ...input });
  } catch (error) {
    return rejectedRgbaAdmission(
      input?.cellId ?? null,
      error instanceof Error ? error.message : String(error)
    );
  }
  if (input.cellId !== cellId) {
    return rejectedRgbaAdmission(cellId, 'compiled-broad-surface-cell-id-mismatch');
  }
  const leaseFailure = host.admissionLeaseFailure(
    input?.demandLeaseId,
    manifest.manifestFingerprint,
    cellId
  );
  if (leaseFailure) return rejectedRgbaAdmission(cellId, leaseFailure);
  const expectedWidth = manifest.broadTilePhysicalWidthPx + manifest.broadTileXGuardPhysicalPx * 2;
  const expectedHeight = manifest.laneSlabRowCount * manifest.laneRowTextureStridePx;
  const expectedByteLength = expectedWidth * expectedHeight * 4;
  if (
    !Number.isSafeInteger(input.widthPx) ||
    !Number.isSafeInteger(input.heightPx) ||
    input.widthPx !== expectedWidth ||
    input.heightPx !== expectedHeight
  ) {
    return rejectedRgbaAdmission(cellId, 'compiled-broad-surface-rgba-physical-geometry-mismatch');
  }
  if (
    !(input.premultipliedRgba instanceof Uint8Array) ||
    input.premultipliedRgba.byteLength !== expectedByteLength
  ) {
    return rejectedRgbaAdmission(cellId, 'compiled-broad-surface-rgba-byte-length-mismatch');
  }
  const resident = presenter.hasResidentCell(cellId);
  if (resident) {
    const ownershipKey = compiledBroadSurfaceOwnedCellKey(manifest.manifestFingerprint, cellId);
    return Object.freeze({
      status: 'already-resident',
      cellId,
      gpuPreuploaded: host.gpuPreuploadedCellIds.has(ownershipKey),
      explicitCopyByteLength: 0,
      uploadedByteLength: 0,
    });
  }
  const renderer = host.pixiRenderer as
    | (Renderer & {
        readonly uid?: number;
        readonly texture?: {
          initSource?: (source: CompiledBroadSurfaceRgbaTextureV2['source']) => unknown;
        };
      })
    | null;
  if (renderer?.type !== RendererType.WEBGL || typeof renderer.texture?.initSource !== 'function') {
    return rejectedRgbaAdmission(
      cellId,
      'compiled-broad-surface-gpu-preupload-renderer-unavailable'
    );
  }

  const { source, texture, explicitCopyByteLength, uploadByteLength } =
    createCompiledBroadSurfaceRgbaTextureV2({
      manifest,
      premultipliedRgba: input.premultipliedRgba,
      label: `compiled-broad-surface:${cellId}`,
    });
  const presenterWasVisible = presenter.isPresenting;
  try {
    renderer.texture.initSource(source);
  } catch (error) {
    host.noteGpuPreuploadFailure();
    texture.destroy(true);
    return rejectedRgbaAdmission(
      cellId,
      `compiled-broad-surface-gpu-preupload-failed:${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  host.noteGpuPreupload(explicitCopyByteLength, uploadByteLength, presenterWasVisible);
  const result = presenter.admitCellTexture({ ...input, texture });
  if (result.status === 'rejected') {
    texture.destroy(true);
    return rejectedRgbaAdmission(result.cellId, result.reason);
  }
  if (result.status === 'already-resident') {
    texture.destroy(true);
    const ownershipKey = compiledBroadSurfaceOwnedCellKey(
      manifest.manifestFingerprint,
      result.cellId
    );
    return Object.freeze({
      status: 'already-resident',
      cellId: result.cellId,
      gpuPreuploaded: host.gpuPreuploadedCellIds.has(ownershipKey),
      explicitCopyByteLength: 0,
      uploadedByteLength: 0,
    });
  }
  const ownershipKey = compiledBroadSurfaceOwnedCellKey(manifest.manifestFingerprint, cellId);
  const previous = host.ownedCellTextures.get(ownershipKey);
  if (previous && previous !== texture) previous.destroy(true);
  host.ownedCellTextures.set(ownershipKey, texture);
  host.gpuPreuploadedCellIds.add(ownershipKey);
  host.noteRgbaAdmission();
  return Object.freeze({
    status: 'admitted',
    cellId,
    gpuPreuploaded: true,
    explicitCopyByteLength,
    uploadedByteLength: uploadByteLength,
  });
}

export type CompiledBroadAdmitOverlayBindings = {
  pixiRenderer: Renderer | null;
  compiledBroadSurfaceGpuPreuploadedCellIds: Set<string>;
  compiledBroadSurfaceOwnedCellTextures: Map<string, Texture>;
  compiledBroadSurfaceGpuPreuploadFailures: number;
  compiledBroadSurfaceGpuPreuploads: number;
  compiledBroadSurfaceExplicitRgbaCopyBytes: number;
  compiledBroadSurfaceGpuPreuploadedBytes: number;
  compiledBroadSurfacePostPresentGpuUploads: number;
  compiledBroadSurfacePostPresentGpuUploadBytes: number;
  compiledBroadSurfaceRgbaAdmissions: number;
  compiledBroadSurfaceAdmissionOwner(
    manifestFingerprint: string | undefined
  ): CompiledBroadSurfaceTrackOwnerV2 | null;
  compiledBroadSurfaceAdmissionLeaseFailure(
    demandLeaseId: string | undefined,
    manifestFingerprint: string,
    cellId: string
  ): string | null;
};

export function createCompiledBroadAdmitHost(
  overlay: CompiledBroadAdmitOverlayBindings
): CompiledBroadAdmitHost {
  return {
    admissionOwner: (fingerprint) => overlay.compiledBroadSurfaceAdmissionOwner(fingerprint),
    admissionLeaseFailure: (leaseId, fingerprint, cellId) =>
      overlay.compiledBroadSurfaceAdmissionLeaseFailure(leaseId, fingerprint, cellId),
    get pixiRenderer() {
      return overlay.pixiRenderer;
    },
    get gpuPreuploadedCellIds() {
      return overlay.compiledBroadSurfaceGpuPreuploadedCellIds;
    },
    get ownedCellTextures() {
      return overlay.compiledBroadSurfaceOwnedCellTextures;
    },
    noteGpuPreuploadFailure() {
      overlay.compiledBroadSurfaceGpuPreuploadFailures += 1;
    },
    noteGpuPreupload(explicitCopyByteLength, uploadByteLength, presenterWasVisible) {
      overlay.compiledBroadSurfaceGpuPreuploads += 1;
      overlay.compiledBroadSurfaceExplicitRgbaCopyBytes += explicitCopyByteLength;
      overlay.compiledBroadSurfaceGpuPreuploadedBytes += uploadByteLength;
      if (presenterWasVisible) {
        overlay.compiledBroadSurfacePostPresentGpuUploads += 1;
        overlay.compiledBroadSurfacePostPresentGpuUploadBytes += uploadByteLength;
      }
    },
    noteRgbaAdmission() {
      overlay.compiledBroadSurfaceRgbaAdmissions += 1;
    },
  };
}
