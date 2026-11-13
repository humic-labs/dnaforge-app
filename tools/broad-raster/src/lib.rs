
const RGBA: usize = 4;
const ARROW_HEIGHT_RATIO: f64 = 0.6;
const ARROW_MAX_WIDTH_CSS_PX: f64 = 8.0;
const BP_COORDINATE_CHUNK_SIZE: f64 = 4096.0;
const GLYPH_STRIDE_BYTES: usize = 12 * 4;
const SUBPIXEL_MIN_WIDTH_PX: f64 = 1.0;
const SUBPIXEL_ALPHA_GAMMA: f64 = 0.22;
const SUBPIXEL_MIN_ALPHA_SCALE: f64 = 0.0;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn js_pow(base: f64, exponent: f64) -> f64;
}

#[cfg(target_arch = "wasm32")]
fn pow(base: f64, exponent: f64) -> f64 {
    unsafe { js_pow(base, exponent) }
}

#[cfg(not(target_arch = "wasm32"))]
fn pow(base: f64, exponent: f64) -> f64 {
    base.powf(exponent)
}

fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a < b {
        a
    } else if b < a {
        b
    } else if a.is_sign_negative() {
        a
    } else {
        b
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a > b {
        a
    } else if b > a {
        b
    } else if a.is_sign_positive() {
        a
    } else {
        b
    }
}

fn clamp01(value: f64) -> f64 {
    js_max(0.0, js_min(1.0, value))
}

pub struct Surface {
    pub tile_physical_width_px: f64,
    pub guard_px: f64,
    pub dpr: f64,
    pub lane_row_stride_px: f64,
    pub lane_row_tail_gutter_px: f64,
    pub width_px: usize,
    pub height_px: usize,
}

pub struct Partition {
    pub first_instance: usize,
    pub min_start_bp: f64,
    pub max_end_bp: f64,
    pub lane_prefix_offset: usize,
    pub lane_prefix_count: usize,
}

pub struct Cell {
    pub tile_span_bp: f64,
    pub nominal_start_bp: f64,
    pub nominal_end_bp_exclusive: f64,
    pub first_lane_row: usize,
    pub source_lane_row_count: usize,
}

pub struct Sections<'a> {
    pub payload: &'a [u8],
    pub glyph_offset: usize,
    pub glyph_count: usize,
    pub prefix_offset: usize,
    pub prefix_count: usize,
    pub max_primitive_span_bp: f64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RasterError {
    PrefixOutOfRange,
    GlyphOutOfRange,
}

struct Glyph {
    start_bp: f64,
    end_bp: f64,
    half_h: f64,
    dir_sign: f64,
    color: [f64; 4],
}

fn f32_at(record: &[u8], offset: usize) -> f64 {
    let bytes: [u8; 4] = record[offset..offset + 4].try_into().unwrap_or([0; 4]);
    f32::from_le_bytes(bytes) as f64
}

impl Sections<'_> {
    fn prefix(&self, index: usize) -> Result<usize, RasterError> {
        if index >= self.prefix_count {
            return Err(RasterError::PrefixOutOfRange);
        }
        let at = self.prefix_offset + index * 4;
        Ok(u32::from_le_bytes([
            self.payload[at],
            self.payload[at + 1],
            self.payload[at + 2],
            self.payload[at + 3],
        ]) as usize)
    }

    fn record(&self, record: usize) -> &[u8] {
        let base = self.glyph_offset + record * GLYPH_STRIDE_BYTES;
        &self.payload[base..base + GLYPH_STRIDE_BYTES]
    }

    fn glyph_start_bp(&self, record: usize) -> f64 {
        let r = self.record(record);
        f32_at(r, 0) * BP_COORDINATE_CHUNK_SIZE + f32_at(r, 4)
    }

    fn glyph(&self, record: usize) -> Result<Glyph, RasterError> {
        if record >= self.glyph_count {
            return Err(RasterError::GlyphOutOfRange);
        }
        let p = self.record(record);
        let base = 0;
        Ok(Glyph {
            start_bp: f32_at(p, base) * BP_COORDINATE_CHUNK_SIZE + f32_at(p, base + 4),
            end_bp: f32_at(p, base + 8) * BP_COORDINATE_CHUNK_SIZE + f32_at(p, base + 12),
            half_h: f32_at(p, base + 20),
            dir_sign: f32_at(p, base + 24),
            color: [
                f32_at(p, base + 32),
                f32_at(p, base + 36),
                f32_at(p, base + 40),
                f32_at(p, base + 44),
            ],
        })
    }

    fn lower_bound_glyph_start(&self, mut lower: usize, mut upper: usize, target: f64) -> usize {
        while lower < upper {
            let middle = lower + (upper - lower) / 2;
            if self.glyph_start_bp(middle) < target {
                lower = middle + 1;
            } else {
                upper = middle;
            }
        }
        lower
    }
}

