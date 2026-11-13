import type { AnnotationRecord } from '@waypoint/genome-data';

import type { PackedRecordBuffer, PixelRuleTrack } from '../pixel-rule-track';

export const CCRE_MAX_RECORDS_PER_TILE = 2048;

export const CCRE_RECORD_TEXTURE_WIDTH = 64;

const CCRE_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 aPosition; // unit quad corners (0,0), (1,0), (1,1), (0,1)
uniform vec4 uTileBpRange;   // (startBp, endBp, laneStart, laneEnd)
uniform vec2 uViewportBpRange; // (viewStartBp, viewEndBp)
uniform vec2 uViewportPx;    // (widthPx, heightPx)

out vec2 vTilePos; // 0..1 within tile

void main() {
  // Map quad corner → tile bp range → viewport-relative position → clip space.
  float tileBp = mix(uTileBpRange.x, uTileBpRange.y, aPosition.x);
  float laneIdx = mix(uTileBpRange.z, uTileBpRange.w, aPosition.y);

  float viewSpan = uViewportBpRange.y - uViewportBpRange.x;
  float xNorm = (tileBp - uViewportBpRange.x) / viewSpan; // 0..1 within viewport
  float yNorm = laneIdx / uViewportPx.y; // very provisional; renderer will provide proper lane→y

  vec2 clip = vec2(xNorm * 2.0 - 1.0, 1.0 - yNorm * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);

  vTilePos = aPosition;
}
`;

const CCRE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uRecords;
uniform vec2 uRecordsDims;        // (textureWidth, textureHeight)
uniform int uRecordCount;         // actual records in this tile
uniform vec4 uTileBpRange;        // (startBp, endBp, laneStart, laneEnd)
uniform vec2 uViewportBpRange;    // (viewStartBp, viewEndBp)
uniform vec2 uViewportPx;         // (widthPx, heightPx)
uniform float uPixelsPerBp;
uniform int uMaxRecordsPerPixel;  // for alpha normalization

in vec2 vTilePos;
out vec4 fragColor;

vec4 fetchRecord(int i) {
  int w = int(uRecordsDims.x);
  int x = i - (i / w) * w; // = i % w without modulo op
  int y = i / w;
  return texelFetch(uRecords, ivec2(x, y), 0);
}

void main() {
  // 1. Compute the bp range covered by THIS pixel.
  // gl_FragCoord.x is in viewport pixel space.
  float pixelStartBp = uViewportBpRange.x + gl_FragCoord.x / uPixelsPerBp;
  float pixelEndBp   = uViewportBpRange.x + (gl_FragCoord.x + 1.0) / uPixelsPerBp;

  // 2. Compute the lane this fragment corresponds to.
  // Provisional: assume lane = floor(gl_FragCoord.y / laneHeight). Phase 3 wires
  // the actual lane height per track.
  float fragLane = floor(gl_FragCoord.y);

  // 3. Iterate records; count by class color.
  // V1: brute-force scan. Phase 3 adds per-pixel-column index.
  int totalHits = 0;
  vec3 dominantColor = vec3(0.0);
  float dominantCount = 0.0;

  // Map: we count each color separately by storing 'last seen color +
  // its run count'. For mode (dominant), Phase 3 will replace this with
  // a class-vote histogram (cCRE has ~5 fixed classes).
  vec3 currentColor = vec3(0.0);
  float currentCount = 0.0;

  for (int i = 0; i < 4096; i++) {
    if (i >= uRecordCount) break;
    vec4 rec = fetchRecord(i);
    float recStartBp = rec.r;
    float recEndBp   = rec.g;
    float recLane    = rec.b;

    if (recLane != fragLane) continue;
    if (recEndBp <= pixelStartBp || recStartBp >= pixelEndBp) continue;

    totalHits++;

    // Unpack RGB color from .a (packed as uint32-as-float).
    uint packed = floatBitsToUint(rec.a);
    vec3 recColor = vec3(
      float((packed >> 16u) & 0xFFu) / 255.0,
      float((packed >> 8u) & 0xFFu) / 255.0,
      float(packed & 0xFFu) / 255.0
    );

    // Run-length mode: simple plurality voting via run-tracking.
    if (recColor == currentColor) {
      currentCount += 1.0;
    } else {
      if (currentCount > dominantCount) {
        dominantColor = currentColor;
        dominantCount = currentCount;
      }
      currentColor = recColor;
      currentCount = 1.0;
    }
  }
  // Final flush of the run.
  if (currentCount > dominantCount) {
    dominantColor = currentColor;
    dominantCount = currentCount;
  }

  if (totalHits == 0) {
    discard;
  }

  // 4. Density-weighted alpha.
  float alpha = log(float(totalHits) + 1.0) / log(float(uMaxRecordsPerPixel) + 1.0);
  alpha = clamp(alpha, 0.05, 1.0);

  fragColor = vec4(dominantColor, alpha);
}
`;

export function packCcreRecords(
  records: ReadonlyArray<AnnotationRecord>,
  laneAssignment: Int16Array
): PackedRecordBuffer {
  if (records.length !== laneAssignment.length) {
    throw new Error(
      `packCcreRecords: records.length (${records.length}) !== laneAssignment.length (${laneAssignment.length})`
    );
  }
  let visibleCount = 0;
  for (let i = 0; i < records.length; i++) {
    if (laneAssignment[i] >= 0) visibleCount++;
  }

  const w = CCRE_RECORD_TEXTURE_WIDTH;
  const h = Math.max(1, Math.ceil(visibleCount / w));
  const data = new Float32Array(w * h * 4);

  let out = 0;
  for (let i = 0; i < records.length; i++) {
    const lane = laneAssignment[i];
    if (lane < 0) continue;
    const r = records[i];
    data[out * 4 + 0] = r.start;
    data[out * 4 + 1] = r.end;
    data[out * 4 + 2] = lane;
    const rgb = (r.color ?? 0x3b82f6) >>> 0;
    const colorBuffer = new Uint32Array(1);
    colorBuffer[0] = rgb;
    data[out * 4 + 3] = new Float32Array(colorBuffer.buffer)[0];
    out++;
  }

  return {
    data,
    recordCount: visibleCount,
    textureWidth: w,
    textureHeight: h,
    componentsPerRecord: 4,
  };
}

export const ccreDominantClassRule: PixelRuleTrack<AnnotationRecord> = {
  type: 'annotation-encode-ccre',
  maxRecordsPerTile: CCRE_MAX_RECORDS_PER_TILE,
  vertexShader: CCRE_VERTEX_SHADER,
  fragmentShader: CCRE_FRAGMENT_SHADER,
  packRecords: () => {
    throw new Error(
      'ccreDominantClassRule.packRecords requires laneAssignment; ' +
        'use the standalone packCcreRecords(records, laneAssignment) helper instead.'
    );
  },
};
