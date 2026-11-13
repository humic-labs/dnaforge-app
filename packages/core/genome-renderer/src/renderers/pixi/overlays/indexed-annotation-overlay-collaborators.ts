import type { Container } from 'pixi.js';

export interface OverlayLayoutCollaborator {}
export interface OverlayRetainedCollaborator {}
export interface OverlayCompiledBroadCollaborator {}
export interface OverlayPrepackedCollaborator {}
export interface OverlaySearchFocusCollaborator {}
export interface OverlayHitsCollaborator {}
export interface OverlayOutlinesCollaborator {}
export interface OverlayImmediateDrawCollaborator {}
export interface OverlayBodyFrameCollaborator {}
export interface OverlayResidentPagesCollaborator {}
export interface OverlayTilePyramidCollaborator {}
export interface OverlaySidecarRasterCollaborator {}

export type OverlayPresenterCollaborators = {
  container: Container;
  layout: OverlayLayoutCollaborator;
  retained: OverlayRetainedCollaborator;
  compiledBroad: OverlayCompiledBroadCollaborator;
  prepacked: OverlayPrepackedCollaborator;
  searchFocus: OverlaySearchFocusCollaborator;
  hits: OverlayHitsCollaborator;
  outlines: OverlayOutlinesCollaborator;
  immediateDraw: OverlayImmediateDrawCollaborator;
  bodyFrame: OverlayBodyFrameCollaborator;
  residentPages: OverlayResidentPagesCollaborator;
  tilePyramid: OverlayTilePyramidCollaborator;
  sidecarRaster: OverlaySidecarRasterCollaborator;
};