pub struct Target<'a> {
    pub pixels: &'a mut [u8],
    pub roles: Option<&'a [u8]>,
    pub accumulator: Option<&'a mut [f64]>,
    role: usize,
}

impl<'a> Target<'a> {
    pub fn rgba(pixels: &'a mut [u8]) -> Self {
        Target {
            pixels,
            roles: None,
            accumulator: None,
            role: 0,
        }
    }

    pub fn role_weights(pixels: &'a mut [u8], roles: &'a [u8], accumulator: &'a mut [f64]) -> Self {
        Target {
            pixels,
            roles: Some(roles),
            accumulator: Some(accumulator),
            role: 0,
        }
    }

    fn blend(&mut self, offset: usize, color: &[f64; 3], alpha: f64) -> bool {
        match self.accumulator.as_deref_mut() {
            Some(accumulator) => role_over(accumulator, offset, self.role, alpha),
            None => source_over(self.pixels, offset, color, alpha),
        }
    }
}

pub fn rasterize_cell(
    sections: &Sections,
    partitions: &[Partition],
    cell: &Cell,
    surface: &Surface,
    target: &mut Target,
) -> Result<(u32, bool), RasterError> {
    let scale_x = surface.tile_physical_width_px / cell.tile_span_bp;
    let guard_bp = surface.guard_px / scale_x;
    let sample_start_bp = cell.nominal_start_bp - guard_bp;
    let sample_end_bp = cell.nominal_end_bp_exclusive + guard_bp;
    let mut rasterized: u32 = 0;
    let mut wrote_pixel = false;
    for partition in partitions {
        if partition.max_end_bp <= sample_start_bp || partition.min_start_bp >= sample_end_bp {
            continue;
        }
        let last_lane_exclusive = cell.first_lane_row + cell.source_lane_row_count;
        for lane in cell.first_lane_row..last_lane_exclusive {
            if lane + 1 >= partition.lane_prefix_count {
                continue;
            }
            let first = sections.prefix(partition.lane_prefix_offset + lane)?;
            let end = sections.prefix(partition.lane_prefix_offset + lane + 1)?;
            let lane_first_record = partition.first_instance + first;
            let lane_end_record = partition.first_instance + end;
            let first_candidate = sections.lower_bound_glyph_start(
                lane_first_record,
                lane_end_record,
                sample_start_bp - sections.max_primitive_span_bp,
            );
            let end_candidate =
                sections.lower_bound_glyph_start(first_candidate, lane_end_record, sample_end_bp);
            for record in first_candidate..end_candidate {
                let glyph = sections.glyph(record)?;
                if glyph.end_bp <= sample_start_bp || glyph.start_bp >= sample_end_bp {
                    continue;
                }
                if rasterized == 0 {
                    match target.accumulator.as_deref_mut() {
                        Some(accumulator) => accumulator.fill(0.0),
                        None => target.pixels.fill(0),
                    }
                }
                if let Some(roles) = target.roles {
                    target.role = roles
                        .get(record)
                        .copied()
                        .ok_or(RasterError::GlyphOutOfRange)?
                        as usize;
                }
                let local_lane = (lane - cell.first_lane_row) as f64;
                wrote_pixel = rasterize_glyph(cell, surface, target, &glyph, local_lane, scale_x)
                    || wrote_pixel;
                rasterized += 1;
            }
        }
    }
    if rasterized > 0 {
        if let Some(accumulator) = target.accumulator.as_deref() {
            for (byte, weight) in target.pixels.iter_mut().zip(accumulator) {
                *byte = js_round(js_min(1.0, *weight) * 255.0) as u8;
            }
        }
    }
    Ok((rasterized, wrote_pixel))
}

