"""AlphaFold DB structural poster rendering.

The structure drawer needs lightweight result-list thumbnails without mounting
Mol* once per search row. AlphaFold DB does not publish RCSB-style structural
posters, so the sidecar renders a small pLDDT-colored backbone thumbnail from
the model CIF and caches the resulting PNG by canonical poster identity.
"""

from __future__ import annotations

import hashlib
import os
import shlex
import struct
import tempfile
import zlib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

ALPHAFOLD_CARTOON_PLDDT_RENDER_VERSION = "cartoon-plddt-v3"


@dataclass(frozen=True)
class CachedAlphaFoldPoster:
    content: bytes
    etag: str


@dataclass(frozen=True)
class _BackbonePoint:
    x: float
    y: float
    z: float
    plddt: float
    seq_id: int | None
    secondary: str


@dataclass(frozen=True)
class _ProjectedBackbonePoint:
    x: float
    y: float
    depth: float
    plddt: float
    secondary: str


@dataclass(frozen=True)
class _SecondaryStructureRange:
    chain_id: str
    start_seq_id: int
    end_seq_id: int
    kind: str


@dataclass(frozen=True)
class _DrawableCartoonSegment:
    start: _ProjectedBackbonePoint
    end: _ProjectedBackbonePoint
    kind: str


def read_cached_alphafold_cartoon_plddt_poster(
    external_id: str,
) -> CachedAlphaFoldPoster | None:
    path = _cache_path(external_id)
    try:
        content = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError:
        return None
    if not content.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    return CachedAlphaFoldPoster(content=content, etag=poster_etag(content))


def write_cached_alphafold_cartoon_plddt_poster(
    external_id: str,
    content: bytes,
) -> str:
    path = _cache_path(external_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "wb",
        delete=False,
        dir=path.parent,
        prefix=f".{path.name}.{os.getpid()}.",
        suffix=".tmp",
    ) as handle:
        handle.write(content)
        tmp_path = Path(handle.name)
    try:
        tmp_path.replace(path)
    except OSError:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise
    return poster_etag(content)


def poster_etag(content: bytes) -> str:
    digest = hashlib.sha256(content).hexdigest()[:16]
    return f'W/"af-cartoon-plddt-{digest}"'


def render_alphafold_cartoon_plddt_png(
    mmcif_text: str,
    *,
    width: int = 640,
    height: int = 420,
) -> bytes:
    points = _extract_backbone_points(mmcif_text)
    if not points:
        raise ValueError("AlphaFold mmCIF did not contain CA backbone atoms")
    points = _smooth_backbone_points(_thin_points(points, max_points=1200))
    scale = 1
    render_width = width * scale
    render_height = height * scale
    projected = _project_points(points, width=render_width, height=render_height)
    pixels = bytearray(render_width * render_height * 4)

    _draw_cartoon_backbone(
        pixels,
        render_width,
        render_height,
        projected,
        scale=scale,
    )

    pixels = _downsample_rgba(pixels, render_width, render_height, scale)
    return _encode_rgba_png(width, height, pixels)


def _cache_path(external_id: str) -> Path:
    root = os.environ.get("WAYPOINT_STRUCTURE_POSTER_CACHE_DIR")
    cache_root = (
        Path(root)
        if root
        else Path(tempfile.gettempdir()) / "waypoint-structure-posters"
    )
    cache_identity = f"{external_id}:RENDER:{ALPHAFOLD_CARTOON_PLDDT_RENDER_VERSION}"
    digest = hashlib.sha256(cache_identity.encode("utf-8")).hexdigest()
    return cache_root / "alphafold-cartoon-plddt" / f"{digest}.png"


