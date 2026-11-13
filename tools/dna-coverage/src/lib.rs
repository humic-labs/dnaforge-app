use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use rust_htslib::bam::{self, record::Cigar, IndexedReader, Read};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoverageProvenance {
    pub method: String,
    pub exact: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoverageTile {
    pub chrom: String,
    pub start: i64,
    pub end: i64,
    pub bins: Vec<f64>,
    pub bin_size: usize,
    pub max_depth: f64,
    pub provenance: CoverageProvenance,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BaseLayerSummary {
    pub aligned_base_count: u64,
    pub mean_depth: f64,
    pub chrom: String,
    pub chrom_length: i64,
    pub base_bins: usize,
    pub base_bin_bp: i64,
    pub max_depth: f64,
    pub out_path: PathBuf,
    pub provenance: CoverageProvenance,
}

#[derive(Debug)]
pub struct MaxPoolBuilder {
    start: i64,
    end: i64,
    bins: usize,
    bin_size: usize,
    delta: Vec<i32>,
}

struct StreamingPeakBins {
    chrom_length: i64,
    base_bin_bp: i64,
    values: Vec<f32>,
    active_ends: BinaryHeap<Reverse<i64>>,
    cursor: i64,
}

impl StreamingPeakBins {
    fn new(chrom_length: i64, base_bins: usize) -> anyhow::Result<Self> {
        anyhow::ensure!(chrom_length > 0, "chromosome length must be positive");
        anyhow::ensure!(base_bins > 0, "base-bins must be positive");
        Ok(Self {
            chrom_length,
            base_bin_bp: ceil_div_i64(chrom_length, i64::try_from(base_bins)?).max(1),
            values: vec![0_f32; base_bins],
            active_ends: BinaryHeap::new(),
            cursor: 0,
        })
    }

    fn record_segment(&mut self, end: i64) -> anyhow::Result<()> {
        if end <= self.cursor || self.active_ends.is_empty() {
            self.cursor = end.max(self.cursor);
            return Ok(());
        }
        let first = usize::try_from(self.cursor / self.base_bin_bp)?;
        let last =
            usize::try_from((end - 1) / self.base_bin_bp)?.min(self.values.len().saturating_sub(1));
        let depth = self.active_ends.len() as f32;
        for value in &mut self.values[first..=last] {
            *value = value.max(depth);
        }
        self.cursor = end;
        Ok(())
    }

    fn advance_to(&mut self, position: i64) -> anyhow::Result<()> {
        anyhow::ensure!(
            position >= self.cursor,
            "alignment records are not coordinate-sorted: {} followed {}",
            position,
            self.cursor
        );
        let target = position.min(self.chrom_length);
        while let Some(&Reverse(next_end)) = self.active_ends.peek() {
            if next_end > target {
                break;
            }
            self.record_segment(next_end)?;
            while self.active_ends.peek() == Some(&Reverse(next_end)) {
                self.active_ends.pop();
            }
        }
        self.record_segment(target)
    }

    fn add_interval(&mut self, raw_start: i64, raw_end: i64) -> anyhow::Result<()> {
        let start = raw_start.max(0).min(self.chrom_length);
        let end = raw_end.max(0).min(self.chrom_length);
        anyhow::ensure!(
            start >= self.cursor,
            "alignment records are not coordinate-sorted: {} followed {}",
            start,
            self.cursor
        );
        self.advance_to(start)?;
        if end > start {
            self.active_ends.push(Reverse(end));
        }
        Ok(())
    }

    fn finish(mut self) -> anyhow::Result<Vec<f32>> {
        self.advance_to(self.chrom_length)?;
        Ok(self.values)
    }
}

impl MaxPoolBuilder {
    pub fn new(start: i64, end: i64, bins: usize) -> anyhow::Result<Self> {
        anyhow::ensure!(end > start, "end must be greater than start");
        anyhow::ensure!(bins > 0, "bins must be positive");

        let span = usize::try_from(end - start)?;
        Ok(Self {
            start,
            end,
            bins,
            bin_size: coverage_bin_size(span, bins),
            delta: vec![0_i32; span + 1],
        })
    }

    pub fn new_with_bin_size(start: i64, end: i64, bin_size: usize) -> anyhow::Result<Self> {
        anyhow::ensure!(end > start, "end must be greater than start");
        anyhow::ensure!(bin_size > 0, "bin-size must be positive");

        let span = usize::try_from(end - start)?;
        Ok(Self {
            start,
            end,
            bins: ceil_div_usize(span, bin_size).max(1),
            bin_size,
            delta: vec![0_i32; span + 1],
        })
    }

    pub fn add_interval(&mut self, raw_start: i64, raw_end: i64) -> anyhow::Result<()> {
        let clipped_start = raw_start.max(self.start);
        let clipped_end = raw_end.min(self.end);
        if clipped_end <= clipped_start {
            return Ok(());
        }
        let lo = usize::try_from(clipped_start - self.start)?;
        let hi = usize::try_from(clipped_end - self.start)?;
        self.delta[lo] += 1;
        self.delta[hi] -= 1;
        Ok(())
    }

    pub fn finish(self) -> Vec<f64> {
        let span = usize::try_from(self.end - self.start).expect("validated span");
        let mut out = vec![0_f64; self.bins];
        let mut depth = 0_i32;
        for (offset, change) in self.delta.iter().take(span).enumerate() {
            depth += *change;
            if depth <= 0 {
                continue;
            }
            let bin = (offset / self.bin_size).min(self.bins - 1);
            out[bin] = out[bin].max(f64::from(depth));
        }
        out
    }

    pub fn bin_size(&self) -> usize {
        self.bin_size
    }
}

fn for_each_aligned_block(
    record: &bam::Record,
    mut visit: impl FnMut(i64, i64) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let mut position = record.pos();
    for operation in record.cigar().iter() {
        match operation {
            Cigar::Match(length) | Cigar::Equal(length) | Cigar::Diff(length) => {
                let end = position + i64::from(*length);
                visit(position, end)?;
                position = end;
            }
            Cigar::Del(length) | Cigar::RefSkip(length) => position += i64::from(*length),
            Cigar::Ins(_) | Cigar::SoftClip(_) | Cigar::HardClip(_) | Cigar::Pad(_) => {}
        }
    }
    Ok(())
}

fn drain_pending_blocks(
    pending: &mut BinaryHeap<Reverse<(i64, i64)>>,
    sweep: &mut StreamingPeakBins,
    through: i64,
) -> anyhow::Result<()> {
    while let Some(&Reverse((start, end))) = pending.peek() {
        if start > through {
            break;
        }
        pending.pop();
        sweep.add_interval(start, end)?;
    }
    Ok(())
}

fn open_indexed_reader(
    bam_path: &Path,
    index_path: Option<&Path>,
    reference_fasta: Option<&Path>,
    threads: usize,
) -> anyhow::Result<IndexedReader> {
    anyhow::ensure!(threads > 0, "threads must be positive");
    let mut reader = match index_path {
        Some(path) => IndexedReader::from_path_and_index(bam_path, path)?,
        None => IndexedReader::from_path(bam_path)?,
    };
    reader.set_threads(threads)?;
    if let Some(path) = reference_fasta {
        reader.set_reference(path)?;
    }
    Ok(reader)
}

pub fn max_pool_intervals(start: i64, end: i64, bins: usize, intervals: &[(i64, i64)]) -> Vec<f64> {
    try_max_pool_intervals(start, end, bins, intervals).expect("valid max-pool request")
}

pub fn try_max_pool_intervals(
    start: i64,
    end: i64,
    bins: usize,
    intervals: &[(i64, i64)],
) -> anyhow::Result<Vec<f64>> {
    let mut builder = MaxPoolBuilder::new(start, end, bins)?;
    for &(raw_start, raw_end) in intervals {
        builder.add_interval(raw_start, raw_end)?;
    }
    Ok(builder.finish())
}

pub fn coverage_bin_size(span: usize, bins: usize) -> usize {
    ceil_div_usize(span, bins).max(1)
}

pub fn coverage_tile_from_bam(
    bam_path: &Path,
    index_path: Option<&Path>,
    reference_fasta: Option<&Path>,
    chrom: &str,
    start: i64,
    end: i64,
    bins: usize,
) -> anyhow::Result<CoverageTile> {
    coverage_tile_from_bam_with_optional_bin_size(
        bam_path,
        index_path,
        reference_fasta,
        chrom,
        start,
        end,
        bins,
        None,
    )
}

pub fn coverage_tile_from_bam_with_bin_size(
    bam_path: &Path,
    index_path: Option<&Path>,
    reference_fasta: Option<&Path>,
    chrom: &str,
    start: i64,
    end: i64,
    bin_size: usize,
) -> anyhow::Result<CoverageTile> {
    coverage_tile_from_bam_with_optional_bin_size(
        bam_path,
        index_path,
        reference_fasta,
        chrom,
        start,
        end,
        1,
        Some(bin_size),
    )
}

fn coverage_tile_from_bam_with_optional_bin_size(
    bam_path: &Path,
    index_path: Option<&Path>,
    reference_fasta: Option<&Path>,
    chrom: &str,
    start: i64,
    end: i64,
    bins: usize,
    bin_size: Option<usize>,
) -> anyhow::Result<CoverageTile> {
    let mut reader = open_indexed_reader(bam_path, index_path, reference_fasta, 1)?;
    reader.fetch((chrom, start, end))?;

    let mut builder = match bin_size {
        Some(size) => MaxPoolBuilder::new_with_bin_size(start, end, size)?,
        None => MaxPoolBuilder::new(start, end, bins)?,
    };
    let mut record = bam::Record::new();
    while let Some(result) = reader.read(&mut record) {
        result?;
        if record.is_unmapped() || record.is_secondary() || record.is_supplementary() {
            continue;
        }
        for_each_aligned_block(&record, |start, end| builder.add_interval(start, end))?;
    }

    let bin_size = builder.bin_size();
    let values = builder.finish();
    let max_depth = values.iter().copied().fold(0_f64, f64::max);

    Ok(CoverageTile {
        chrom: chrom.to_string(),
        start,
        end,
        bins: values,
        bin_size,
        max_depth,
        provenance: CoverageProvenance {
            method: "rust-htslib-window-peak".to_string(),
            exact: true,
        },
    })
}

pub fn build_base_layer_from_bam(
    bam_path: &Path,
    index_path: Option<&Path>,
    reference_fasta: Option<&Path>,
    chrom: &str,
    base_bins: usize,
    window_bp: i64,
    threads: usize,
    out_path: &Path,
) -> anyhow::Result<BaseLayerSummary> {
    anyhow::ensure!(base_bins > 0, "base-bins must be positive");
    anyhow::ensure!(window_bp > 0, "window-bp must be positive");
    anyhow::ensure!(threads > 0, "threads must be positive");

    let mut reader = open_indexed_reader(bam_path, index_path, reference_fasta, threads)?;
    let tid = reader
        .header()
        .tid(chrom.as_bytes())
        .ok_or_else(|| anyhow::anyhow!("chrom {chrom} not found in BAM header"))?;
    let chrom_length = reader
        .header()
        .target_len(tid)
        .ok_or_else(|| anyhow::anyhow!("chrom {chrom} length missing in BAM header"))?
        as i64;
    anyhow::ensure!(chrom_length > 0, "chrom {chrom} has non-positive length");

    let mut sweep = StreamingPeakBins::new(chrom_length, base_bins)?;
    let base_bin_bp = sweep.base_bin_bp;
    let mut pending_blocks = BinaryHeap::new();
    let mut aligned_base_count = 0_u64;
    let mut record = bam::Record::new();

    reader.fetch((chrom, 0, chrom_length))?;
    while let Some(result) = reader.read(&mut record) {
        result?;
        if record.is_unmapped() || record.is_secondary() || record.is_supplementary() {
            continue;
        }
        drain_pending_blocks(&mut pending_blocks, &mut sweep, record.pos())?;
        for_each_aligned_block(&record, |start, end| {
            let clipped_start = start.max(0);
            let clipped_end = end.min(chrom_length);
            if clipped_end > clipped_start {
                aligned_base_count = aligned_base_count
                    .checked_add(u64::try_from(clipped_end - clipped_start)?)
                    .ok_or_else(|| anyhow::anyhow!("aligned base count overflow"))?;
            }
            pending_blocks.push(Reverse((start, end)));
            Ok(())
        })?;
    }
    drain_pending_blocks(&mut pending_blocks, &mut sweep, i64::MAX)?;
    let base = sweep.finish()?;

    atomic_write_npy_f32(out_path, &base)?;
    let max_depth = base.iter().copied().fold(0_f32, f32::max) as f64;
    Ok(BaseLayerSummary {
        aligned_base_count,
        mean_depth: aligned_base_count as f64 / chrom_length as f64,
        chrom: chrom.to_string(),
        chrom_length,
        base_bins,
        base_bin_bp,
        max_depth,
        out_path: out_path.to_path_buf(),
        provenance: CoverageProvenance {
            method: "rust-htslib-base-layer".to_string(),
            exact: true,
        },
    })
}

pub fn atomic_write_npy_f32(path: &Path, values: &[f32]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("output path has no file name"))?
        .to_string_lossy();
    let tmp_path = path.with_file_name(format!("{file_name}.tmp"));
    write_npy_f32(&tmp_path, values)?;
    fs::rename(&tmp_path, path)?;
    Ok(())
}

fn write_npy_f32(path: &Path, values: &[f32]) -> anyhow::Result<()> {
    let mut header = format!(
        "{{'descr': '<f4', 'fortran_order': False, 'shape': ({},), }}",
        values.len()
    );
    let preamble_len = 10;
    let header_len_with_newline = preamble_len + header.len() + 1;
    let padding = (16 - (header_len_with_newline % 16)) % 16;
    header.extend(std::iter::repeat_n(' ', padding));
    header.push('\n');
    anyhow::ensure!(
        header.len() <= u16::MAX as usize,
        "npy header too large for v1.0"
    );

    let mut writer = BufWriter::new(File::create(path)?);
    writer.write_all(b"\x93NUMPY")?;
    writer.write_all(&[1, 0])?;
    writer.write_all(&(header.len() as u16).to_le_bytes())?;
    writer.write_all(header.as_bytes())?;
    for value in values {
        writer.write_all(&value.to_le_bytes())?;
    }
    writer.flush()?;
    Ok(())
}

pub fn ceil_div_usize(value: usize, divisor: usize) -> usize {
    value.div_ceil(divisor)
}

fn ceil_div_i64(value: i64, divisor: i64) -> i64 {
    (value + divisor - 1) / divisor
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn max_pool_clips_intervals_and_reports_peak_depth_per_bin() {
        let bins = max_pool_intervals(
            100,
            140,
            4,
            &[(95, 112), (106, 126), (118, 139), (132, 150)],
        );

        assert_eq!(bins, vec![2.0, 2.0, 2.0, 2.0]);
    }

    #[test]
    fn max_pool_leaves_uncovered_bins_zero() {
        let bins = max_pool_intervals(0, 100, 5, &[(10, 20), (70, 85)]);

        assert_eq!(bins, vec![1.0, 0.0, 0.0, 1.0, 1.0]);
    }

    #[test]
    fn exact_bin_size_preserves_lod_width_for_clipped_segments() {
        let mut builder = MaxPoolBuilder::new_with_bin_size(100, 145, 16).unwrap();
        builder.add_interval(100, 120).unwrap();
        builder.add_interval(132, 145).unwrap();
        let bin_size = builder.bin_size();
        let bins = builder.finish();

        assert_eq!(bin_size, 16);
        assert_eq!(bins.len(), 3);
        assert_eq!(bins, vec![1.0, 1.0, 1.0]);
    }

    #[test]
    fn writes_numpy_v1_f32_vector() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dna-coverage-{suffix}.npy"));

        atomic_write_npy_f32(&path, &[1.5, 0.0, 2.25]).unwrap();

        let bytes = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(&bytes[0..6], b"\x93NUMPY");
        assert_eq!(&bytes[6..8], &[1, 0]);
        let header_len = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
        let header = std::str::from_utf8(&bytes[10..10 + header_len]).unwrap();
        assert!(header.contains("'descr': '<f4'"));
        assert!(header.contains("'shape': (3,)"));
        assert_eq!(bytes.len(), 10 + header_len + 3 * 4);
    }

    #[test]
    fn streaming_peak_bins_match_the_per_base_reference() {
        let intervals = vec![(0, 3), (1, 8), (1, 2), (4, 14), (7, 19), (12, 20), (12, 17)];
        let expected = max_pool_intervals(0, 20, 5, &intervals);
        let mut sweep = StreamingPeakBins::new(20, 5).unwrap();
        for &(start, end) in &intervals {
            sweep.add_interval(start, end).unwrap();
        }
        let actual = sweep.finish().unwrap();

        assert_eq!(
            actual,
            expected
                .into_iter()
                .map(|value| value as f32)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn streaming_peak_bins_reject_unsorted_input() {
        let mut sweep = StreamingPeakBins::new(20, 5).unwrap();
        sweep.add_interval(10, 15).unwrap();

        assert!(sweep.add_interval(9, 12).is_err());
    }

    fn alignment_record(start: i64, operations: Vec<Cigar>, name: &[u8]) -> bam::Record {
        let length = operations
            .iter()
            .map(|operation| match operation {
                Cigar::Match(length)
                | Cigar::Equal(length)
                | Cigar::Diff(length)
                | Cigar::Ins(length)
                | Cigar::SoftClip(length) => *length as usize,
                _ => 0,
            })
            .sum();
        let mut record = bam::Record::new();
        record.set(
            name,
            Some(&bam::record::CigarString(operations)),
            &vec![b'A'; length],
            &vec![30; length],
        );
        record.set_tid(0);
        record.set_pos(start);
        record.set_flags(0);
        record.set_mapq(60);
        record
    }

    #[test]
    fn aligned_blocks_exclude_skips_deletions_and_clips() {
        let record = alignment_record(
            5,
            vec![
                Cigar::SoftClip(2),
                Cigar::Match(3),
                Cigar::Ins(2),
                Cigar::Equal(2),
                Cigar::Del(2),
                Cigar::Diff(1),
                Cigar::RefSkip(4),
                Cigar::Match(2),
                Cigar::HardClip(2),
            ],
            b"spliced",
        );
        let mut blocks = Vec::new();
        for_each_aligned_block(&record, |start, end| {
            blocks.push((start, end));
            Ok(())
        })
        .unwrap();
        assert_eq!(blocks, vec![(5, 8), (8, 10), (12, 13), (17, 19)]);
    }

    #[test]
    fn indexed_spliced_alignments_match_window_and_streaming_base_depths() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("dna-coverage-spliced-{suffix}"));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("reads.bam");
        let mut header = bam::Header::new();
        header.push_record(
            bam::header::HeaderRecord::new(b"HD")
                .push_tag(b"VN", "1.6")
                .push_tag(b"SO", "coordinate"),
        );
        header.push_record(
            bam::header::HeaderRecord::new(b"SQ")
                .push_tag(b"SN", "chrT")
                .push_tag(b"LN", 32),
        );
        {
            let mut writer = bam::Writer::from_path(&path, &header, bam::Format::Bam).unwrap();
            for record in [
                alignment_record(
                    0,
                    vec![Cigar::Match(3), Cigar::RefSkip(10), Cigar::Match(3)],
                    b"rna",
                ),
                alignment_record(1, vec![Cigar::Match(20)], b"dna"),
                alignment_record(5, vec![Cigar::Match(3)], b"nested"),
                alignment_record(
                    22,
                    vec![Cigar::Match(3), Cigar::Del(2), Cigar::Match(3)],
                    b"deletion",
                ),
            ] {
                writer.write(&record).unwrap();
            }
        }
        bam::index::build(&path, None, bam::index::Type::Bai, 1).unwrap();
        let expected: Vec<f64> = vec![
            1., 2., 2., 1., 1., 2., 2., 2., 1., 1., 1., 1., 1., 2., 2., 2., 1., 1., 1., 1., 1., 0.,
            1., 1., 1., 0., 0., 1., 1., 1., 0., 0.,
        ];
        let tile = coverage_tile_from_bam(&path, None, None, "chrT", 0, 32, 32).unwrap();
        assert_eq!(tile.bins, expected);
        let clipped =
            coverage_tile_from_bam_with_bin_size(&path, None, None, "chrT", 3, 13, 1).unwrap();
        assert_eq!(clipped.bins, expected[3..13]);
        let output = directory.join("base.npy");
        let summary =
            build_base_layer_from_bam(&path, None, None, "chrT", 32, 32, 1, &output).unwrap();
        assert_eq!(summary.aligned_base_count, 35);
        assert_eq!(summary.mean_depth, 35.0 / 32.0);
        let coarse_output = directory.join("coarse.npy");
        let coarse_summary =
            build_base_layer_from_bam(&path, None, None, "chrT", 4, 32, 1, &coarse_output).unwrap();
        assert_eq!(
            coarse_summary.aligned_base_count,
            summary.aligned_base_count
        );
        assert_eq!(coarse_summary.mean_depth, summary.mean_depth);
        let bytes = fs::read(output).unwrap();
        let actual: Vec<f32> = bytes[bytes.len() - 32 * 4..]
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect();
        assert_eq!(
            actual,
            expected
                .iter()
                .map(|value| *value as f32)
                .collect::<Vec<_>>()
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