fn retained_subpixel_alpha_scale(actual_width_px: f64) -> f64 {
    if !actual_width_px.is_finite() || actual_width_px <= 0.0 {
        return 0.0;
    }
    let min_width = js_max(0.0, SUBPIXEL_MIN_WIDTH_PX);
    if actual_width_px >= min_width {
        return 1.0;
    }
    let support_width = js_max(js_max(actual_width_px, min_width), 1e-6);
    let coverage = js_max(0.0, js_min(1.0, actual_width_px / support_width));
    let gamma = js_max(0.01, SUBPIXEL_ALPHA_GAMMA);
    let min_alpha = js_max(0.0, js_min(1.0, SUBPIXEL_MIN_ALPHA_SCALE));
    js_min(1.0, js_max(min_alpha, pow(coverage, gamma)))
}

fn rasterize_glyph(
    cell: &Cell,
    surface: &Surface,
    target: &mut Target,
    glyph: &Glyph,
    local_lane: f64,
    scale_x: f64,
) -> bool {
    let dpr = surface.dpr;
    let mut x1 = surface.guard_px + (glyph.start_bp - cell.nominal_start_bp) * scale_x;
    let mut x2 = surface.guard_px + (glyph.end_bp - cell.nominal_start_bp) * scale_x;
    let actual_width_physical = js_max(0.0, x2 - x1);
    if actual_width_physical <= 0.0 {
        return false;
    }
    let stable_width_physical = js_max(actual_width_physical, dpr);
    if stable_width_physical > actual_width_physical {
        let middle = (x1 + x2) / 2.0;
        x1 = middle - stable_width_physical / 2.0;
        x2 = middle + stable_width_physical / 2.0;
    }
    let content_height = surface.lane_row_stride_px - surface.lane_row_tail_gutter_px;
    let center_y = local_lane * surface.lane_row_stride_px + content_height / 2.0;
    let half_h = glyph.half_h * dpr;
    let y1 = center_y - half_h;
    let y2 = center_y + half_h;
    let actual_width_css = actual_width_physical / dpr;
    let alpha = glyph.color[3] * retained_subpixel_alpha_scale(actual_width_css);
    if alpha <= 0.0 {
        return false;
    }
    let mut arrow_width = 0.0;
    if glyph.dir_sign != 0.0 {
        let candidate = js_min(
            js_min(
                2.0 * glyph.half_h * ARROW_HEIGHT_RATIO,
                actual_width_css * 0.3,
            ),
            ARROW_MAX_WIDTH_CSS_PX,
        );
        if actual_width_css > candidate * 2.0 {
            arrow_width = candidate * dpr;
        }
    }
    let color = [
        clamp01(glyph.color[0]),
        clamp01(glyph.color[1]),
        clamp01(glyph.color[2]),
    ];
    let (width, height) = (surface.width_px, surface.height_px);
    if arrow_width == 0.0 {
        return rasterize_rectangle(target, width, height, x1, y1, x2, y2, &color, alpha);
    }
    rasterize_arrow(
        target,
        width,
        height,
        x1,
        y1,
        x2,
        y2,
        center_y,
        arrow_width,
        glyph.dir_sign,
        &color,
        alpha,
    )
}

fn pixel_span(lo: f64, hi: f64, limit: usize) -> Option<(usize, usize)> {
    let min = js_max(0.0, lo.floor());
    let max = js_min(limit as f64 - 1.0, hi.ceil() - 1.0);
    if max < min {
        None
    } else {
        Some((min as usize, max as usize))
    }
}

#[allow(clippy::too_many_arguments)]
fn rasterize_rectangle(
    target: &mut Target,
    width: usize,
    height: usize,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    color: &[f64; 3],
    alpha: f64,
) -> bool {
    let (Some((min_x, max_x)), Some((min_y, max_y))) =
        (pixel_span(x1, x2, width), pixel_span(y1, y2, height))
    else {
        return false;
    };
    let mut wrote = false;
    for y in min_y..=max_y {
        let yf = y as f64;
        let coverage_y = js_max(0.0, js_min(yf + 1.0, y2) - js_max(yf, y1));
        if coverage_y == 0.0 {
            continue;
        }
        for x in min_x..=max_x {
            let xf = x as f64;
            let coverage_x = js_max(0.0, js_min(xf + 1.0, x2) - js_max(xf, x1));
            if coverage_x == 0.0 {
                continue;
            }
            wrote = target.blend(
                (y * width + x) * RGBA,
                color,
                alpha * coverage_x * coverage_y,
            ) || wrote;
        }
    }
    wrote
}

