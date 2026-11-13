
use crate::error::IndexerError;
use crate::gff_emit::{emit_gff3_with_opts, EmitOpts};
use crate::model::{ParsedRecord, Strand};
use anyhow::{anyhow, Result};
use noodles_bgzf as bgzf;
use noodles_core::Position;
use noodles_csi as csi;
use noodles_csi::binning_index::index::{
    header::{Builder as TabixHeaderBuilder, ReferenceSequenceNames},
    reference_sequence::{bin::Chunk, index::BinnedIndex},
};
use noodles_csi::binning_index::Indexer as CsiIndexer;
use noodles_tabix as tabix;

pub const TBI_MAX_REFERENCE_LENGTH: u64 = 1 << 29;
const CSI_MIN_SHIFT: u8 = 14;
const CSI_DEPTH: u8 = 6;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

const FASTA_LINE_WIDTH: usize = 80;

pub fn annotation_index_requires_csi(reference_length_bp: u64) -> bool {
    reference_length_bp > TBI_MAX_REFERENCE_LENGTH
}

fn annotation_index_path(out_dir: &Path, basename: &str, reference_length_bp: u64) -> PathBuf {
    if annotation_index_requires_csi(reference_length_bp) {
        out_dir.join(format!("{basename}.gff3.gz.csi"))
    } else {
        out_dir.join(format!("{basename}.gff3.gz.tbi"))
    }
}

pub fn write_bundle(
    record: &ParsedRecord,
    out_dir: &Path,
    basename: &str,
    indexer_version: &str,
) -> Result<BundleOutcome> {
    write_bundle_with_opts(
        record,
        out_dir,
        basename,
        indexer_version,
        &EmitOpts::default(),
    )
}

pub fn write_bundle_with_opts(
    record: &ParsedRecord,
    out_dir: &Path,
    basename: &str,
    indexer_version: &str,
    emit_opts: &EmitOpts,
) -> Result<BundleOutcome> {
    validate_emit_opts(record, emit_opts)?;
    fs::create_dir_all(out_dir).map_err(|e| {
        IndexerError::OutputWriteFailed(format!(
            "could not create out-dir {}: {}",
            out_dir.display(),
            e
        ))
    })?;

    let sequence_paths = sequence_asset_paths(out_dir, basename);
    let gz_path = out_dir.join(format!("{}.gff3.gz", basename));
    let index_path = annotation_index_path(out_dir, basename, record.sequence.len() as u64);
    let fa_tmp = with_tmp(&sequence_paths.fa_gz);
    let gzi_tmp = with_tmp(&sequence_paths.gzi);
    let fai_tmp = with_tmp(&sequence_paths.fai);
    let gz_tmp = with_tmp(&gz_path);
    let tbi_tmp = with_tmp(&index_path);

    let timer = crate::timing::span(format!("{basename}:emit_gff3"));
    let gff3_text = emit_gff3_with_opts(record, basename, indexer_version, emit_opts);
    drop(timer);

    let timer = crate::timing::span(format!("{basename}:write_fasta"));
    write_bgzf_fasta(&fa_tmp, basename, &record.sequence)?;
    write_gzi_for_bgzf(&fa_tmp, &gzi_tmp)?;
    write_fai(&fai_tmp, basename, record.sequence.len())?;
    drop(timer);

    let timer = crate::timing::span(format!("{basename}:write_gff3_index"));
    let annotation_rows = write_bgzf_and_annotation_index(
        &gff3_text,
        &gz_tmp,
        &tbi_tmp,
        record.sequence.len() as u64,
    )?;
    drop(timer);

    rename_or_cleanup(
        &fa_tmp,
        &sequence_paths.fa_gz,
        &[&gzi_tmp, &fai_tmp, &gz_tmp, &tbi_tmp],
    )?;
    rename_or_cleanup(
        &gzi_tmp,
        &sequence_paths.gzi,
        &[&fai_tmp, &gz_tmp, &tbi_tmp],
    )?;
    rename_or_cleanup(&fai_tmp, &sequence_paths.fai, &[&gz_tmp, &tbi_tmp])?;
    rename_or_cleanup(&gz_tmp, &gz_path, &[&tbi_tmp])?;
    rename_or_cleanup(&tbi_tmp, &index_path, &[])?;

    Ok(BundleOutcome {
        fa_path: sequence_paths.fa_gz,
        fai_path: sequence_paths.fai,
        gzi_path: sequence_paths.gzi,
        gz_path,
        tbi_path: index_path,
        annotation_rows,
    })
}

pub fn write_sequence_bundle(
    sequence: &[u8],
    out_dir: &Path,
    basename: &str,
) -> Result<SequenceBundleOutcome> {
    fs::create_dir_all(out_dir).map_err(|e| {
        IndexerError::OutputWriteFailed(format!(
            "could not create out-dir {}: {}",
            out_dir.display(),
            e
        ))
    })?;

    let sequence_paths = sequence_asset_paths(out_dir, basename);
    let fa_tmp = with_tmp(&sequence_paths.fa_gz);
    let gzi_tmp = with_tmp(&sequence_paths.gzi);
    let fai_tmp = with_tmp(&sequence_paths.fai);
    let tracked = [
        &sequence_paths.fa_gz,
        &sequence_paths.gzi,
        &sequence_paths.fai,
        &fa_tmp,
        &gzi_tmp,
        &fai_tmp,
    ];
    for path in tracked {
        if path.exists() {
            return Err(IndexerError::OutputWriteFailed(format!(
                "sequence bundle output already exists: {}",
                path.display()
            ))
            .into());
        }
    }

    let result = (|| {
        write_bgzf_fasta(&fa_tmp, basename, sequence)?;
        write_gzi_for_bgzf(&fa_tmp, &gzi_tmp)?;
        write_fai(&fai_tmp, basename, sequence.len())?;
        fs::rename(&fa_tmp, &sequence_paths.fa_gz).map_err(|error| {
            IndexerError::OutputWriteFailed(format!(
                "rename {} → {} failed: {}",
                fa_tmp.display(),
                sequence_paths.fa_gz.display(),
                error
            ))
        })?;
        fs::rename(&gzi_tmp, &sequence_paths.gzi).map_err(|error| {
            IndexerError::OutputWriteFailed(format!(
                "rename {} → {} failed: {}",
                gzi_tmp.display(),
                sequence_paths.gzi.display(),
                error
            ))
        })?;
        fs::rename(&fai_tmp, &sequence_paths.fai).map_err(|error| {
            IndexerError::OutputWriteFailed(format!(
                "rename {} → {} failed: {}",
                fai_tmp.display(),
                sequence_paths.fai.display(),
                error
            ))
        })?;
        Ok(SequenceBundleOutcome {
            fa_path: sequence_paths.fa_gz.clone(),
            fai_path: sequence_paths.fai.clone(),
            gzi_path: sequence_paths.gzi.clone(),
        })
    })();

    if result.is_err() {
        for path in tracked {
            let _ = fs::remove_file(path);
        }
    }
    result
}

