import { useLayoutEffect, useEffect, useRef, type ReactElement } from 'react';
import {
  getSequenceWebGLContext,
  releaseSequenceWebGLContext,
} from './rendering/webgl-drawing-context';

export interface SequenceScrollbarAnnotationMarker {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
}

interface SequenceScrollbarAnnotationCanvasProps {
  readonly markers: readonly SequenceScrollbarAnnotationMarker[];
  readonly width: number;
  readonly height: number;
}

export function SequenceScrollbarAnnotationCanvas({
  markers,
  width,
  height,
}: SequenceScrollbarAnnotationCanvasProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(height * devicePixelRatio));
    const context = getSequenceWebGLContext(canvas);
    if (!context) return;
    context.onRestore = () => {
      if (!context.beginFrame()) return;
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      context.globalAlpha = 0.8;
      for (const marker of markers) {
        context.fillStyle = marker.color;
        context.fillRect(marker.x, marker.y, marker.width, marker.height);
      }
      context.endFrame();
    };
    if (!context.beginFrame()) return;
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.globalAlpha = 0.8;
    for (const marker of markers) {
      context.fillStyle = marker.color;
      context.fillRect(marker.x, marker.y, marker.width, marker.height);
    }
    context.globalAlpha = 1;
    context.endFrame();
    canvas.dataset.paintedAnnotationCount = String(markers.length);
  }, [height, markers, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return () => {
      canvas.dataset.paintedAnnotationCount = '0';
      releaseSequenceWebGLContext(canvas);
      canvas.width = 1;
      canvas.height = 1;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="sequence-scrollbar-annotation-canvas"
      data-painted-annotation-count="0"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width,
        height,
        pointerEvents: 'none',
        zIndex: 1,
      }}
    />
  );
}