#[allow(clippy::too_many_arguments)]
fn rasterize_arrow(
    target: &mut Target,
    width: usize,
    height: usize,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    center_y: f64,
    arrow_width: f64,
    direction: f64,
    color: &[f64; 3],
    alpha: f64,
) -> bool {
    let (Some((min_x, max_x)), Some((min_y, max_y))) =
        (pixel_span(x1, x2, width), pixel_span(y1, y2, height))
    else {
        return false;
    };
    let mut wrote = false;
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let (xf, yf) = (x as f64, y as f64);
            let coverage = arrow_pixel_coverage(
                x1,
                y1,
                x2,
                y2,
                center_y,
                arrow_width,
                direction,
                xf,
                yf,
                xf + 1.0,
                yf + 1.0,
            );
            if coverage <= 0.0 {
                continue;
            }
            wrote =
                target.blend((y * width + x) * RGBA, color, alpha * js_min(1.0, coverage)) || wrote;
        }
    }
    wrote
}

#[allow(clippy::too_many_arguments)]
fn arrow_pixel_coverage(
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    center_y: f64,
    arrow_width: f64,
    direction: f64,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
) -> f64 {
    let clipped_top = js_max(top, y1);
    let clipped_bottom = js_min(bottom, y2);
    if clipped_bottom <= clipped_top {
        return 0.0;
    }
    let clipped_left = js_max(left, x1);
    let clipped_right = js_min(right, x2);
    let width = clipped_right - clipped_left;
    if width <= 0.0 {
        return 0.0;
    }
    let base_x = if direction < 0.0 {
        x1 + arrow_width
    } else {
        x2 - arrow_width
    };
    let mut area = 0.0;
    let upper_bottom = js_min(clipped_bottom, center_y);
    if upper_bottom > clipped_top {
        let edge = |at: f64| {
            if direction < 0.0 {
                base_x - (arrow_width * (at - y1)) / (center_y - y1)
            } else {
                base_x + (arrow_width * (at - y1)) / (center_y - y1)
            }
        };
        let (edge_at_top, edge_at_bottom) = (edge(clipped_top), edge(upper_bottom));
        area += if direction < 0.0 {
            integrate_clamped_linear(
                clipped_right - edge_at_top,
                clipped_right - edge_at_bottom,
                upper_bottom - clipped_top,
                width,
            )
        } else {
            integrate_clamped_linear(
                edge_at_top - clipped_left,
                edge_at_bottom - clipped_left,
                upper_bottom - clipped_top,
                width,
            )
        };
    }
    let lower_top = js_max(clipped_top, center_y);
    if clipped_bottom > lower_top {
        let edge = |at: f64| {
            if direction < 0.0 {
                base_x - (arrow_width * (y2 - at)) / (y2 - center_y)
            } else {
                base_x + (arrow_width * (y2 - at)) / (y2 - center_y)
            }
        };
        let (edge_at_top, edge_at_bottom) = (edge(lower_top), edge(clipped_bottom));
        area += if direction < 0.0 {
            integrate_clamped_linear(
                clipped_right - edge_at_top,
                clipped_right - edge_at_bottom,
                clipped_bottom - lower_top,
                width,
            )
        } else {
            integrate_clamped_linear(
                edge_at_top - clipped_left,
                edge_at_bottom - clipped_left,
                clipped_bottom - lower_top,
                width,
            )
        };
    }
    area
}

fn integrate_clamped_linear(start_value: f64, end_value: f64, span: f64, maximum: f64) -> f64 {
    if start_value == end_value {
        return js_max(0.0, js_min(maximum, start_value)) * span;
    }
    let slope = (end_value - start_value) / span;
    (clamped_linear_antiderivative(end_value, maximum)
        - clamped_linear_antiderivative(start_value, maximum))
        / slope
}

fn clamped_linear_antiderivative(value: f64, maximum: f64) -> f64 {
    if value <= 0.0 {
        return 0.0;
    }
    if value >= maximum {
        return maximum * value - (maximum * maximum) / 2.0;
    }
    (value * value) / 2.0
}