fn validate_emit_opts(record: &ParsedRecord, emit_opts: &EmitOpts) -> Result<()> {
    let canonical_gff3 = match (
        emit_opts.source_ids.as_ref(),
        emit_opts.explicit_parent_source_ids.as_ref(),
    ) {
        (Some(source_ids), Some(parent_ids)) => {
            if source_ids.len() != record.features.len()
                || parent_ids.len() != record.features.len()
            {
                return Err(anyhow!(
                    "canonical GFF3 source-ID and Parent vectors must match the feature count"
                ));
            }
            true
        }
        (None, None) => false,
        _ => {
            return Err(anyhow!(
                "canonical GFF3 source-ID and Parent vectors must be supplied together"
            ));
        }
    };

    let (source_phases, source_strands, source_interval_qualifiers, source_origin_spanning) = match (
        canonical_gff3,
        emit_opts.source_phases.as_ref(),
        emit_opts.source_strands.as_ref(),
        emit_opts.source_interval_qualifiers.as_ref(),
        emit_opts.source_origin_spanning.as_ref(),
    ) {
        (true, Some(phases), Some(strands), Some(qualifiers), Some(origin_spanning)) => {
            (phases, strands, qualifiers, origin_spanning)
        }
        (true, _, _, _, _) => {
            return Err(anyhow!(
                "canonical GFF3 phase, strand, interval-attribute, and origin-normalization vectors must be supplied together"
            ));
        }
        (false, None, None, None, None) => return Ok(()),
        (false, _, _, _, _) => {
            return Err(anyhow!(
                "source phase, strand, interval-attribute, or origin-normalization vectors require canonical GFF3 IDs"
            ));
        }
    };
    if source_phases.len() != record.features.len()
        || source_strands.len() != record.features.len()
        || source_interval_qualifiers.len() != record.features.len()
        || source_origin_spanning.len() != record.features.len()
    {
        return Err(anyhow!(
            "canonical GFF3 phase, strand, and interval-attribute vectors must match the feature count"
        ));
    }
    for (feature, marked) in record.features.iter().zip(source_origin_spanning) {
        if *marked
            && !(record.topology == crate::model::Topology::Circular
                && feature.intervals.len() > 1
                && feature.intervals.iter().any(|interval| interval.start == 1)
                && feature
                    .intervals
                    .iter()
                    .any(|interval| interval.end == record.length))
        {
            return Err(anyhow!(
                "canonical origin-spanning markers require a circular multipart feature with physical rows at coordinate 1 and the record length"
            ));
        }
    }
    for (((feature, phases), strands), interval_qualifiers) in record
        .features
        .iter()
        .zip(source_phases)
        .zip(source_strands)
        .zip(source_interval_qualifiers)
    {
        if phases.len() != feature.intervals.len()
            || strands.len() != feature.intervals.len()
            || interval_qualifiers.len() != feature.intervals.len()
        {
            return Err(anyhow!(
                "canonical GFF3 phase, strand, and interval-attribute vectors for {} must match its interval count",
                feature.feature_type
            ));
        }
        let aggregate_strand = strands.first().copied().map_or(Strand::Unknown, |first| {
            if strands.iter().all(|strand| *strand == first) {
                first
            } else {
                Strand::Unknown
            }
        });
        if feature.strand != aggregate_strand {
            return Err(anyhow!(
                "canonical GFF3 interval strands for {} do not match its aggregate strand",
                feature.feature_type
            ));
        }
        if feature.feature_type.eq_ignore_ascii_case("CDS") {
            if phases.iter().any(|phase| !matches!(phase, Some(0..=2))) {
                return Err(anyhow!(
                    "canonical GFF3 CDS intervals must retain phase 0, 1, or 2"
                ));
            }
        } else if phases.iter().any(Option::is_some) {
            return Err(anyhow!(
                "canonical GFF3 non-CDS intervals must not carry a phase"
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct BundleOutcome {
    pub fa_path: PathBuf,
    pub fai_path: PathBuf,
    pub gzi_path: PathBuf,
    pub gz_path: PathBuf,
    pub tbi_path: PathBuf,
    pub annotation_rows: u64,
}

#[derive(Debug, Clone)]
pub struct SequenceBundleOutcome {
    pub fa_path: PathBuf,
    pub fai_path: PathBuf,
    pub gzi_path: PathBuf,
}

struct SequenceAssetPaths {
    fa_gz: PathBuf,
    fai: PathBuf,
    gzi: PathBuf,
}

fn sequence_asset_paths(out_dir: &Path, basename: &str) -> SequenceAssetPaths {
    SequenceAssetPaths {
        fa_gz: out_dir.join(format!("{basename}.fa.gz")),
        fai: out_dir.join(format!("{basename}.fa.gz.fai")),
        gzi: out_dir.join(format!("{basename}.fa.gz.gzi")),
    }
}

fn with_tmp(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
}

fn rename_or_cleanup(from: &Path, to: &Path, cleanup_on_fail: &[&Path]) -> Result<()> {
    if let Err(e) = fs::rename(from, to) {
        for c in cleanup_on_fail {
            let _ = fs::remove_file(c);
        }
        return Err(IndexerError::OutputWriteFailed(format!(
            "rename {} → {} failed: {}",
            from.display(),
            to.display(),
            e
        ))
        .into());
    }
    Ok(())
}

fn write_fasta_body<W: Write>(writer: &mut W, seqid: &str, sequence: &[u8]) -> Result<()> {
    writeln!(writer, ">{seqid}")
        .map_err(|e| IndexerError::OutputWriteFailed(format!("write FASTA header failed: {e}")))?;
    for chunk in sequence.chunks(FASTA_LINE_WIDTH) {
        writer.write_all(chunk).map_err(|e| {
            IndexerError::OutputWriteFailed(format!("write FASTA sequence failed: {e}"))
        })?;
        writer.write_all(b"\n").map_err(|e| {
            IndexerError::OutputWriteFailed(format!("write FASTA newline failed: {e}"))
        })?;
    }
    writer
        .flush()
        .map_err(|e| IndexerError::OutputWriteFailed(format!("flush FASTA failed: {e}")))?;
    Ok(())
}

#[cfg(test)]
fn write_fasta(path: &Path, seqid: &str, sequence: &[u8]) -> Result<()> {
    let file = File::create(path).map_err(|e| {
        IndexerError::OutputWriteFailed(format!("create {} failed: {}", path.display(), e))
    })?;
    let mut f = BufWriter::with_capacity(1024 * 1024, file);
    write_fasta_body(&mut f, seqid, sequence)
}

fn bgzf_worker_count() -> std::num::NonZeroUsize {
    let cores = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
    std::num::NonZeroUsize::new(cores.clamp(1, 8)).unwrap_or(std::num::NonZeroUsize::MIN)
}

const FASTA_BGZF_COMPRESSION_LEVEL: u8 = 3;

fn fasta_compression_level() -> bgzf::writer::CompressionLevel {
    bgzf::writer::CompressionLevel::new(FASTA_BGZF_COMPRESSION_LEVEL).unwrap_or_default()
}

fn write_bgzf_fasta(path: &Path, seqid: &str, sequence: &[u8]) -> Result<()> {
    let file = File::create(path).map_err(|e| {
        IndexerError::OutputWriteFailed(format!("create {} failed: {}", path.display(), e))
    })?;
    let mut writer = bgzf::multithreaded_writer::Builder::default()
        .set_worker_count(bgzf_worker_count())
        .set_compression_level(fasta_compression_level())
        .build_from_writer(file);
    write_fasta_body(&mut writer, seqid, sequence)?;
    writer.finish().map_err(|e| {
        IndexerError::OutputWriteFailed(format!(
            "finish BGZF FASTA {} failed: {}",
            path.display(),
            e
        ))
    })?;
    Ok(())
}

pub fn compress_plain_fasta_file(fasta_path: &Path) -> Result<SequenceBundleOutcome> {
    if !is_plain_fasta_path(fasta_path) {
        return Err(IndexerError::UnsupportedInputFormat(format!(
            "compress-fasta input must be an uncompressed .fa/.fasta/.fna file: {}",
            fasta_path.display()
        ))
        .into());
    }
    let metadata = fs::metadata(fasta_path).map_err(|error| {
        IndexerError::OutputWriteFailed(format!("stat {} failed: {}", fasta_path.display(), error))
    })?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(IndexerError::OutputWriteFailed(format!(
            "compress-fasta input is missing or empty: {}",
            fasta_path.display()
        ))
        .into());
    }
    let fai_path = push_suffix(fasta_path, ".fai");
    let fai_metadata = fs::metadata(&fai_path).map_err(|error| {
        IndexerError::OutputWriteFailed(format!(
            "compress-fasta requires a non-empty sibling FASTA index {}: {}",
            fai_path.display(),
            error
        ))
    })?;
    if !fai_metadata.is_file() || fai_metadata.len() == 0 {
        return Err(IndexerError::OutputWriteFailed(format!(
            "compress-fasta requires a non-empty sibling FASTA index: {}",
            fai_path.display()
        ))
        .into());
    }

    let fa_gz = push_suffix(fasta_path, ".gz");
    let fai_gz = push_suffix(&fa_gz, ".fai");
    let gzi = push_suffix(&fa_gz, ".gzi");
    let fa_tmp = with_tmp(&fa_gz);
    let fai_tmp = with_tmp(&fai_gz);
    let gzi_tmp = with_tmp(&gzi);
    for leftover in [&fa_tmp, &fai_tmp, &gzi_tmp] {
        let _ = fs::remove_file(leftover);
    }

    let written = (|| {
        write_bgzf_copy_exact(fasta_path, &fa_tmp)?;
        verify_bgzf_matches_plain(&fa_tmp, fasta_path)?;
        write_gzi_for_bgzf(&fa_tmp, &gzi_tmp)?;
        fs::copy(&fai_path, &fai_tmp).map_err(|error| {
            IndexerError::OutputWriteFailed(format!(
                "copy {} → {} failed: {}",
                fai_path.display(),
                fai_tmp.display(),
                error
            ))
        })?;
        replace_file(&fa_tmp, &fa_gz)?;
        replace_file(&gzi_tmp, &gzi)?;
        replace_file(&fai_tmp, &fai_gz)?;
        Ok(SequenceBundleOutcome {
            fa_path: fa_gz,
            fai_path: fai_gz,
            gzi_path: gzi,
        })
    })();
    if written.is_err() {
        let _ = fs::remove_file(&fa_tmp);
        let _ = fs::remove_file(&fai_tmp);
        let _ = fs::remove_file(&gzi_tmp);
    }
    written
}

fn is_plain_fasta_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.ends_with(".gz") {
        return false;
    }
    name.ends_with(".fa") || name.ends_with(".fasta") || name.ends_with(".fna")
}

fn push_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut raw = path.as_os_str().to_os_string();
    raw.push(suffix);
    PathBuf::from(raw)
}

fn write_bgzf_copy_exact(src: &Path, dest: &Path) -> Result<()> {
    let input = File::open(src).map_err(|error| {
        IndexerError::OutputWriteFailed(format!("open {} failed: {}", src.display(), error))
    })?;
    let output = File::create(dest).map_err(|error| {
        IndexerError::OutputWriteFailed(format!("create {} failed: {}", dest.display(), error))
    })?;
    let mut reader = BufReader::with_capacity(1024 * 1024, input);
    let mut writer = bgzf::Writer::new(output);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|error| {
            IndexerError::OutputWriteFailed(format!("read {} failed: {}", src.display(), error))
        })?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).map_err(|error| {
            IndexerError::BgzfWriteFailed(format!(
                "write BGZF copy {} failed: {}",
                dest.display(),
                error
            ))
        })?;
    }
    writer.finish().map_err(|error| {
        IndexerError::BgzfWriteFailed(format!(
            "finish BGZF copy {} failed: {}",
            dest.display(),
            error
        ))
    })?;
    Ok(())
}

