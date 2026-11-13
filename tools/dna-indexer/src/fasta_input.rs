
use anyhow::{anyhow, Result};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use crate::error::IndexerError;

fn open_maybe_gzip(path: &Path) -> Result<Box<dyn BufRead>> {
    let file = File::open(path)
        .map_err(|e| IndexerError::GenbankParseFailed(format!("{}: {}", path.display(), e)))?;
    let mut buf = BufReader::with_capacity(1 << 20, file);
    let peek = buf.fill_buf().unwrap_or(&[]);
    if peek.len() >= 2 && peek[0] == 0x1f && peek[1] == 0x8b {
        Ok(Box::new(BufReader::with_capacity(
            1 << 20,
            flate2::read::MultiGzDecoder::new(buf),
        )))
    } else {
        Ok(Box::new(buf))
    }
}

pub fn looks_like_fasta(path: &Path) -> Result<bool> {
    let mut reader = open_maybe_gzip(path)?;
    let mut byte = [0u8; 1];
    loop {
        if reader.read(&mut byte)? == 0 {
            return Ok(false);
        }
        if !byte[0].is_ascii_whitespace() {
            return Ok(byte[0] == b'>');
        }
    }
}

pub fn read_single_fasta(path: &Path) -> Result<(String, Vec<u8>)> {
    let mut reader = open_maybe_gzip(path)?;
    let mut bases = Vec::new();
    let mut record_id: Option<String> = None;
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        if line.first() == Some(&b'>') {
            let id = fasta_header_id(&String::from_utf8_lossy(&line))?;
            if let Some(first) = &record_id {
                return Err(anyhow!(
                    "{}: FASTA contains multiple records ({first}, {id}); multi-record FASTA is not supported, exactly one sequence is required",
                    path.display()
                ));
            }
            record_id = Some(id);
            continue;
        }
        if record_id.is_none() {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            return Err(anyhow!(
                "{}: FASTA sequence appears before its header",
                path.display()
            ));
        }
        bases.extend(
            line.iter()
                .filter(|b| !b.is_ascii_whitespace())
                .map(u8::to_ascii_lowercase),
        );
    }
    let id = record_id.ok_or_else(|| anyhow!("{}: FASTA contains no record", path.display()))?;
    Ok((id, bases))
}

pub(crate) fn fasta_header_id(line: &str) -> Result<String> {
    let id = line
        .strip_prefix('>')
        .and_then(|header| header.split_ascii_whitespace().next())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("FASTA header has no sequence ID"))?;
    Ok(id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "dna-indexer-fasta-input-{}-{}",
            name,
            std::process::id()
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn reads_one_record_and_lowercases() {
        let path = write_temp("one", b"\n>NC_1 Homo sapiens\nACgt\r\nNN\n");
        assert!(looks_like_fasta(&path).unwrap());
        let (id, seq) = read_single_fasta(&path).unwrap();
        assert_eq!(id, "NC_1");
        assert_eq!(seq, b"acgtnn");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn reads_gzip_input() {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(b">chr1\nACGT\n").unwrap();
        let path = write_temp("gz", &enc.finish().unwrap());
        assert!(looks_like_fasta(&path).unwrap());
        assert_eq!(read_single_fasta(&path).unwrap().1, b"acgt");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn rejects_second_record() {
        let path = write_temp("two", b">a\nACGT\n>b\nACGT\n");
        let err = read_single_fasta(&path).unwrap_err().to_string();
        assert!(err.contains("FASTA contains multiple records"));
        assert!(err.contains("multi-record"));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn genbank_is_not_fasta() {
        let path = write_temp("gb", b"LOCUS       X 4 bp DNA linear\n//\n");
        assert!(!looks_like_fasta(&path).unwrap());
        std::fs::remove_file(path).ok();
    }
}
