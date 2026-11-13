
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::mpsc;
use std::thread;

use anyhow::{Context, Result};
use flate2::read::MultiGzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};

const MAX_SOURCE_ID_CHARACTERS: usize = 2_048;
const MAX_METADATA_LINE_BYTES: usize = 16 * 1024 * 1024;
const BLOCK_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InspectedContig {
    pub source_seq_id: String,
    pub length_bp: u64,
    pub normalized_sequence_sha256: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum FastaInspection {
    #[serde(rename_all = "camelCase")]
    Inspected {
        sha256: String,
        gzip_compressed: bool,
        contigs: Vec<InspectedContig>,
    },
    Fallback { reason: String },
}

struct Fallback(&'static str);

#[derive(PartialEq)]
enum LineKind {
    None,
    Header,
    Sequence,
}

enum HashMessage {
    Data(Vec<u8>),
    Finish { id: String, length: u64 },
}

struct Parser {
    at_line_start: bool,
    kind: LineKind,
    header: Vec<u8>,
    current: Option<(String, u64)>,
    seen: HashSet<String>,
    records: usize,
    scratch: Vec<u8>,
    hash: mpsc::SyncSender<HashMessage>,
}

const DROP: u8 = 0;
const MARKER: u8 = 1;
const SEQUENCE_BYTE: [u8; 256] = {
    let mut table = [0u8; 256];
    let mut byte = 0;
    while byte < 256 {
        let value = byte as u8;
        table[byte] = match value {
            b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ' => DROP,
            b'>' | 0x00 | 0x01 => MARKER,
            _ => value.to_ascii_uppercase(),
        };
        byte += 1;
    }
    table
};

fn is_ascii_space(byte: u8) -> bool {
    matches!(byte, b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ')
}

impl Parser {
    fn new(hash: mpsc::SyncSender<HashMessage>) -> Self {
        Self {
            at_line_start: true,
            kind: LineKind::None,
            header: Vec::new(),
            current: None,
            seen: HashSet::new(),
            records: 0,
            scratch: Vec::with_capacity(BLOCK_BYTES),
            hash,
        }
    }

    fn send(&self, message: HashMessage) -> Result<(), Fallback> {
        self.hash.send(message).map_err(|_| Fallback("hash-thread-stopped"))
    }

    fn push(&mut self, block: &[u8]) -> Result<(), Fallback> {
        if !block.is_ascii() {
            return Err(Fallback("non-ascii"));
        }
        self.scratch.clear();
        for &byte in block {
            if byte == b'\n' {
                if self.kind == LineKind::Header {
                    self.finish_header()?;
                }
                self.kind = LineKind::None;
                self.at_line_start = true;
                continue;
            }
            if self.at_line_start {
                self.at_line_start = false;
                if byte == b'>' {
                    self.flush_sequence()?;
                    self.finish_contig()?;
                    self.kind = LineKind::Header;
                    continue;
                }
                self.kind = LineKind::Sequence;
            }
            if self.kind == LineKind::Header {
                if byte != b'\r' {
                    self.header.push(byte);
                    if self.header.len() > MAX_METADATA_LINE_BYTES {
                        return Err(Fallback("oversized-header"));
                    }
                }
                continue;
            }
            match SEQUENCE_BYTE[byte as usize] {
                DROP => {}
                MARKER => return Err(Fallback("header-marker-or-control-byte")),
                normalized => self.scratch.push(normalized),
            }
        }
        self.flush_sequence()
    }

    fn flush_sequence(&mut self) -> Result<(), Fallback> {
        if self.scratch.is_empty() {
            return Ok(());
        }
        let Some((_, length)) = self.current.as_mut() else {
            return Err(Fallback("sequence-before-header"));
        };
        *length += self.scratch.len() as u64;
        let data = std::mem::replace(&mut self.scratch, Vec::with_capacity(BLOCK_BYTES));
        self.send(HashMessage::Data(data))
    }

    fn finish_header(&mut self) -> Result<(), Fallback> {
        let header = std::mem::take(&mut self.header);
        if header.first().is_none_or(|&byte| is_ascii_space(byte)) {
            return Err(Fallback("empty-sequence-id"));
        }
        let id_end = header
            .iter()
            .position(|&byte| is_ascii_space(byte))
            .unwrap_or(header.len());
        let id = String::from_utf8(header[..id_end].to_vec()).map_err(|_| Fallback("non-ascii"))?;
        if id.len() > MAX_SOURCE_ID_CHARACTERS {
            return Err(Fallback("oversized-sequence-id"));
        }
        if !self.seen.insert(id.clone()) {
            return Err(Fallback("duplicate-sequence-id"));
        }
        self.current = Some((id, 0));
        Ok(())
    }

    fn finish_contig(&mut self) -> Result<(), Fallback> {
        let Some((id, length)) = self.current.take() else {
            return Ok(());
        };
        if length == 0 {
            return Err(Fallback("empty-record"));
        }
        self.records += 1;
        self.send(HashMessage::Finish { id, length })
    }

    fn finish(mut self) -> Result<(), Fallback> {
        if self.kind == LineKind::Header {
            self.finish_header()?;
        }
        self.finish_contig()?;
        if self.records == 0 {
            return Err(Fallback("no-records"));
        }
        Ok(())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

struct HashingReader<R> {
    inner: R,
    hasher: Sha256,
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.hasher.update(&buf[..read]);
        Ok(read)
    }
}

pub fn inspect_fasta(path: &Path) -> Result<FastaInspection> {
    let mut magic = [0u8; 2];
    let gzip_compressed = {
        let mut file = File::open(path).with_context(|| format!("while opening {}", path.display()))?;
        file.read(&mut magic)? == 2 && magic == [0x1f, 0x8b]
    };
    let file = File::open(path).with_context(|| format!("while opening {}", path.display()))?;
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(4);
    let reader = thread::spawn(move || -> Result<String> {
        let mut raw = HashingReader {
            inner: BufReader::with_capacity(BLOCK_BYTES, file),
            hasher: Sha256::new(),
        };
        {
            let mut decoded: Box<dyn Read> = if gzip_compressed {
                Box::new(MultiGzDecoder::new(&mut raw))
            } else {
                Box::new(&mut raw)
            };
            loop {
                let mut block = vec![0u8; BLOCK_BYTES];
                let mut filled = 0;
                while filled < block.len() {
                    let read = decoded.read(&mut block[filled..])?;
                    if read == 0 {
                        break;
                    }
                    filled += read;
                }
                if filled == 0 {
                    break;
                }
                block.truncate(filled);
                if sender.send(block).is_err() {
                    return Ok(String::new());
                }
            }
        }
        std::io::copy(&mut raw, &mut std::io::sink())?;
        Ok(hex(&raw.hasher.finalize()))
    });

    let (hash_sender, hash_receiver) = mpsc::sync_channel::<HashMessage>(4);
    let hasher = thread::spawn(move || {
        let mut contigs = Vec::new();
        let mut digest = Sha256::new();
        for message in hash_receiver {
            match message {
                HashMessage::Data(data) => digest.update(&data),
                HashMessage::Finish { id, length } => contigs.push(InspectedContig {
                    source_seq_id: id,
                    length_bp: length,
                    normalized_sequence_sha256: hex(&std::mem::take(&mut digest).finalize()),
                }),
            }
        }
        contigs
    });
    let mut parser = Parser::new(hash_sender);
    let mut fallback = None;
    let mut waiting = std::time::Duration::ZERO;
    let mut parsing = std::time::Duration::ZERO;
    loop {
        let started = std::time::Instant::now();
        let Ok(block) = receiver.recv() else { break };
        let received = std::time::Instant::now();
        waiting += received - started;
        let pushed = parser.push(&block);
        parsing += received.elapsed();
        if let Err(Fallback(reason)) = pushed {
            fallback = Some(reason);
            break;
        }
    }
    if std::env::var_os("DNA_INDEXER_TIMINGS").is_some() {
        eprintln!("inspect-fasta waiting={waiting:?} parsing={parsing:?}");
    }
    drop(receiver);
    let sha256 = reader
        .join()
        .map_err(|_| anyhow::anyhow!("FASTA reader thread panicked"))??;
    let finished = match fallback {
        Some(reason) => {
            drop(parser);
            Err(Fallback(reason))
        }
        None => parser.finish(),
    };
    let contigs = hasher
        .join()
        .map_err(|_| anyhow::anyhow!("FASTA hash thread panicked"))?;
    match finished {
        Ok(()) => Ok(FastaInspection::Inspected {
            sha256,
            gzip_compressed,
            contigs,
        }),
        Err(Fallback(reason)) => Ok(FastaInspection::Fallback { reason: reason.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn inspect_bytes(bytes: &[u8], gzip: bool) -> FastaInspection {
        let dir = std::env::temp_dir().join(format!(
            "dna-indexer-inspect-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("input.fa");
        let mut file = File::create(&path).unwrap();
        if gzip {
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(bytes).unwrap();
            file.write_all(&encoder.finish().unwrap()).unwrap();
        } else {
            file.write_all(bytes).unwrap();
        }
        drop(file);
        let inspected = inspect_fasta(&path).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        inspected
    }

    fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    #[test]
    fn normalizes_whitespace_and_case_like_the_desktop_planner() {
        let input = b">chr1 description\r\nacg t\r\nNNN\n\n>chr2\tx\nA C\x0bg\x0c\n";
        for gzip in [false, true] {
            let FastaInspection::Inspected { contigs, gzip_compressed, .. } =
                inspect_bytes(input, gzip)
            else {
                panic!("expected an inspected FASTA");
            };
            assert_eq!(gzip_compressed, gzip);
            assert_eq!(
                contigs,
                vec![
                    InspectedContig {
                        source_seq_id: "chr1".into(),
                        length_bp: 7,
                        normalized_sequence_sha256: sha(b"ACGTNNN"),
                    },
                    InspectedContig {
                        source_seq_id: "chr2".into(),
                        length_bp: 3,
                        normalized_sequence_sha256: sha(b"ACG"),
                    },
                ]
            );
        }
    }

    #[test]
    fn hands_unusual_files_back_to_the_planner() {
        for input in [
            &b">chr1\nAC\xc3\xa9\n"[..],
            b"ACGT\n>chr1\nACGT\n",
            b">chr1\nAC>GT\n",
            b">chr1\nACGT\n>chr1\nACGT\n",
            b">chr1\n>chr2\nACGT\n",
            b"> chr1\nACGT\n",
            b">chr1\nAC\x00GT\n",
            b"",
        ] {
            assert!(
                matches!(inspect_bytes(input, false), FastaInspection::Fallback { .. }),
                "expected fallback for {input:?}"
            );
        }
    }
}