fn verify_bgzf_matches_plain(bgzf_path: &Path, plain_path: &Path) -> Result<()> {
    let mut decoder = bgzf::Reader::new(File::open(bgzf_path).map_err(|error| {
        IndexerError::OutputWriteFailed(format!(
            "open {} for identity check failed: {}",
            bgzf_path.display(),
            error
        ))
    })?);
    let mut original = File::open(plain_path).map_err(|error| {
        IndexerError::OutputWriteFailed(format!(
            "open {} for identity check failed: {}",
            plain_path.display(),
            error
        ))
    })?;
    let mut expected = vec![0u8; 64 * 1024];
    let mut decoded = vec![0u8; 64 * 1024];
    loop {
        let want = original.read(&mut expected).map_err(|error| {
            IndexerError::OutputWriteFailed(format!(
                "read {} during identity check failed: {}",
                plain_path.display(),
                error
            ))
        })?;
        let mut got = 0usize;
        while got < want {
            let n = decoder.read(&mut decoded[got..want]).map_err(|error| {
                IndexerError::OutputWriteFailed(format!(
                    "decode {} during identity check failed: {}",
                    bgzf_path.display(),
                    error
                ))
            })?;
            if n == 0 {
                return Err(IndexerError::OutputWriteFailed(format!(
                    "BGZF {} decoded fewer bytes than {}",
                    bgzf_path.display(),
                    plain_path.display()
                ))
                .into());
            }
            got += n;
        }
        if expected[..want] != decoded[..want] {
            return Err(IndexerError::OutputWriteFailed(format!(
                "BGZF {} does not decode to the original bytes of {}",
                bgzf_path.display(),
                plain_path.display()
            ))
            .into());
        }
        if want == 0 {
            let extra = decoder.read(&mut decoded[..1]).map_err(|error| {
                IndexerError::OutputWriteFailed(format!(
                    "decode {} trailing identity check failed: {}",
                    bgzf_path.display(),
                    error
                ))
            })?;
            if extra != 0 {
                return Err(IndexerError::OutputWriteFailed(format!(
                    "BGZF {} decoded extra bytes past {}",
                    bgzf_path.display(),
                    plain_path.display()
                ))
                .into());
            }
            return Ok(());
        }
    }
}

fn clear_readonly(path: &Path) -> Result<()> {
    let metadata = fs::metadata(path).map_err(|error| {
        IndexerError::OutputWriteFailed(format!("stat {} failed: {}", path.display(), error))
    })?;
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).map_err(|error| {
            IndexerError::OutputWriteFailed(format!(
                "clear read-only {} failed: {}",
                path.display(),
                error
            ))
        })?;
    }
    Ok(())
}

fn replace_file(from: &Path, to: &Path) -> Result<()> {
    if to.exists() {
        clear_readonly(to)?;
        fs::remove_file(to).map_err(|error| {
            IndexerError::OutputWriteFailed(format!("replace {} failed: {}", to.display(), error))
        })?;
    }
    fs::rename(from, to).map_err(|error| {
        IndexerError::OutputWriteFailed(format!(
            "rename {} → {} failed: {}",
            from.display(),
            to.display(),
            error
        ))
    })?;
    Ok(())
}

fn scan_bgzf_blocks(file: File) -> std::io::Result<Vec<(u64, u64, u64, u64)>> {
    use std::io::{BufReader, Error, ErrorKind, Seek, SeekFrom};

    let invalid = |message: &str| Error::new(ErrorKind::InvalidData, message.to_string());
    let len = file.metadata()?.len();
    let mut reader = BufReader::with_capacity(1 << 16, file);
    let mut entries = Vec::new();
    let (mut compressed, mut uncompressed) = (0u64, 0u64);
    while compressed < len {
        let mut header = [0u8; 12];
        reader.read_exact(&mut header)?;
        if header[..4] != [0x1f, 0x8b, 0x08, 0x04] {
            return Err(invalid("not a BGZF block header"));
        }
        let xlen = u16::from_le_bytes([header[10], header[11]]) as usize;
        let mut extra = vec![0u8; xlen];
        reader.read_exact(&mut extra)?;
        let mut block_size = None;
        let mut field = extra.as_slice();
        while field.len() >= 4 {
            let sub_len = u16::from_le_bytes([field[2], field[3]]) as usize;
            if field[..2] == *b"BC" && sub_len == 2 && field.len() >= 6 {
                block_size = Some(u16::from_le_bytes([field[4], field[5]]) as u64 + 1);
            }
            field = field.get(4 + sub_len..).unwrap_or(&[]);
        }
        let block_size = block_size.ok_or_else(|| invalid("BGZF block has no BC field"))?;
        let trailer_at = compressed + block_size - 4;
        reader.seek(SeekFrom::Start(trailer_at))?;
        let mut isize = [0u8; 4];
        reader.read_exact(&mut isize)?;
        let block_len = u32::from_le_bytes(isize) as u64;
        entries.push((compressed, uncompressed, block_len, block_size));
        uncompressed += block_len;
        compressed += block_size;
    }
    Ok(entries)
}