def _extract_backbone_points(mmcif_text: str) -> list[_BackbonePoint]:
    chains: dict[str, list[tuple[int, int, _BackbonePoint]]] = {}
    secondary_ranges = _secondary_structure_ranges(mmcif_text)
    row_index = 0
    for row in _atom_site_rows(mmcif_text):
        atom_name = _clean_value(
            row.get("_atom_site.label_atom_id") or row.get("_atom_site.auth_atom_id")
        )
        if atom_name != "CA":
            continue
        chain_id = _clean_value(
            row.get("_atom_site.label_asym_id") or row.get("_atom_site.auth_asym_id")
        )
        if not chain_id:
            chain_id = "A"
        x = _float_value(row.get("_atom_site.Cartn_x"))
        y = _float_value(row.get("_atom_site.Cartn_y"))
        z = _float_value(row.get("_atom_site.Cartn_z"))
        plddt = _float_value(row.get("_atom_site.B_iso_or_equiv"))
        if x is None or y is None or z is None:
            continue
        if plddt is None:
            plddt = 50.0
        seq_id = _int_value(
            row.get("_atom_site.label_seq_id") or row.get("_atom_site.auth_seq_id")
        )
        secondary = _secondary_structure_for_seq_id(
            secondary_ranges.get(chain_id, []), seq_id
        )
        chains.setdefault(chain_id, []).append(
            (
                seq_id if seq_id is not None else row_index,
                row_index,
                _BackbonePoint(
                    x=x,
                    y=y,
                    z=z,
                    plddt=max(0.0, min(100.0, plddt)),
                    seq_id=seq_id,
                    secondary=secondary,
                ),
            )
        )
        row_index += 1

    if not chains:
        return []
    selected = max(chains.values(), key=len)
    selected.sort(key=lambda item: (item[0], item[1]))
    return [point for _seq_id, _row_index, point in selected]


def _atom_site_rows(mmcif_text: str):
    yield from _category_loop_rows(mmcif_text, "_atom_site.")


def _secondary_structure_ranges(
    mmcif_text: str,
) -> dict[str, list[_SecondaryStructureRange]]:
    ranges: dict[str, list[_SecondaryStructureRange]] = {}
    for row in _category_loop_rows(mmcif_text, "_struct_conf."):
        conf_type_id = _clean_value(row.get("_struct_conf.conf_type_id")).upper()
        if conf_type_id.startswith("HELX"):
            kind = "helix"
        elif conf_type_id.startswith("STRN") or "SHEET" in conf_type_id:
            kind = "sheet"
        else:
            continue
        chain_id = _clean_value(
            row.get("_struct_conf.beg_label_asym_id")
            or row.get("_struct_conf.beg_auth_asym_id")
        )
        if not chain_id:
            chain_id = "A"
        start_seq_id = _int_value(
            row.get("_struct_conf.beg_label_seq_id")
            or row.get("_struct_conf.beg_auth_seq_id")
        )
        end_seq_id = _int_value(
            row.get("_struct_conf.end_label_seq_id")
            or row.get("_struct_conf.end_auth_seq_id")
        )
        if start_seq_id is None or end_seq_id is None:
            continue
        low = min(start_seq_id, end_seq_id)
        high = max(start_seq_id, end_seq_id)
        ranges.setdefault(chain_id, []).append(
            _SecondaryStructureRange(
                chain_id=chain_id,
                start_seq_id=low,
                end_seq_id=high,
                kind=kind,
            )
        )
    for chain_ranges in ranges.values():
        chain_ranges.sort(key=lambda item: (item.start_seq_id, item.end_seq_id))
    return ranges


def _secondary_structure_for_seq_id(
    ranges: list[_SecondaryStructureRange],
    seq_id: int | None,
) -> str:
    if seq_id is None:
        return "coil"
    for secondary_range in ranges:
        if secondary_range.start_seq_id <= seq_id <= secondary_range.end_seq_id:
            return secondary_range.kind
    return "coil"


def _category_loop_rows(mmcif_text: str, category_prefix: str):
    headers: list[str] = []
    collecting_loop = False
    collecting_target_loop = False
    for raw_line in mmcif_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line == "#":
            headers = []
            collecting_loop = False
            collecting_target_loop = False
            continue
        if line == "loop_":
            headers = []
            collecting_loop = True
            collecting_target_loop = False
            continue
        if collecting_loop and line.startswith("_"):
            key = line.split()[0]
            if key.startswith(category_prefix):
                headers.append(key)
                collecting_target_loop = True
            elif headers:
                headers = []
                collecting_loop = False
                collecting_target_loop = False
            continue
        if not collecting_loop or not headers or not collecting_target_loop:
            continue
        if line.startswith("_"):
            headers = []
            collecting_loop = False
            collecting_target_loop = False
            continue
        try:
            values = shlex.split(line, comments=False, posix=True)
        except ValueError:
            continue
        if len(values) < len(headers):
            continue
        yield dict(zip(headers, values[: len(headers)], strict=True))