fn rounded_scale(value: u8, factor: u32) -> u32 {
    (2 * value as u32 * factor + 255) / 510
}

fn source_over(pixels: &mut [u8], offset: usize, color: &[f64; 3], alpha: f64) -> bool {
    let source_alpha = js_round(clamp01(alpha) * 255.0);
    if source_alpha == 0.0 {
        return false;
    }
    let sa = source_alpha as u32;
    let inverse = 255 - sa;
    let pixel: &mut [u8; 4] = (&mut pixels[offset..offset + RGBA])
        .try_into()
        .expect("pixel");
    for channel in 0..3 {
        let value =
            js_round(color[channel] * source_alpha) as u32 + rounded_scale(pixel[channel], inverse);
        pixel[channel] = value.min(255) as u8;
    }
    pixel[3] = (sa + rounded_scale(pixel[3], inverse)).min(255) as u8;
    true
}

fn role_over(accumulator: &mut [f64], offset: usize, role: usize, alpha: f64) -> bool {
    if js_round(clamp01(alpha) * 255.0) == 0.0 {
        return false;
    }
    let coverage = clamp01(alpha);
    let keep = 1.0 - coverage;
    for channel in 0..RGBA {
        accumulator[offset + channel] *= keep;
    }
    accumulator[offset + role] += coverage;
    true
}