fn write_gzi_for_bgzf(bgzf_path: &Path, gzi_path: &Path) -> Result<()> {
    let file = File::open(bgzf_path).map_err(|e| {
        IndexerError::OutputWriteFailed(format!(
            "open {} to build GZI failed: {}",
            bgzf_path.display(),
            e
        ))
    })?;
    let blocks = scan_bgzf_blocks(file).map_err(|e| {
        IndexerError::OutputWriteFailed(format!(
            "read {} while building GZI failed: {}",
            bgzf_path.display(),
            e
        ))
    })?;
    let entries: Vec<(u64, u64)> = blocks
        .into_iter()
        .filter(|&(compressed, _, len, _)| compressed != 0 && len != 0)
        .map(|(compressed, uncompressed, _, _)| (compressed, uncompressed))
        .collect();
    bgzf::gzi::fs::write(gzi_path, &bgzf::gzi::Index::from(entries)).map_err(|e| {
        IndexerError::OutputWriteFailed(format!("write GZI {} failed: {}", gzi_path.display(), e))
    })?;
    Ok(())
}

fn write_fai(path: &Path, seqid: &str, sequence_length: usize) -> Result<()> {
    if sequence_length == 0 {
        return Err(
            IndexerError::OutputWriteFailed("cannot index an empty FASTA sequence".into()).into(),
        );
    }
    let offset = 1usize
        .checked_add(seqid.len())
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| IndexerError::OutputWriteFailed("FASTA header offset overflow".into()))?;
    let line_bases = sequence_length.min(FASTA_LINE_WIDTH);
    let line_width = line_bases + 1;
    let mut file = BufWriter::new(File::create(path).map_err(|e| {
        IndexerError::OutputWriteFailed(format!("create {} failed: {}", path.display(), e))
    })?);
    writeln!(
        file,
        "{seqid}\t{sequence_length}\t{offset}\t{line_bases}\t{line_width}"
    )
    .and_then(|()| file.flush())
    .map_err(|e| {
        IndexerError::OutputWriteFailed(format!("write FAI {} failed: {}", path.display(), e))
    })?;
    Ok(())
}

fn write_bgzf_and_annotation_index(
    gff3_text: &str,
    gz_path: &Path,
    index_path: &Path,
    reference_length_bp: u64,
) -> Result<u64> {
    if annotation_index_requires_csi(reference_length_bp) {
        write_bgzf_and_csi(gff3_text, gz_path, index_path)
    } else {
        write_bgzf_and_tabix(gff3_text, gz_path, index_path)
    }
}

const BGZF_BLOCK_UNCOMPRESSED: u64 = 65_495;

/// line by line through `bgzf::Writer` (pinned by a test below).
fn write_indexed_gff3_bgzf<F>(gff3_text: &str, gz_path: &Path, mut on_record: F) -> Result<()>
where
    F: FnMut(&str, Position, Position, Chunk) -> Result<()>,
{
    let bgzf_failed = |what: &str, e: &dyn std::fmt::Display| {
        IndexerError::BgzfWriteFailed(format!("{what} {} failed: {e}", gz_path.display()))
    };
    let gff3_text: std::borrow::Cow<str> = if gff3_text.ends_with('\n') && !gff3_text.contains('\r')
    {
        gff3_text.into()
    } else {
        gff3_text
            .lines()
            .flat_map(|line| [line, "\n"])
            .collect::<String>()
            .into()
    };
    let gz_file = File::create(gz_path).map_err(|e| bgzf_failed("create", &e))?;
    let mut writer = bgzf::MultithreadedWriter::with_worker_count(bgzf_worker_count(), gz_file);
    writer
        .write_all(gff3_text.as_bytes())
        .map_err(|e| bgzf_failed("write", &e))?;
    writer.finish().map_err(|e| bgzf_failed("finish", &e))?;

    let blocks = scan_bgzf_blocks(File::open(gz_path).map_err(|e| bgzf_failed("reopen", &e))?)
        .map_err(|e| bgzf_failed("scan", &e))?;
    let data_blocks = blocks.iter().filter(|block| block.2 != 0).count();
    if blocks[..data_blocks.saturating_sub(1)]
        .iter()
        .any(|block| block.2 != BGZF_BLOCK_UNCOMPRESSED)
    {
        return Err(anyhow!(
            "BGZF writer block size is not {BGZF_BLOCK_UNCOMPRESSED}; chunk offsets would be wrong"
        ));
    }
    let virtual_position = |offset: u64| -> Result<bgzf::VirtualPosition> {
        let index = (offset / BGZF_BLOCK_UNCOMPRESSED) as usize;
        let compressed = blocks.get(index).map_or_else(
            || blocks.last().map_or(0, |last| last.0 + last.3),
            |block| block.0,
        );
        let within = (offset % BGZF_BLOCK_UNCOMPRESSED) as u16;
        bgzf::VirtualPosition::try_from((compressed, within))
            .map_err(|e| anyhow!("virtual position for offset {offset}: {e}"))
    };

    let mut offset = 0u64;
    for line in gff3_text.split_inclusive('\n') {
        let before = offset;
        offset += line.len() as u64;
        let line = line.strip_suffix('\n').unwrap_or(line);
        if line.starts_with("##") || line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(6, '\t').collect();
        if parts.len() < 5 {
            continue;
        }
        let column = |value: &str, name: &str| -> Result<Position> {
            let number: u64 = value.parse().map_err(|e| {
                IndexerError::BgzfWriteFailed(format!(
                    "non-numeric {name} column on line: {line}: {e}"
                ))
            })?;
            Position::try_from(number as usize).map_err(|e| {
                IndexerError::BgzfWriteFailed(format!("{name} position {number} invalid: {e}"))
                    .into()
            })
        };
        let start = column(parts[3], "start")?;
        let end = column(parts[4], "end")?;
        on_record(
            parts[0],
            start,
            end,
            Chunk::new(virtual_position(before)?, virtual_position(offset)?),
        )?;
    }
    Ok(())
}

#[cfg(test)]
fn write_indexed_gff3_bgzf_serial<F>(
    gff3_text: &str,
    gz_path: &Path,
    mut on_record: F,
) -> Result<()>
where
    F: FnMut(&str, Position, Position, Chunk) -> Result<()>,
{
    let gz_file = File::create(gz_path).map_err(|e| {
        IndexerError::BgzfWriteFailed(format!("create {} failed: {}", gz_path.display(), e))
    })?;
    let mut writer = bgzf::Writer::new(gz_file);

    for line in gff3_text.lines() {
        let before = writer.virtual_position();
        writer
            .write_all(line.as_bytes())
            .and_then(|()| writer.write_all(b"\n"))
            .map_err(|e| {
                IndexerError::BgzfWriteFailed(format!(
                    "write line to {} failed: {}",
                    gz_path.display(),
                    e
                ))
            })?;
        let after = writer.virtual_position();

        if line.starts_with("##") || line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 5 {
            continue;
        }
        let seqid = parts[0];
        let start: u64 = parts[3].parse().map_err(|e| {
            IndexerError::BgzfWriteFailed(format!(
                "non-numeric start column on line: {}: {}",
                line, e
            ))
        })?;
        let end: u64 = parts[4].parse().map_err(|e| {
            IndexerError::BgzfWriteFailed(format!(
                "non-numeric end column on line: {}: {}",
                line, e
            ))
        })?;

        let start_pos = Position::try_from(start as usize).map_err(|e| {
            IndexerError::BgzfWriteFailed(format!("start position {} invalid: {}", start, e))
        })?;
        let end_pos = Position::try_from(end as usize).map_err(|e| {
            IndexerError::BgzfWriteFailed(format!("end position {} invalid: {}", end, e))
        })?;

        on_record(seqid, start_pos, end_pos, Chunk::new(before, after))?;
    }

    drop(writer);
    Ok(())
}