def _clean_value(value: str | None) -> str:
    if value is None or value in {".", "?"}:
        return ""
    return value.strip().strip("'\"")


def _float_value(value: str | None) -> float | None:
    cleaned = _clean_value(value)
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _int_value(value: str | None) -> int | None:
    cleaned = _clean_value(value)
    if not cleaned:
        return None
    try:
        return int(cleaned)
    except ValueError:
        return None


def _thin_points(
    points: list[_BackbonePoint], *, max_points: int
) -> list[_BackbonePoint]:
    if len(points) <= max_points:
        return points
    step = max(1, (len(points) + max_points - 1) // max_points)
    thinned = points[::step]
    if thinned[-1] is not points[-1]:
        thinned.append(points[-1])
    return thinned


def _smooth_backbone_points(points: list[_BackbonePoint]) -> list[_BackbonePoint]:
    if len(points) < 4:
        return points
    iterations = 1 if len(points) <= 650 else 0
    smoothed = points
    for _ in range(iterations):
        next_points: list[_BackbonePoint] = [smoothed[0]]
        for current, following in zip(smoothed, smoothed[1:], strict=False):
            next_points.append(_interpolate_backbone_point(current, following, 0.25))
            next_points.append(_interpolate_backbone_point(current, following, 0.75))
        next_points.append(smoothed[-1])
        smoothed = next_points
    return smoothed


def _interpolate_backbone_point(
    a: _BackbonePoint, b: _BackbonePoint, fraction: float
) -> _BackbonePoint:
    inverse = 1.0 - fraction
    return _BackbonePoint(
        x=a.x * inverse + b.x * fraction,
        y=a.y * inverse + b.y * fraction,
        z=a.z * inverse + b.z * fraction,
        plddt=a.plddt * inverse + b.plddt * fraction,
        seq_id=a.seq_id if fraction < 0.5 else b.seq_id,
        secondary=a.secondary if fraction < 0.5 else b.secondary,
    )


def _project_points(
    points: list[_BackbonePoint],
    *,
    width: int,
    height: int,
) -> list[_ProjectedBackbonePoint]:
    coords = [(point.x, point.y, point.z) for point in points]
    ranges = []
    for axis in range(3):
        values = [coord[axis] for coord in coords]
        ranges.append((max(values) - min(values), axis))
    sorted_axes = [axis for _span, axis in sorted(ranges, reverse=True)]
    axis_a, axis_b, axis_c = sorted_axes
    values_a = [coord[axis_a] for coord in coords]
    values_b = [coord[axis_b] for coord in coords]
    values_c = [coord[axis_c] for coord in coords]
    center_a = (min(values_a) + max(values_a)) / 2
    center_b = (min(values_b) + max(values_b)) / 2
    center_c = (min(values_c) + max(values_c)) / 2
    raw_projected = []
    for coord in coords:
        a = coord[axis_a] - center_a
        b = coord[axis_b] - center_b
        c = coord[axis_c] - center_c
        raw_projected.append((a + c * 0.28, -b + c * 0.18, c))
    xs = [item[0] for item in raw_projected]
    ys = [item[1] for item in raw_projected]
    depths = [item[2] for item in raw_projected]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    min_depth, max_depth = min(depths), max(depths)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    span_depth = max(max_depth - min_depth, 1e-6)
    margin = max(32.0, min(width, height) * 0.10)
    scale = min((width - margin * 2) / span_x, (height - margin * 2) / span_y)
    used_width = span_x * scale
    used_height = span_y * scale
    offset_x = (width - used_width) / 2
    offset_y = (height - used_height) / 2
    projected: list[_ProjectedBackbonePoint] = []
    for (raw_x, raw_y, depth), point in zip(raw_projected, points, strict=True):
        x = offset_x + (raw_x - min_x) * scale
        y = offset_y + (raw_y - min_y) * scale
        projected.append(
            _ProjectedBackbonePoint(
                x=x,
                y=y,
                depth=(depth - min_depth) / span_depth,
                plddt=point.plddt,
                secondary=point.secondary,
            )
        )
    return projected


def _plddt_color(plddt: float) -> tuple[int, int, int, int]:
    if plddt >= 90:
        return (0, 83, 214, 255)
    if plddt >= 70:
        return (101, 203, 243, 255)
    if plddt >= 50:
        return (255, 219, 19, 255)
    return (255, 125, 69, 255)


def _draw_cartoon_backbone(
    pixels: bytearray,
    width: int,
    height: int,
    projected: list[_ProjectedBackbonePoint],
    *,
    scale: int,
) -> None:
    segments = [
        _DrawableCartoonSegment(
            start=projected[index],
            end=projected[index + 1],
            kind=_segment_secondary_kind(projected[index], projected[index + 1]),
        )
        for index in range(max(0, len(projected) - 1))
    ]
    segments.sort(key=lambda item: (item.start.depth + item.end.depth) / 2)

    for segment in segments:
        start = segment.start
        end = segment.end
        kind = segment.kind
        radius = _cartoon_radius(kind, scale)
        _draw_cartoon_segment(
            pixels,
            width,
            height,
            start,
            end,
            kind=kind,
            radius=radius,
            color=(14, 22, 38, 42),
            offset_x=3.0 * scale,
            offset_y=4.0 * scale,
        )

    for segment in segments:
        start = segment.start
        end = segment.end
        kind = segment.kind
        depth = (start.depth + end.depth) / 2
        outline_alpha = int(64 + 44 * depth)
        _draw_cartoon_segment(
            pixels,
            width,
            height,
            start,
            end,
            kind=kind,
            radius=_cartoon_radius(kind, scale) + 1.5 * scale,
            color=(255, 255, 255, outline_alpha),
        )

    for segment in segments:
        start = segment.start
        end = segment.end
        kind = segment.kind
        depth = (start.depth + end.depth) / 2
        confidence = (start.plddt + end.plddt) / 2
        color = _shade_color(_plddt_color(confidence), 0.72 + depth * 0.28)
        _draw_cartoon_segment(
            pixels,
            width,
            height,
            start,
            end,
            kind=kind,
            radius=_cartoon_radius(kind, scale),
            color=color,
        )

    for segment in segments:
        start = segment.start
        end = segment.end
        kind = segment.kind
        confidence = (start.plddt + end.plddt) / 2
        depth = (start.depth + end.depth) / 2
        highlight_radius = 1.25 * scale if kind == "coil" else 1.8 * scale
        _draw_antialiased_segment(
            pixels,
            width,
            height,
            start.x - 1.2 * scale,
            start.y - 1.5 * scale,
            end.x - 1.2 * scale,
            end.y - 1.5 * scale,
            radius=highlight_radius,
            color=(255, 255, 255, int(32 + depth * 42 + min(20, confidence / 6))),
        )


def _segment_secondary_kind(
    start: _ProjectedBackbonePoint, end: _ProjectedBackbonePoint
) -> str:
    if start.secondary == end.secondary:
        return start.secondary
    if start.secondary != "coil":
        return start.secondary
    return end.secondary


def _cartoon_radius(kind: str, scale: int) -> float:
    if kind == "sheet":
        return 6.7 * scale
    if kind == "helix":
        return 6.2 * scale
    return 3.7 * scale


def _draw_cartoon_segment(
    pixels: bytearray,
    width: int,
    height: int,
    start: _ProjectedBackbonePoint,
    end: _ProjectedBackbonePoint,
    *,
    kind: str,
    radius: float,
    color: tuple[int, int, int, int],
    offset_x: float = 0.0,
    offset_y: float = 0.0,
) -> None:
    if kind == "sheet":
        _draw_sheet_segment(
            pixels,
            width,
            height,
            start.x + offset_x,
            start.y + offset_y,
            end.x + offset_x,
            end.y + offset_y,
            half_width=radius,
            color=color,
        )
        return
    _draw_antialiased_segment(
        pixels,
        width,
        height,
        start.x + offset_x,
        start.y + offset_y,
        end.x + offset_x,
        end.y + offset_y,
        radius=radius,
        color=color,
    )


def _shade_color(
    color: tuple[int, int, int, int], factor: float
) -> tuple[int, int, int, int]:
    return (
        max(0, min(255, int(color[0] * factor))),
        max(0, min(255, int(color[1] * factor))),
        max(0, min(255, int(color[2] * factor))),
        color[3],
    )


def _draw_sheet_segment(
    pixels: bytearray,
    width: int,
    height: int,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    *,
    half_width: float,
    color: tuple[int, int, int, int],
) -> None:
    dx = x2 - x1
    dy = y2 - y1
    length = (dx * dx + dy * dy) ** 0.5
    if length <= 1e-6:
        _draw_antialiased_segment(
            pixels,
            width,
            height,
            x1,
            y1,
            x2,
            y2,
            radius=half_width,
            color=color,
        )
        return

    unit_x = dx / length
    unit_y = dy / length
    normal_x = -unit_y
    normal_y = unit_x
    body = [
        (x1 + normal_x * half_width, y1 + normal_y * half_width),
        (x2 + normal_x * half_width, y2 + normal_y * half_width),
        (x2 - normal_x * half_width, y2 - normal_y * half_width),
        (x1 - normal_x * half_width, y1 - normal_y * half_width),
    ]
    _draw_antialiased_polygon(pixels, width, height, body, color)


def _draw_antialiased_polygon(
    pixels: bytearray,
    width: int,
    height: int,
    points: list[tuple[float, float]],
    color: tuple[int, int, int, int],
) -> None:
    if len(points) < 3:
        return
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    min_x = max(0, int(min(xs) - 2.0))
    max_x = min(width - 1, int(max(xs) + 2.0))
    min_y = max(0, int(min(ys) - 2.0))
    max_y = min(height - 1, int(max(ys) + 2.0))
    edges = list(zip(points, points[1:] + points[:1], strict=True))
    for y in range(min_y, max_y + 1):
        pixel_y = y + 0.5
        for x in range(min_x, max_x + 1):
            pixel_x = x + 0.5
            if _point_in_polygon(pixel_x, pixel_y, points):
                coverage = 1.0
            else:
                distance = min(
                    _point_to_segment_distance(pixel_x, pixel_y, ax, ay, bx, by)
                    for (ax, ay), (bx, by) in edges
                )
                coverage = 1.0 - min(1.0, distance)
            if coverage <= 0:
                continue
            _blend_pixel(pixels, width, x, y, color, coverage=coverage)


def _point_in_polygon(x: float, y: float, points: list[tuple[float, float]]) -> bool:
    inside = False
    previous_x, previous_y = points[-1]
    for current_x, current_y in points:
        crosses = (current_y > y) != (previous_y > y)
        if crosses:
            slope_x = (previous_x - current_x) * (y - current_y) / (
                previous_y - current_y
            ) + current_x
            if x < slope_x:
                inside = not inside
        previous_x, previous_y = current_x, current_y
    return inside


def _point_to_segment_distance(
    px: float,
    py: float,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
) -> float:
    dx = x2 - x1
    dy = y2 - y1
    length_squared = dx * dx + dy * dy
    if length_squared <= 1e-6:
        return ((px - x1) ** 2 + (py - y1) ** 2) ** 0.5
    t = ((px - x1) * dx + (py - y1) * dy) / length_squared
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    closest_x = x1 + dx * t
    closest_y = y1 + dy * t
    return ((px - closest_x) ** 2 + (py - closest_y) ** 2) ** 0.5


def _draw_antialiased_segment(
    pixels: bytearray,
    width: int,
    height: int,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    *,
    radius: float,
    color: tuple[int, int, int, int],
) -> None:
    min_x = max(0, int(min(x1, x2) - radius - 1.0))
    max_x = min(width - 1, int(max(x1, x2) + radius + 1.0))
    min_y = max(0, int(min(y1, y2) - radius - 1.0))
    max_y = min(height - 1, int(max(y1, y2) + radius + 1.0))
    dx = x2 - x1
    dy = y2 - y1
    length_squared = dx * dx + dy * dy
    for y in range(min_y, max_y + 1):
        pixel_y = y + 0.5
        for x in range(min_x, max_x + 1):
            pixel_x = x + 0.5
            if length_squared <= 1e-6:
                distance = ((pixel_x - x1) ** 2 + (pixel_y - y1) ** 2) ** 0.5
            else:
                t = ((pixel_x - x1) * dx + (pixel_y - y1) * dy) / length_squared
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                closest_x = x1 + dx * t
                closest_y = y1 + dy * t
                distance = (
                    (pixel_x - closest_x) ** 2 + (pixel_y - closest_y) ** 2
                ) ** 0.5
            coverage = radius + 0.75 - distance
            if coverage <= 0:
                continue
            _blend_pixel(
                pixels, width, x, y, color, coverage=1.0 if coverage > 1 else coverage
            )


def _blend_pixel(
    pixels: bytearray,
    width: int,
    x: int,
    y: int,
    color: tuple[int, int, int, int],
    *,
    coverage: float,
) -> None:
    source_alpha = (color[3] / 255.0) * coverage
    if source_alpha <= 0:
        return
    offset = (y * width + x) * 4
    destination = bytes(pixels[offset : offset + 4])
    pixels[offset : offset + 4] = _blend_rgba(color, destination, source_alpha)


@lru_cache(maxsize=8192)
def _blend_rgba(
    color: tuple[int, int, int, int], destination: bytes, source_alpha: float
) -> bytes:
    dest_alpha = destination[3] / 255.0
    out_alpha = source_alpha + dest_alpha * (1.0 - source_alpha)
    if out_alpha <= 0:
        return destination
    output = bytearray(4)
    for channel in range(3):
        source = color[channel] / 255.0
        dest = destination[channel] / 255.0
        out = (
            source * source_alpha + dest * dest_alpha * (1.0 - source_alpha)
        ) / out_alpha
        output[channel] = int(out * 255 + 0.5)
    output[3] = int(out_alpha * 255 + 0.5)
    return bytes(output)


def _downsample_rgba(
    pixels: bytearray,
    width: int,
    height: int,
    scale: int,
) -> bytearray:
    if scale == 1:
        return pixels
    target_width = width // scale
    target_height = height // scale
    target = bytearray(target_width * target_height * 4)
    samples = scale * scale
    for y in range(target_height):
        for x in range(target_width):
            red = 0
            green = 0
            blue = 0
            alpha = 0
            for sample_y in range(scale):
                source_y = y * scale + sample_y
                for sample_x in range(scale):
                    source_x = x * scale + sample_x
                    source_offset = (source_y * width + source_x) * 4
                    red += pixels[source_offset]
                    green += pixels[source_offset + 1]
                    blue += pixels[source_offset + 2]
                    alpha += pixels[source_offset + 3]
            target_offset = (y * target_width + x) * 4
            target[target_offset : target_offset + 4] = bytes(
                (
                    red // samples,
                    green // samples,
                    blue // samples,
                    alpha // samples,
                )
            )
    return target


def _encode_rgba_png(width: int, height: int, pixels: bytearray) -> bytes:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        start = y * stride
        raw.extend(pixels[start : start + stride])

    png = bytearray(b"\x89PNG\r\n\x1a\n")
    png.extend(
        _png_chunk(
            b"IHDR",
            struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0),
        )
    )
    png.extend(_png_chunk(b"IDAT", zlib.compress(bytes(raw), level=6)))
    png.extend(_png_chunk(b"IEND", b""))
    return bytes(png)


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(chunk_type)
    crc = zlib.crc32(data, crc)
    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", crc & 0xFFFFFFFF)
    )