#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;

    #[no_mangle]
    pub extern "C" fn broad_raster_alloc(len: usize) -> *mut u8 {
        let mut buffer = vec![0u64; len.div_ceil(8).max(1)].into_boxed_slice();
        let pointer = buffer.as_mut_ptr().cast::<u8>();
        std::mem::forget(buffer);
        pointer
    }

    #[no_mangle]
    pub extern "C" fn broad_raster_free(pointer: *mut u8, len: usize) {
        let words = len.div_ceil(8).max(1);
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                pointer.cast::<u64>(),
                words,
            )));
        }
    }

    static mut LAST_WROTE: u32 = 0;

    #[no_mangle]
    pub extern "C" fn broad_raster_last_wrote() -> u32 {
        unsafe { LAST_WROTE }
    }

    #[no_mangle]
    #[allow(clippy::too_many_arguments)]
    pub extern "C" fn broad_raster_cell(
        payload: *const u8,
        payload_len: usize,
        glyph_offset: usize,
        glyph_count: usize,
        prefix_offset: usize,
        prefix_count: usize,
        max_primitive_span_bp: f64,
        partitions: *const f64,
        partition_count: usize,
        tile_span_bp: f64,
        nominal_start_bp: f64,
        nominal_end_bp_exclusive: f64,
        first_lane_row: usize,
        source_lane_row_count: usize,
        tile_physical_width_px: f64,
        guard_px: f64,
        dpr: f64,
        lane_row_stride_px: f64,
        lane_row_tail_gutter_px: f64,
        width_px: usize,
        height_px: usize,
        pixels: *mut u8,
    ) -> i32 {
        cell_into(
            payload,
            payload_len,
            glyph_offset,
            glyph_count,
            prefix_offset,
            prefix_count,
            max_primitive_span_bp,
            partitions,
            partition_count,
            tile_span_bp,
            nominal_start_bp,
            nominal_end_bp_exclusive,
            first_lane_row,
            source_lane_row_count,
            tile_physical_width_px,
            guard_px,
            dpr,
            lane_row_stride_px,
            lane_row_tail_gutter_px,
            width_px,
            height_px,
            pixels,
            None,
        )
    }

    #[no_mangle]
    #[allow(clippy::too_many_arguments)]
    pub extern "C" fn broad_raster_cell_roles(
        payload: *const u8,
        payload_len: usize,
        glyph_offset: usize,
        glyph_count: usize,
        prefix_offset: usize,
        prefix_count: usize,
        max_primitive_span_bp: f64,
        partitions: *const f64,
        partition_count: usize,
        tile_span_bp: f64,
        nominal_start_bp: f64,
        nominal_end_bp_exclusive: f64,
        first_lane_row: usize,
        source_lane_row_count: usize,
        tile_physical_width_px: f64,
        guard_px: f64,
        dpr: f64,
        lane_row_stride_px: f64,
        lane_row_tail_gutter_px: f64,
        width_px: usize,
        height_px: usize,
        pixels: *mut u8,
        roles: *const u8,
        accumulator: *mut f64,
    ) -> i32 {
        let role_weights = unsafe {
            (
                std::slice::from_raw_parts(roles, glyph_count),
                std::slice::from_raw_parts_mut(accumulator, width_px * height_px * RGBA),
            )
        };
        cell_into(
            payload,
            payload_len,
            glyph_offset,
            glyph_count,
            prefix_offset,
            prefix_count,
            max_primitive_span_bp,
            partitions,
            partition_count,
            tile_span_bp,
            nominal_start_bp,
            nominal_end_bp_exclusive,
            first_lane_row,
            source_lane_row_count,
            tile_physical_width_px,
            guard_px,
            dpr,
            lane_row_stride_px,
            lane_row_tail_gutter_px,
            width_px,
            height_px,
            pixels,
            Some(role_weights),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn cell_into(
        payload: *const u8,
        payload_len: usize,
        glyph_offset: usize,
        glyph_count: usize,
        prefix_offset: usize,
        prefix_count: usize,
        max_primitive_span_bp: f64,
        partitions: *const f64,
        partition_count: usize,
        tile_span_bp: f64,
        nominal_start_bp: f64,
        nominal_end_bp_exclusive: f64,
        first_lane_row: usize,
        source_lane_row_count: usize,
        tile_physical_width_px: f64,
        guard_px: f64,
        dpr: f64,
        lane_row_stride_px: f64,
        lane_row_tail_gutter_px: f64,
        width_px: usize,
        height_px: usize,
        pixels: *mut u8,
        role_weights: Option<(&[u8], &mut [f64])>,
    ) -> i32 {
        let (payload, partition_values, pixels) = unsafe {
            (
                std::slice::from_raw_parts(payload, payload_len),
                std::slice::from_raw_parts(partitions, partition_count * 5),
                std::slice::from_raw_parts_mut(pixels, width_px * height_px * RGBA),
            )
        };
        let partitions: Vec<Partition> = partition_values
            .chunks_exact(5)
            .map(|values| Partition {
                first_instance: values[0] as usize,
                min_start_bp: values[1],
                max_end_bp: values[2],
                lane_prefix_offset: values[3] as usize,
                lane_prefix_count: values[4] as usize,
            })
            .collect();
        let sections = Sections {
            payload,
            glyph_offset,
            glyph_count,
            prefix_offset,
            prefix_count,
            max_primitive_span_bp,
        };
        let cell = Cell {
            tile_span_bp,
            nominal_start_bp,
            nominal_end_bp_exclusive,
            first_lane_row,
            source_lane_row_count,
        };
        let surface = Surface {
            tile_physical_width_px,
            guard_px,
            dpr,
            lane_row_stride_px,
            lane_row_tail_gutter_px,
            width_px,
            height_px,
        };
        let mut target = match role_weights {
            Some((roles, accumulator)) => Target::role_weights(pixels, roles, accumulator),
            None => Target::rgba(pixels),
        };
        match rasterize_cell(&sections, &partitions, &cell, &surface, &mut target) {
            Ok((count, wrote)) => {
                unsafe { LAST_WROTE = u32::from(wrote) };
                count as i32
            }
            Err(RasterError::PrefixOutOfRange) => -1,
            Err(RasterError::GlyphOutOfRange) => -2,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_blend_rounding_equals_javascript_for_every_byte_pair() {
        for value in 0..=255u8 {
            for factor in 0..=255u32 {
                let javascript = js_round((value as f64 * factor as f64) / 255.0) as u32;
                assert_eq!(
                    rounded_scale(value, factor),
                    javascript,
                    "{value} * {factor}"
                );
            }
        }
    }

    #[test]
    fn rounds_like_javascript_math_round() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(254.5), 255.0);
        assert_eq!(js_round(0.0), 0.0);
    }

    #[test]
    fn min_and_max_keep_javascript_signed_zero_rules() {
        assert!(js_max(0.0, -0.0).is_sign_positive());
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert!(js_min(0.0, -0.0).is_sign_negative());
        assert!(js_min(-0.0, 0.0).is_sign_negative());
        assert_eq!(js_max(1.0, 2.0), 2.0);
        assert_eq!(js_min(1.0, 2.0), 1.0);
    }
}