fn write_bgzf_and_tabix(gff3_text: &str, gz_path: &Path, tbi_path: &Path) -> Result<u64> {
    let mut indexer = tabix::index::Indexer::default();
    indexer.set_header(TabixHeaderBuilder::gff().build());
    let mut rows = 0u64;
    write_indexed_gff3_bgzf(gff3_text, gz_path, |seqid, start, end, chunk| {
        rows += 1;
        indexer
            .add_record(seqid, start, end, chunk)
            .map_err(|e| anyhow!("indexer.add_record failed: {e}"))
    })?;
    tabix::fs::write(tbi_path, &indexer.build()).map_err(|e| {
        IndexerError::BgzfWriteFailed(format!("write tbi {} failed: {}", tbi_path.display(), e))
    })?;
    Ok(rows)
}

fn write_bgzf_and_csi(gff3_text: &str, gz_path: &Path, csi_path: &Path) -> Result<u64> {
    let mut names = ReferenceSequenceNames::new();
    let mut indexer = CsiIndexer::<BinnedIndex>::new(CSI_MIN_SHIFT, CSI_DEPTH);
    let mut rows = 0u64;
    write_indexed_gff3_bgzf(gff3_text, gz_path, |seqid, start, end, chunk| {
        rows += 1;
        let (reference_sequence_id, _) = names.insert_full(seqid.into());
        indexer
            .add_record(Some((reference_sequence_id, start, end, true)), chunk)
            .map_err(|e| anyhow!("csi indexer.add_record failed: {e}"))
    })?;
    let count = names.len();
    let mut header = TabixHeaderBuilder::gff().build();
    *header.reference_sequence_names_mut() = names;
    let index = indexer.set_header(header).build(count);
    csi::fs::write(csi_path, &index).map_err(|e| {
        IndexerError::BgzfWriteFailed(format!("write csi {} failed: {}", csi_path.display(), e))
    })?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gff3_input::parse_gff3;
    use crate::model::{Feature, Interval, ParsedRecord, Strand, Topology};
    use std::io::Read;

    fn record_chunks(
        text: &str,
        path: &Path,
        parallel: bool,
    ) -> Vec<(String, usize, usize, Chunk)> {
        let mut records = Vec::new();
        let on_record = |seqid: &str, start: Position, end: Position, chunk: Chunk| {
            records.push((seqid.to_string(), start.get(), end.get(), chunk));
            Ok(())
        };
        if parallel {
            write_indexed_gff3_bgzf(text, path, on_record).unwrap();
        } else {
            write_indexed_gff3_bgzf_serial(text, path, on_record).unwrap();
        }
        records
    }

    #[test]
    fn parallel_gff3_bgzf_matches_serial_writer_bytes_and_chunks() {
        let dir = tmpdir("parallel_gff3_bgzf");
        fs::create_dir_all(&dir).unwrap();
        let row = |i: usize| {
            format!(
                "chr1\tDNAForge\tgene\t{}\t{}\t.\t+\t.\tID=g{i};note={}\n",
                i + 1,
                i + 50,
                "x".repeat(i % 97)
            )
        };
        let many: String = std::iter::once("##gff-version 3\n".to_string())
            .chain((0..20_000).map(row))
            .collect();
        let mut exact = String::from("##gff-version 3\n");
        let body = "chr1\tDNAForge\tgene\t1\t2\t.\t+\t.\tID=a;note=";
        let fill = 2 * BGZF_BLOCK_UNCOMPRESSED as usize - exact.len() - body.len() - 1;
        exact.push_str(body);
        exact.push_str(&"y".repeat(fill));
        exact.push('\n');
        assert_eq!(exact.len() as u64, 2 * BGZF_BLOCK_UNCOMPRESSED);
        let unterminated = "##gff-version 3\r\nchr1\tDNAForge\tgene\t5\t9\t.\t+\t.\tID=b";

        for (name, text) in [
            ("many", many.as_str()),
            ("exact", &exact),
            ("crlf", unterminated),
        ] {
            let serial_path = dir.join(format!("{name}.serial.gz"));
            let parallel_path = dir.join(format!("{name}.parallel.gz"));
            let serial = record_chunks(text, &serial_path, false);
            let parallel = record_chunks(text, &parallel_path, true);
            assert!(!serial.is_empty(), "{name}: no records");
            assert_eq!(parallel, serial, "{name}: chunks differ");
            assert_eq!(
                fs::read(&parallel_path).unwrap(),
                fs::read(&serial_path).unwrap(),
                "{name}: BGZF bytes differ"
            );
        }
        let _ = fs::remove_dir_all(dir);
    }

    fn tmpdir(test: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("dna-indexer-test-{}-{}", test, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn read_bgzf_to_string(path: &Path) -> String {
        let mut reader = bgzf::Reader::new(File::open(path).unwrap());
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        text
    }

    fn simple_record() -> ParsedRecord {
        let sequence: Vec<u8> = (0..200).map(|i| b"ACGT"[i % 4]).collect();
        ParsedRecord {
            name: "chrTest".to_string(),
            length: 200,
            topology: Topology::Linear,
            features: vec![
                Feature {
                    feature_type: "gene".into(),
                    strand: Strand::Plus,
                    intervals: vec![Interval { start: 1, end: 100 }],
                    qualifiers: vec![("gene".into(), Some("alpha".into()))],
                    location_string: "1..100".into(),
                },
                Feature {
                    feature_type: "gene".into(),
                    strand: Strand::Minus,
                    intervals: vec![Interval {
                        start: 50,
                        end: 200,
                    }],
                    qualifiers: vec![("gene".into(), Some("beta".into()))],
                    location_string: "complement(50..200)".into(),
                },
            ],
            sequence,
        }
    }

    #[test]
    fn write_bundle_produces_annotated_bundle() {
        let out_dir = tmpdir("four_files");
        let rec = simple_record();
        let outcome = write_bundle(&rec, &out_dir, "test", "0.0.0").expect("bundle write");
        for p in [
            &outcome.fa_path,
            &outcome.fai_path,
            &outcome.gzi_path,
            &outcome.gz_path,
            &outcome.tbi_path,
        ] {
            assert!(p.exists(), "expected output file missing: {}", p.display());
            assert!(
                p.metadata().unwrap().len() > 0,
                "expected non-empty output: {}",
                p.display()
            );
        }
    }

    #[test]
    fn write_sequence_bundle_produces_bgzf_fasta_fai_and_gzi() {
        let out_dir = tmpdir("sequence_pair");
        let outcome =
            write_sequence_bundle(b"ACGTACGT", &out_dir, "chrPair").expect("sequence pair");
        assert_eq!(
            read_bgzf_to_string(&outcome.fa_path),
            ">chrPair\nACGTACGT\n"
        );
        assert_eq!(
            fs::read_to_string(&outcome.fai_path).unwrap(),
            "chrPair\t8\t9\t8\t9\n"
        );
        assert!(outcome.gzi_path.is_file(), "missing GZI");
        let mut names = fs::read_dir(&out_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(
            names,
            vec!["chrPair.fa.gz", "chrPair.fa.gz.fai", "chrPair.fa.gz.gzi"]
        );
    }

    #[test]
    fn failed_sequence_bundle_leaves_no_partial_files() {
        let out_dir = tmpdir("sequence_pair_failure");
        let error = write_sequence_bundle(b"", &out_dir, "chrEmpty").unwrap_err();
        assert!(error.to_string().contains("cannot index an empty FASTA"));
        assert_eq!(
            fs::read_dir(&out_dir).unwrap().count(),
            0,
            "failed pair publication leaked a final or temporary file"
        );
    }

    #[test]
    fn canonical_gff3_bundle_rejects_phase_vector_drift() {
        let out_dir = tmpdir("phase_vector_drift");
        let mut rec = simple_record();
        rec.features[0].feature_type = "CDS".into();
        let opts = EmitOpts {
            source_ids: Some(vec![Some("cds-1".into()), Some("gene-2".into())]),
            explicit_parent_source_ids: Some(vec![None, None]),
            source_phases: Some(vec![vec![None], vec![None]]),
            source_strands: Some(vec![vec![Strand::Plus], vec![Strand::Minus]]),
            source_interval_qualifiers: Some(vec![vec![vec![]], vec![vec![]]]),
            source_origin_spanning: Some(vec![false, false]),
        };
        let error = write_bundle_with_opts(&rec, &out_dir, "test", "0.0.0", &opts).unwrap_err();
        assert!(error
            .to_string()
            .contains("CDS intervals must retain phase 0, 1, or 2"));
        assert!(
            !out_dir.exists(),
            "invalid emit options created output state"
        );
    }

    #[test]
    fn canonical_mixed_strand_parent_round_trips_shared_id_and_segment_metadata() {
        let out_dir = tmpdir("mixed_strand_parent");
        let rec = ParsedRecord {
            name: "NT_033777.3".into(),
            length: 600,
            topology: Topology::Linear,
            sequence: vec![b'a'; 600],
            features: vec![
                Feature {
                    feature_type: "gene".into(),
                    strand: Strand::Unknown,
                    intervals: vec![
                        Interval {
                            start: 501,
                            end: 600,
                        },
                        Interval {
                            start: 401,
                            end: 500,
                        },
                        Interval {
                            start: 301,
                            end: 400,
                        },
                        Interval {
                            start: 201,
                            end: 300,
                        },
                        Interval {
                            start: 101,
                            end: 200,
                        },
                    ],
                    qualifiers: vec![],
                    location_string: "trans-spliced".into(),
                },
                Feature {
                    feature_type: "mRNA".into(),
                    strand: Strand::Minus,
                    intervals: vec![Interval {
                        start: 101,
                        end: 600,
                    }],
                    qualifiers: vec![],
                    location_string: "101..600".into(),
                },
            ],
        };
        let opts = EmitOpts {
            source_ids: Some(vec![
                Some("gene-Dmel_CG32491".into()),
                Some("rna-NM_163881.2".into()),
            ]),
            explicit_parent_source_ids: Some(vec![None, Some("gene-Dmel_CG32491".into())]),
            source_phases: Some(vec![vec![None; 5], vec![None]]),
            source_strands: Some(vec![
                vec![
                    Strand::Minus,
                    Strand::Plus,
                    Strand::Minus,
                    Strand::Plus,
                    Strand::Minus,
                ],
                vec![Strand::Minus],
            ]),
            source_interval_qualifiers: Some(vec![
                vec![
                    vec![("part".into(), Some("1".into()))],
                    vec![("part".into(), Some("2".into()))],
                    vec![("part".into(), Some("3".into()))],
                    vec![("part".into(), Some("4".into()))],
                    vec![("part".into(), Some("5".into()))],
                ],
                vec![vec![]],
            ]),
            source_origin_spanning: Some(vec![false, false]),
        };
        let outcome =
            write_bundle_with_opts(&rec, &out_dir, "NT_033777.3", "0.0.0", &opts).unwrap();
        let reparsed = parse_gff3(&outcome.gz_path, None).unwrap();
        assert_eq!(reparsed.record.features.len(), 2);
        assert_eq!(reparsed.record.features[0].intervals.len(), 5);
        assert_eq!(reparsed.record.features[0].strand, Strand::Unknown);
        assert_eq!(
            reparsed.source_strands[0],
            vec![
                Strand::Minus,
                Strand::Plus,
                Strand::Minus,
                Strand::Plus,
                Strand::Minus
            ]
        );
        assert_eq!(
            reparsed.source_interval_qualifiers[0]
                .iter()
                .map(|qualifiers| qualifiers
                    .iter()
                    .find(|(key, _)| key == "part")
                    .and_then(|(_, value)| value.as_deref())
                    .unwrap())
                .collect::<Vec<_>>(),
            vec!["5", "4", "3", "2", "1"]
        );
        assert_eq!(
            reparsed.parent_ids[1].as_deref(),
            reparsed.source_ids[0].as_deref()
        );
    }

    #[test]
    fn circular_origin_bundle_round_trips_and_indexes_both_physical_segments() {
        use noodles_core::{region::Interval as QueryInterval, Position};
        use noodles_csi::BinningIndex;

        let out_dir = tmpdir("circular_origin_bundle");
        let rec = ParsedRecord {
            name: "chrM".into(),
            length: 10,
            topology: Topology::Circular,
            sequence: b"ACGTACGTAC".to_vec(),
            features: vec![Feature {
                feature_type: "D_loop".into(),
                strand: Strand::Plus,
                intervals: vec![
                    Interval { start: 8, end: 10 },
                    Interval { start: 1, end: 3 },
                ],
                qualifiers: vec![("gbkey".into(), Some("D-loop".into()))],
                location_string: "8..13".into(),
            }],
        };
        let opts = EmitOpts {
            source_ids: Some(vec![Some("origin-d-loop".into())]),
            explicit_parent_source_ids: Some(vec![None]),
            source_phases: Some(vec![vec![None, None]]),
            source_strands: Some(vec![vec![Strand::Plus, Strand::Plus]]),
            source_interval_qualifiers: Some(vec![vec![
                vec![("gbkey".into(), Some("D-loop".into()))],
                vec![("gbkey".into(), Some("D-loop".into()))],
            ]]),
            source_origin_spanning: Some(vec![true]),
        };
        let outcome = write_bundle_with_opts(&rec, &out_dir, "chrM", "0.0.0", &opts).unwrap();

        let reparsed = parse_gff3(&outcome.gz_path, None).unwrap();
        assert_eq!(reparsed.record.topology, Topology::Circular);
        assert!(reparsed.source_origin_spanning[0]);
        assert_eq!(reparsed.record.features[0].intervals.len(), 2);

        let index = tabix::fs::read(&outcome.tbi_path).expect("read origin-spanning tbi");
        let header = index.header().expect("index has GFF header");
        let ref_id = header
            .reference_sequence_names()
            .iter()
            .position(|name| name.as_slice() == b"chrM")
            .expect("chrM indexed");
        for (start, end) in [(1usize, 3usize), (8usize, 10usize)] {
            let interval = QueryInterval::from(
                Position::try_from(start).unwrap()..=Position::try_from(end).unwrap(),
            );
            assert!(
                !index.query(ref_id, interval).unwrap().is_empty(),
                "tabix query {start}..{end} returned no chunks"
            );
        }

        let mut reader = bgzf::Reader::new(File::open(&outcome.gz_path).unwrap());
        let mut decoded = String::new();
        reader.read_to_string(&mut decoded).unwrap();
        let rows: Vec<Vec<&str>> = decoded
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split('\t').collect())
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0][3], rows[0][4]), ("1", "3"));
        assert_eq!((rows[1][3], rows[1][4]), ("8", "10"));
        let ids: std::collections::HashSet<&str> = rows
            .iter()
            .map(|columns| {
                columns[8]
                    .split(';')
                    .find_map(|attribute| attribute.strip_prefix("ID="))
                    .unwrap()
            })
            .collect();
        assert_eq!(ids.len(), 1);
        assert!(rows
            .iter()
            .all(|columns| columns[8].contains("_dnaforge_origin_spanning=true")));
    }

    #[test]
    fn no_partial_tmp_files_remain_on_success() {
        let out_dir = tmpdir("no_partial_tmps");
        let rec = simple_record();
        write_bundle(&rec, &out_dir, "test", "0.0.0").expect("bundle write");
        for entry in fs::read_dir(&out_dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            assert!(
                !name.ends_with(".tmp"),
                "leftover .tmp file: {}",
                path.display()
            );
        }
    }

    #[test]
    fn fasta_has_header_and_wrapped_sequence() {
        let out_dir = tmpdir("fasta_wrap");
        let rec = simple_record();
        let outcome = write_bundle(&rec, &out_dir, "test", "0.0.0").unwrap();
        let fa_contents = read_bgzf_to_string(&outcome.fa_path);
        let lines: Vec<&str> = fa_contents.lines().collect();
        assert_eq!(lines[0], ">test");
        assert_eq!(lines.len(), 4, "expected header + 3 seq lines");
        assert_eq!(lines[1].len(), 80);
        assert_eq!(lines[2].len(), 80);
        assert_eq!(lines[3].len(), 40);
    }

    #[test]
    fn bgzf_is_readable_by_tabix() {
        use noodles_csi::BinningIndex;
        let out_dir = tmpdir("bgzf_validity");
        let rec = simple_record();
        let outcome = write_bundle(&rec, &out_dir, "test", "0.0.0").unwrap();
        let index = tabix::fs::read(&outcome.tbi_path).expect("tbi readable");
        let _ = index.header();
    }

    #[test]
    fn gff3_records_present_in_bgzf() {
        let out_dir = tmpdir("gff3_records");
        let rec = simple_record();
        let outcome = write_bundle(&rec, &out_dir, "test", "0.0.0").unwrap();

        let f = File::open(&outcome.gz_path).unwrap();
        let mut reader = bgzf::Reader::new(f);
        let mut decoded = String::new();
        reader.read_to_string(&mut decoded).unwrap();

        assert!(
            decoded.starts_with("##gff-version 3"),
            "BGZF stream doesn't start with GFF3 pragma; got:\n{}",
            &decoded[..decoded.len().min(200)]
        );
        let data_lines: Vec<&str> = decoded.lines().filter(|l| !l.starts_with("##")).collect();
        assert!(
            data_lines.len() >= 2,
            "expected at least 2 data rows, got {}",
            data_lines.len()
        );
    }

    #[test]
    fn fai_lists_one_seqid_with_correct_length() {
        let out_dir = tmpdir("fai_correct");
        let rec = simple_record();
        let outcome = write_bundle(&rec, &out_dir, "test", "0.0.0").unwrap();

        let mut fai_contents = String::new();
        File::open(&outcome.fai_path)
            .unwrap()
            .read_to_string(&mut fai_contents)
            .unwrap();
        let lines: Vec<&str> = fai_contents.lines().collect();
        assert_eq!(lines.len(), 1, "single-record bundle → single fai entry");
        assert_eq!(
            lines[0], "test\t200\t6\t80\t81",
            "FAI is derived exactly from the emitted FASTA layout"
        );
    }

    #[test]
    fn direct_fai_matches_noodles_for_every_line_width_boundary() {
        let root = tmpdir("direct_fai_equivalence");
        fs::create_dir_all(&root).unwrap();
        for (index, (seqid, sequence_length)) in [
            ("empty", 0usize),
            ("one", 1),
            ("seventy_nine", 79),
            ("eighty", 80),
            ("eighty_one", 81),
            ("chrM-β", 81),
        ]
        .into_iter()
        .enumerate()
        {
            let case_dir = root.join(index.to_string());
            fs::create_dir(&case_dir).unwrap();
            let fasta_path = case_dir.join("sequence.fa");
            let expected_path = case_dir.join("noodles.fa.fai");
            let actual_path = case_dir.join("direct.fa.fai");
            write_fasta(&fasta_path, seqid, &vec![b'a'; sequence_length]).unwrap();
            match noodles_fasta::fs::index(&fasta_path) {
                Ok(expected) => {
                    noodles_fasta::fai::fs::write(&expected_path, &expected).unwrap();
                    write_fai(&actual_path, seqid, sequence_length).unwrap();
                    assert_eq!(
                        fs::read(&actual_path).unwrap(),
                        fs::read(&expected_path).unwrap(),
                        "direct FAI drifted from noodles for {seqid:?} at {sequence_length} bases"
                    );
                }
                Err(expected) => {
                    assert_eq!(
                        sequence_length, 0,
                        "unexpected noodles FAI failure: {expected}"
                    );
                    assert!(
                        write_fai(&actual_path, seqid, sequence_length).is_err(),
                        "direct FAI accepted an input noodles rejects: {expected}"
                    );
                    assert!(
                        !actual_path.exists(),
                        "failed direct FAI left a partial output"
                    );
                }
            }
        }
    }

    #[test]
    fn tabix_index_returns_chunks_for_region_with_features() {
        use noodles_core::{region::Interval, Position};
        use noodles_csi::BinningIndex;

        let out_dir = tmpdir("tabix_chunks");
        let rec = simple_record();
        let outcome = write_bundle(&rec, &out_dir, "test", "0.0.0").unwrap();

        let index = tabix::fs::read(&outcome.tbi_path).expect("read tbi");
        let header = index.header().expect("index has GFF header");
        let ref_id = header
            .reference_sequence_names()
            .iter()
            .position(|n| n.as_slice() == b"test")
            .expect("seqid 'test' indexed");

        let start = Position::try_from(1).unwrap();
        let end = Position::try_from(200).unwrap();
        let interval = Interval::from(start..=end);
        let chunks = index.query(ref_id, interval).expect("query ok");
        assert!(
            !chunks.is_empty(),
            "tabix index has no chunks for a region known to overlap features"
        );
    }

    #[test]
    fn tabix_index_records_seqid_in_header() {
        use noodles_csi::BinningIndex;
        let out_dir = tmpdir("tabix_seqid");
        let rec = simple_record();
        let outcome = write_bundle(&rec, &out_dir, "test", "0.0.0").unwrap();

        let index = tabix::fs::read(&outcome.tbi_path).unwrap();
        let header = index.header().unwrap();
        let has_test = header
            .reference_sequence_names()
            .iter()
            .any(|n| n.as_slice() == b"test");
        assert!(
            has_test,
            "expected 'test' in indexed seqids; got {:?}",
            header.reference_sequence_names()
        );
    }

    #[test]
    fn fasta_handles_exact_multiple_of_line_width() {
        let mut rec = simple_record();
        rec.sequence = vec![b'a'; 160];
        rec.length = 160;

        let out_dir = tmpdir("fasta_exact");
        let outcome = write_bundle(&rec, &out_dir, "test", "0.0.0").unwrap();
        let contents = read_bgzf_to_string(&outcome.fa_path);
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 3, "header + 2 seq lines");
        assert_eq!(lines[1].len(), 80);
        assert_eq!(lines[2].len(), 80);
    }

    #[test]
    fn tabix_index_resolves_chunks_across_multiple_bgzf_blocks() {
        use noodles_core::{region::Interval, Position};
        use noodles_csi::BinningIndex;

        let mut rec = simple_record();
        rec.features.clear();
        rec.length = 1_000_000;
        rec.sequence = vec![b'a'; 1_000_000];
        for i in 0..5000u64 {
            rec.features.push(crate::model::Feature {
                feature_type: "gene".to_string(),
                strand: crate::model::Strand::Plus,
                intervals: vec![crate::model::Interval {
                    start: i * 100 + 1,
                    end: i * 100 + 50,
                }],
                qualifiers: vec![("gene".to_string(), Some(format!("g{}", i)))],
                location_string: format!("{}..{}", i * 100 + 1, i * 100 + 50),
            });
        }

        let out_dir = tmpdir("tabix_multiblock");
        let outcome = write_bundle(&rec, &out_dir, "test", "0.0.0").unwrap();


        let f = File::open(&outcome.gz_path).unwrap();
        let mut reader = bgzf::Reader::new(f);
        let mut decoded = String::new();
        reader.read_to_string(&mut decoded).unwrap();
        assert!(
            decoded.len() > 64 * 1024,
            "uncompressed payload only {} bytes — test fixture insufficient",
            decoded.len()
        );
        let data_lines = decoded.lines().filter(|l| !l.starts_with("##")).count();
        assert_eq!(
            data_lines, 5000,
            "expected 5000 data rows in BGZF stream, got {}",
            data_lines
        );

        let index = tabix::fs::read(&outcome.tbi_path).expect("read tbi");
        let header = index.header().expect("index has header");
        let ref_id = header
            .reference_sequence_names()
            .iter()
            .position(|n| n.as_slice() == b"test")
            .unwrap();

        let start = Position::try_from(900_000).unwrap();
        let end = Position::try_from(1_000_000).unwrap();
        let chunks = index
            .query(ref_id, Interval::from(start..=end))
            .expect("query late region");
        assert!(
            !chunks.is_empty(),
            "no chunks returned for late region [900000, 1000000]"
        );

        let max_chunk_end_block = chunks
            .iter()
            .map(|c| u64::from(c.end()) >> 16)
            .max()
            .unwrap_or(0);
        assert!(
            max_chunk_end_block > 0,
            "all chunk ends in first BGZF block; virtual_position broken across block flush"
        );
    }

    #[test]
    fn out_dir_does_not_need_to_pre_exist() {
        let parent = std::env::temp_dir().join(format!("dna-indexer-mkdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&parent);
        let out_dir = parent.join("nested").join("deep");
        let rec = simple_record();
        write_bundle(&rec, &out_dir, "test", "0.0.0").expect("creates out-dir");
        assert!(out_dir.exists());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn bundle_regeneration_produces_byte_identical_outputs() {
        let dir_a = tmpdir("regen_a");
        let dir_b = tmpdir("regen_b");
        let rec = simple_record();
        write_bundle(&rec, &dir_a, "test", "0.1.0").unwrap();
        write_bundle(&rec, &dir_b, "test", "0.1.0").unwrap();

        for fname in ["test.fa.gz", "test.fa.gz.fai", "test.fa.gz.gzi"] {
            let a = fs::read(dir_a.join(fname)).unwrap();
            let b = fs::read(dir_b.join(fname)).unwrap();
            assert_eq!(a, b, "{} differs across re-runs", fname);
        }

        let read_decompressed = |dir: &Path| -> String {
            let f = File::open(dir.join("test.gff3.gz")).unwrap();
            let mut r = bgzf::Reader::new(f);
            let mut s = String::new();
            r.read_to_string(&mut s).unwrap();
            s
        };
        assert_eq!(
            read_decompressed(&dir_a),
            read_decompressed(&dir_b),
            "decompressed GFF3 differs across re-runs"
        );
    }

    #[test]
    fn long_reference_writes_csi_and_answers_queries_past_tbi_limit() {
        use noodles_core::{region::Interval, Position};
        use noodles_csi::BinningIndex;

        let out_dir = tmpdir("csi_long_ref");
        fs::create_dir_all(&out_dir).unwrap();
        let gz_path = out_dir.join("chr1.gff3.gz");
        let csi_path = out_dir.join("chr1.gff3.gz.csi");
        let start = TBI_MAX_REFERENCE_LENGTH + 1;
        let end = start + 50;
        let gff3 = format!("##gff-version 3\nchr1\tsrc\tgene\t{start}\t{end}\t.\t+\t.\tID=g1\n");
        write_bgzf_and_csi(&gff3, &gz_path, &csi_path).expect("write csi");
        assert!(csi_path.is_file());
        assert!(!out_dir.join("chr1.gff3.gz.tbi").exists());

        let index = csi::fs::read(&csi_path).expect("read csi");
        assert_eq!(index.min_shift(), CSI_MIN_SHIFT);
        assert_eq!(index.depth(), CSI_DEPTH);
        let header = index.header().expect("csi has GFF header");
        let ref_id = header
            .reference_sequence_names()
            .iter()
            .position(|name| name.as_slice() == b"chr1")
            .expect("chr1 indexed");
        let interval = Interval::from(
            Position::try_from(start as usize).unwrap()..=Position::try_from(end as usize).unwrap(),
        );
        assert!(
            !index.query(ref_id, interval).unwrap().is_empty(),
            "csi query {start}..{end} returned no chunks"
        );
    }

    #[test]
    fn compress_plain_fasta_preserves_bytes_and_fai() {
        let out_dir = tmpdir("compress_plain_fasta");
        fs::create_dir_all(&out_dir).unwrap();
        let fasta = out_dir.join("chrTest.fa");
        let fai = out_dir.join("chrTest.fa.fai");
        let body = b">chrTest\nACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT\nACGT\n";
        fs::write(&fasta, body).unwrap();
        fs::write(&fai, "chrTest\t84\t9\t80\t81\n").unwrap();

        let outcome = compress_plain_fasta_file(&fasta).expect("compress");
        assert_eq!(read_bgzf_to_string(&outcome.fa_path).as_bytes(), body);
        assert_eq!(
            fs::read(&outcome.fai_path).unwrap(),
            fs::read(&fai).unwrap()
        );
        assert!(outcome.gzi_path.is_file());
        assert_eq!(fs::read(&fasta).unwrap(), body, "source FASTA must remain");
        assert!(fai.is_file(), "source FAI must remain");
    }

    #[test]
    fn compress_plain_fasta_refuses_empty_or_missing_fai() {
        let out_dir = tmpdir("compress_plain_fasta_refuse");
        fs::create_dir_all(&out_dir).unwrap();
        let empty = out_dir.join("empty.fa");
        fs::write(&empty, []).unwrap();
        let empty_error = compress_plain_fasta_file(&empty).unwrap_err();
        assert!(
            empty_error.to_string().contains("missing or empty"),
            "{empty_error}"
        );

        let fasta = out_dir.join("chrTest.fa");
        fs::write(&fasta, b">chrTest\nACGT\n").unwrap();
        let missing_fai = compress_plain_fasta_file(&fasta).unwrap_err();
        assert!(
            missing_fai.to_string().contains("sibling FASTA index"),
            "{missing_fai}"
        );

        let gz = out_dir.join("chrTest.fa.gz");
        fs::write(&gz, b"not-a-plain-fasta").unwrap();
        let gz_error = compress_plain_fasta_file(&gz).unwrap_err();
        assert!(gz_error.to_string().contains("uncompressed"), "{gz_error}");
    }

    #[test]
    fn compress_plain_fasta_replays_puc19_fixture_and_overwrites_dest() {
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/indexed/pUC19");
        let out_dir = tmpdir("compress_puc19_replay");
        fs::create_dir_all(&out_dir).unwrap();
        let fasta = out_dir.join("pUC19.fa");
        let fai = out_dir.join("pUC19.fa.fai");
        fs::copy(fixture.join("pUC19.fa"), &fasta).unwrap();
        fs::copy(fixture.join("pUC19.fa.fai"), &fai).unwrap();
        let original = fs::read(&fasta).unwrap();
        let original_fai = fs::read(&fai).unwrap();

        let first = compress_plain_fasta_file(&fasta).expect("first compress");
        assert_eq!(
            read_bgzf_to_string(&first.fa_path).as_bytes(),
            original.as_slice()
        );
        assert_eq!(fs::read(&first.fai_path).unwrap(), original_fai);

        let second = compress_plain_fasta_file(&fasta).expect("overwrite dest");
        assert_eq!(
            read_bgzf_to_string(&second.fa_path).as_bytes(),
            original.as_slice()
        );
        assert_eq!(fs::read(&second.fai_path).unwrap(), original_fai);
        assert_eq!(fs::read(&fasta).unwrap(), original);
    }

    #[test]
    fn compress_plain_fasta_reads_readonly_source() {
        let out_dir = tmpdir("compress_readonly");
        fs::create_dir_all(&out_dir).unwrap();
        let fasta = out_dir.join("chrTest.fa");
        let fai = out_dir.join("chrTest.fa.fai");
        let body = b">chrTest\nACGTACGT\n";
        fs::write(&fasta, body).unwrap();
        fs::write(&fai, "chrTest\t8\t9\t8\t9\n").unwrap();
        let mut permissions = fs::metadata(&fasta).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&fasta, permissions.clone()).unwrap();
        fs::set_permissions(&fai, permissions).unwrap();
        let outcome = compress_plain_fasta_file(&fasta).expect("readonly source");
        assert_eq!(read_bgzf_to_string(&outcome.fa_path).as_bytes(), body);
    }
}
