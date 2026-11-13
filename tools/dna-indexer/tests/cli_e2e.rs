
use flate2::read::MultiGzDecoder;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn fixture(rel: &str) -> PathBuf {
    workspace_root().join(rel)
}

fn unique_tmpdir(test: &str) -> PathBuf {
    let mut d = std::env::temp_dir();
    d.push(format!("dna-indexer-cli-{}-{}", test, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn read_gff3(path: &Path) -> String {
    let file = std::fs::File::open(path).expect("open emitted GFF3");
    let mut decoder = MultiGzDecoder::new(file);
    let mut contents = String::new();
    decoder
        .read_to_string(&mut contents)
        .expect("decompress emitted GFF3");
    contents
}

#[test]
fn version_reports_schema_one() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let output = Command::new(exe).arg("--version").output().expect("spawn");
    assert!(
        output.status.success(),
        "non-zero exit: {:?}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.contains("schema 2"),
        "expected `schema 2` suffix; got: {}",
        stdout.trim()
    );
}

#[test]
fn reference_asset_lock_excludes_writers_commits_pointer_and_recovers_after_exit() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let root = unique_tmpdir("reference_asset_lock");
    std::fs::create_dir_all(&root).unwrap();
    let lock_path = root.join("writer.lock");
    let pointer_path = root.join("current-reference-assets.v1.json");
    let temporary_path = root.join("current-reference-assets.v1.json.test.tmp");

    let mut owner = Command::new(exe)
        .arg("reference-asset-lock")
        .arg("--lock-path")
        .arg(&lock_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn lock owner");
    let mut owner_stdout = BufReader::new(owner.stdout.take().expect("owner stdout"));
    let mut event = String::new();
    owner_stdout.read_line(&mut event).expect("locked event");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(event.trim()).unwrap()["event"],
        "locked"
    );

    let contender = Command::new(exe)
        .arg("reference-asset-lock")
        .arg("--lock-path")
        .arg(&lock_path)
        .output()
        .expect("spawn lock contender");
    assert_eq!(contender.status.code(), Some(3));
    let contender_event: serde_json::Value =
        serde_json::from_slice(&contender.stdout).expect("busy event");
    assert_eq!(contender_event["event"], "busy");

    std::fs::write(&temporary_path, b"{\"publicationId\":\"test\"}\n").unwrap();
    writeln!(
        owner.stdin.as_mut().expect("owner stdin"),
        "{}",
        serde_json::json!({
            "command": "commit-pointer",
            "temporary_path": temporary_path,
            "pointer_path": pointer_path,
        })
    )
    .expect("send commit");
    event.clear();
    owner_stdout.read_line(&mut event).expect("committed event");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(event.trim()).unwrap()["event"],
        "committed"
    );
    assert_eq!(
        std::fs::read_to_string(&pointer_path).unwrap(),
        "{\"publicationId\":\"test\"}\n"
    );

    std::fs::write(
        &temporary_path,
        b"{\"publicationId\":\"test\",\"products\":true}\n",
    )
    .unwrap();
    writeln!(
        owner.stdin.as_mut().expect("owner stdin"),
        "{}",
        serde_json::json!({
            "command": "commit-pointer",
            "temporary_path": temporary_path,
            "pointer_path": pointer_path,
        })
    )
    .expect("send product commit");
    event.clear();
    owner_stdout
        .read_line(&mut event)
        .expect("product committed event");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(event.trim()).unwrap()["event"],
        "committed"
    );
    assert_eq!(
        std::fs::read_to_string(&pointer_path).unwrap(),
        "{\"publicationId\":\"test\",\"products\":true}\n"
    );

    writeln!(
        owner.stdin.as_mut().expect("owner stdin"),
        "{}",
        serde_json::json!({ "command": "release" })
    )
    .expect("send release");
    event.clear();
    owner_stdout.read_line(&mut event).expect("released event");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(event.trim()).unwrap()["event"],
        "released"
    );
    assert!(owner.wait().expect("owner exit").success());

    let after_release = Command::new(exe)
        .arg("reference-asset-lock")
        .arg("--lock-path")
        .arg(&lock_path)
        .output()
        .expect("spawn after release");
    assert!(after_release.status.success());
    let after_release_event: serde_json::Value =
        serde_json::from_slice(&after_release.stdout).expect("locked after release");
    assert_eq!(after_release_event["event"], "locked");

    let mut crashed = Command::new(exe)
        .arg("reference-asset-lock")
        .arg("--lock-path")
        .arg(&lock_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn crash owner");
    let mut crashed_stdout = BufReader::new(crashed.stdout.take().expect("crash owner stdout"));
    event.clear();
    crashed_stdout
        .read_line(&mut event)
        .expect("crash owner locked event");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(event.trim()).unwrap()["event"],
        "locked"
    );
    crashed.kill().expect("kill lock owner");
    crashed.wait().expect("reap lock owner");

    let after_crash = Command::new(exe)
        .arg("reference-asset-lock")
        .arg("--lock-path")
        .arg(&lock_path)
        .output()
        .expect("spawn after crash");
    assert!(after_crash.status.success());
    let after_crash_event: serde_json::Value =
        serde_json::from_slice(&after_crash.stdout).expect("locked after crash");
    assert_eq!(after_crash_event["event"], "locked");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn compress_fasta_preserves_source_and_emits_bgzf_bundle() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let out_dir = unique_tmpdir("compress_fasta");
    std::fs::create_dir_all(&out_dir).unwrap();
    let fasta = out_dir.join("chrTest.fa");
    let fai = out_dir.join("chrTest.fa.fai");
    let body = b">chrTest\nACGTACGT\n";
    std::fs::write(&fasta, body).unwrap();
    std::fs::write(&fai, "chrTest\t8\t9\t8\t9\n").unwrap();

    let output = Command::new(exe)
        .arg("compress-fasta")
        .arg("--in")
        .arg(&fasta)
        .output()
        .expect("spawn dna-indexer compress-fasta");
    assert!(
        output.status.success(),
        "non-zero exit. stderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let gz = out_dir.join("chrTest.fa.gz");
    let gz_fai = out_dir.join("chrTest.fa.gz.fai");
    let gzi = out_dir.join("chrTest.fa.gz.gzi");
    assert!(gz.is_file());
    assert_eq!(
        std::fs::read(&gz_fai).unwrap(),
        std::fs::read(&fai).unwrap()
    );
    assert!(gzi.is_file());
    assert_eq!(std::fs::read(&fasta).unwrap(), body);

    let stdout = String::from_utf8(output.stdout).unwrap();
    let last_line = stdout.lines().last().expect("terminal status");
    let parsed: serde_json::Value = serde_json::from_str(last_line).expect("terminal JSON");
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["paths"]["fa"], gz.to_string_lossy().as_ref());

    let _ = std::fs::remove_dir_all(out_dir);
}

#[test]
fn index_puc19_e2e_produces_quartet_and_terminal_status() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let input = fixture("test-fixtures/sequences/circular/pUC19.gb");
    let out_dir = unique_tmpdir("index_puc19");

    let output = Command::new(exe)
        .arg("index")
        .arg("--in")
        .arg(&input)
        .arg("--out-dir")
        .arg(&out_dir)
        .arg("--name")
        .arg("puc19")
        .output()
        .expect("spawn dna-indexer");

    assert!(
        output.status.success(),
        "non-zero exit. stderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    for fname in [
        "puc19.fa.gz",
        "puc19.fa.gz.fai",
        "puc19.fa.gz.gzi",
        "puc19.gff3.gz",
        "puc19.gff3.gz.tbi",
    ] {
        let p = out_dir.join(fname);
        assert!(p.exists(), "missing output file: {}", p.display());
        assert!(
            p.metadata().unwrap().len() > 0,
            "empty file: {}",
            p.display()
        );
    }

    let stdout = String::from_utf8(output.stdout).unwrap();
    let last_line = stdout.lines().last().expect("at least one stdout line");
    let parsed: serde_json::Value = serde_json::from_str(last_line).expect("terminal line is JSON");
    assert_eq!(parsed["ok"], serde_json::Value::Bool(true));
    assert_eq!(parsed["length"], serde_json::Value::from(2686u64));
    assert_eq!(
        parsed["topology"],
        serde_json::Value::String("circular".into())
    );
    assert!(parsed["paths"]["gff3_gz"].is_string());
}

#[test]
fn index_emits_progress_ndjson_events_before_terminal() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let input = fixture("test-fixtures/sequences/circular/pUC19.gb");
    let out_dir = unique_tmpdir("index_progress");

    let output = Command::new(exe)
        .arg("index")
        .arg("--in")
        .arg(&input)
        .arg("--out-dir")
        .arg(&out_dir)
        .arg("--name")
        .arg("puc19")
        .output()
        .expect("spawn");
    assert!(output.status.success(), "non-zero exit");

    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    assert!(
        lines.len() >= 2,
        "expected progress + terminal line, got: {:?}",
        lines
    );

    let mut stages = Vec::new();
    for line in &lines[..lines.len() - 1] {
        let v: serde_json::Value = serde_json::from_str(line).expect("progress line is JSON");
        assert!(
            v["progress"].is_number(),
            "progress field missing on: {}",
            line
        );
        let stage = v["stage"].as_str().expect("stage is a string");
        stages.push(stage.to_string());
        assert!(v["feature_count"].is_number());
    }

    assert!(stages.contains(&"parsing".to_string()));
    assert!(stages.contains(&"gff_emit".to_string()));
    assert!(stages.contains(&"writing".to_string()));
    assert!(stages.contains(&"done".to_string()));
}

fn run_index_cli(input: &Path, out_dir: &Path, name: &str) -> (bool, serde_json::Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_dna-indexer"))
        .arg("index")
        .arg("--in")
        .arg(input)
        .arg("--out-dir")
        .arg(out_dir)
        .arg("--name")
        .arg(name)
        .output()
        .expect("spawn dna-indexer");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let last = stdout.lines().last().expect("terminal status on stdout");
    (
        output.status.success(),
        serde_json::from_str(last).expect("terminal is JSON"),
    )
}

#[test]
fn index_fasta_renames_record_and_writes_sequence_triple_only() {
    let dir = unique_tmpdir("index_fasta");
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("source.fa");
    std::fs::write(
        &input,
        ">NC_000022.11 Homo sapiens chromosome 22\nACGTACGTAC\nGGTT\n",
    )
    .unwrap();
    let out_dir = dir.join("out");

    let (ok, status) = run_index_cli(&input, &out_dir, "chr22");
    assert!(ok, "FASTA index failed: {status}");
    assert_eq!(status["length"], serde_json::Value::from(14u64));
    assert_eq!(status["feature_count"], serde_json::Value::from(0u64));
    assert_eq!(
        status["topology"],
        serde_json::Value::String("linear".into())
    );
    assert!(status["paths"]["gff3_gz"].is_null());

    let fai = std::fs::read_to_string(out_dir.join("chr22.fa.gz.fai")).unwrap();
    assert!(fai.starts_with("chr22\t14\t"), "fai: {fai}");
    assert!(out_dir.join("chr22.fa.gz.gzi").exists());
    assert!(!out_dir.join("chr22.gff3.gz").exists());

    let mut fasta = String::new();
    MultiGzDecoder::new(std::fs::File::open(out_dir.join("chr22.fa.gz")).unwrap())
        .read_to_string(&mut fasta)
        .unwrap();
    assert_eq!(fasta, ">chr22\nacgtacgtacggtt\n");
}

#[test]
fn index_rejects_multi_record_inputs() {
    let dir = unique_tmpdir("index_multi");
    std::fs::create_dir_all(&dir).unwrap();

    let fasta = dir.join("two.fa");
    std::fs::write(&fasta, ">a\nACGT\n>b\nACGT\n").unwrap();
    let (ok, status) = run_index_cli(&fasta, &dir.join("out-fa"), "x");
    assert!(!ok);
    assert_eq!(status["code"], "UNSUPPORTED_INPUT_FORMAT");
    assert!(status["message"].as_str().unwrap().contains("multi-record"));

    let one =
        std::fs::read_to_string(fixture("test-fixtures/sequences/circular/pUC19.gb")).unwrap();
    let genbank = dir.join("two.gb");
    std::fs::write(&genbank, format!("{one}{one}")).unwrap();
    let (ok, status) = run_index_cli(&genbank, &dir.join("out-gb"), "x");
    assert!(!ok);
    assert_eq!(status["code"], "UNSUPPORTED_INPUT_FORMAT");
    assert!(status["message"].as_str().unwrap().contains("multi-record"));
    assert!(!dir.join("out-gb").join("x.fa.gz").exists());
}

#[test]
fn index_missing_input_returns_structured_error_on_stderr() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let out_dir = unique_tmpdir("index_missing");

    let output = Command::new(exe)
        .arg("index")
        .arg("--in")
        .arg("/nonexistent/path/to/file.gb")
        .arg("--out-dir")
        .arg(&out_dir)
        .arg("--name")
        .arg("x")
        .output()
        .expect("spawn");
    assert!(!output.status.success(), "should fail on missing input");

    let stderr = String::from_utf8(output.stderr).unwrap();
    let err_line = stderr
        .lines()
        .find(|l| l.contains("GENBANK_PARSE_FAILED"))
        .expect("stderr should contain GENBANK_PARSE_FAILED line");
    let v: serde_json::Value = serde_json::from_str(err_line).expect("err line is JSON");
    assert_eq!(v["level"], serde_json::Value::String("error".into()));
    assert_eq!(
        v["code"],
        serde_json::Value::String("GENBANK_PARSE_FAILED".into())
    );

    let stdout = String::from_utf8(output.stdout).unwrap();
    let last = stdout.lines().last().expect("terminal status on stdout");
    let v: serde_json::Value = serde_json::from_str(last).expect("terminal is JSON");
    assert_eq!(v["ok"], serde_json::Value::Bool(false));
    assert_eq!(
        v["code"],
        serde_json::Value::String("GENBANK_PARSE_FAILED".into())
    );
}

#[test]
fn index_idempotent_rerun_overwrites_cleanly() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let input = fixture("test-fixtures/sequences/circular/pUC19.gb");
    let out_dir = unique_tmpdir("index_idempotent");

    for run in 0..2 {
        let output = Command::new(exe)
            .arg("index")
            .arg("--in")
            .arg(&input)
            .arg("--out-dir")
            .arg(&out_dir)
            .arg("--name")
            .arg("puc19")
            .output()
            .expect("spawn");
        assert!(
            output.status.success(),
            "run {} failed: stderr:\n{}",
            run,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    for entry in std::fs::read_dir(&out_dir).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        assert!(!name.ends_with(".tmp"), "leaked .tmp: {}", name);
    }
}

#[test]
fn ingest_gff3_repeated_builds_are_deterministic() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let root = unique_tmpdir("ingest_gff3_determinism");
    std::fs::create_dir_all(&root).unwrap();
    let input_gff3 = root.join("input.gff3");
    let input_fasta = root.join("input.fa");
    std::fs::write(
        &input_gff3,
        "##gff-version 3\n\
         chr1\ttest\tgene\t1\t12\t.\t+\t.\tID=gene-1;zeta=last;gene=det;Note=note;description=desc;Alias=alpha;biotype=protein_coding;Name=Det;Dbxref=GeneID:1\n",
    )
    .unwrap();
    std::fs::write(&input_fasta, ">chr1\nACGTACGTACGT\n").unwrap();

    let mut emitted = Vec::new();
    for run in 0..2 {
        let out_dir = root.join(format!("out-{run}"));
        let output = Command::new(exe)
            .arg("ingest-gff3")
            .arg("--in")
            .arg(&input_gff3)
            .arg("--in-fasta")
            .arg(&input_fasta)
            .arg("--out-dir")
            .arg(&out_dir)
            .arg("--name")
            .arg("chr1")
            .output()
            .expect("spawn dna-indexer ingest-gff3");
        assert!(
            output.status.success(),
            "run {run} failed: stderr:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        emitted.push(read_gff3(&out_dir.join("chr1.gff3.gz")));
    }

    assert_eq!(
        emitted[0], emitted[1],
        "real ingest-gff3 output differs across identical builds"
    );

    let attributes = emitted[0]
        .lines()
        .find(|line| !line.starts_with('#'))
        .and_then(|line| line.split('\t').nth(8))
        .expect("emitted feature attributes");
    let source_qualifiers: Vec<&str> = attributes
        .split(';')
        .filter(|attribute| !attribute.starts_with("ID=") && !attribute.starts_with("_lane="))
        .collect();
    assert_eq!(
        source_qualifiers,
        [
            "Alias=alpha",
            "Dbxref=GeneID:1",
            "Name=Det",
            "Note=note",
            "biotype=protein_coding",
            "description=desc",
            "gene=det",
            "zeta=last",
        ],
        "source qualifiers are not in canonical key order"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ingest_fasta_assembly_emits_only_real_sequence_pairs() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let root = unique_tmpdir("ingest_fasta_assembly");
    let out_dir = root.join("out");
    std::fs::create_dir_all(&root).unwrap();
    let input_fasta = root.join("assembly.fa");
    let contig_map = root.join("contig-map.json");
    std::fs::write(
        &input_fasta,
        ">source-A first contig\nACGTACGTACGT\n>source-B second contig\nAAACCCGGGTTTAAA\n",
    )
    .unwrap();
    std::fs::write(
        &contig_map,
        serde_json::to_vec_pretty(&serde_json::json!({
            "contract": "dna-indexer-ingest-gff3-assembly.v1",
            "contigs": [
                {
                    "sourceSeqId": "source-B",
                    "name": "chrB",
                    "expectedLengthBp": 15,
                    "circular": false
                },
                {
                    "sourceSeqId": "source-A",
                    "name": "chrA",
                    "expectedLengthBp": 12,
                    "circular": false
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let output = Command::new(exe)
        .arg("ingest-fasta-assembly")
        .arg("--in")
        .arg(&input_fasta)
        .arg("--contig-map")
        .arg(&contig_map)
        .arg("--out-dir")
        .arg(&out_dir)
        .output()
        .expect("spawn FASTA-only assembly ingestion");
    assert!(
        output.status.success(),
        "FASTA-only assembly ingestion failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let mut emitted_names = std::fs::read_dir(&out_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    emitted_names.sort();
    assert_eq!(
        emitted_names,
        vec![
            "chrA.fa.gz",
            "chrA.fa.gz.fai",
            "chrA.fa.gz.gzi",
            "chrB.fa.gz",
            "chrB.fa.gz.fai",
            "chrB.fa.gz.gzi",
        ],
        "sequence-only ingestion must never manufacture GFF3 or tabix files"
    );
    assert_eq!(
        read_gff3(&out_dir.join("chrA.fa.gz")),
        ">chrA\nacgtacgtacgt\n"
    );
    assert_eq!(
        read_gff3(&out_dir.join("chrB.fa.gz")),
        ">chrB\naaacccgggtttaaa\n"
    );
    assert_eq!(
        std::fs::read_to_string(out_dir.join("chrA.fa.gz.fai")).unwrap(),
        "chrA\t12\t6\t12\t13\n"
    );
    assert_eq!(
        std::fs::read_to_string(out_dir.join("chrB.fa.gz.fai")).unwrap(),
        "chrB\t15\t6\t15\t16\n"
    );

    let stdout = String::from_utf8(output.stdout).unwrap();
    let terminal: serde_json::Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(terminal["ok"], true);
    assert_eq!(terminal["length"], 27);
    assert_eq!(terminal["feature_count"], 0);
    assert_eq!(terminal["bundles"][0]["sourceSeqId"], "source-B");
    assert_eq!(terminal["bundles"][0]["name"], "chrB");
    assert_eq!(terminal["bundles"][0]["featureCount"], 0);
    assert!(terminal["bundles"][0]["paths"]["fa"].is_string());
    assert!(terminal["bundles"][0]["paths"]["fai"].is_string());
    assert!(
        terminal["bundles"][0]["paths"].get("gff3_gz").is_none(),
        "annotation path must be absent, not a fake empty path"
    );
    assert!(
        terminal["bundles"][0]["paths"].get("tbi").is_none(),
        "annotation index path must be absent, not a fake empty path"
    );
    assert_eq!(terminal["bundles"][1]["sourceSeqId"], "source-A");
    assert_eq!(terminal["bundles"][1]["name"], "chrA");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ingest_fasta_assembly_failure_removes_every_published_contig() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let root = unique_tmpdir("ingest_fasta_assembly_atomic_failure");
    let out_dir = root.join("out");
    std::fs::create_dir_all(&root).unwrap();
    let input_fasta = root.join("assembly.fa");
    let contig_map = root.join("contig-map.json");
    std::fs::write(
        &input_fasta,
        ">source-A\nACGTACGTACGT\n>source-B\nAAACCCGGGTTTAAA\n",
    )
    .unwrap();
    std::fs::write(
        &contig_map,
        serde_json::to_vec_pretty(&serde_json::json!({
            "contract": "dna-indexer-ingest-gff3-assembly.v1",
            "contigs": [
                {
                    "sourceSeqId": "source-A",
                    "name": "chrA",
                    "expectedLengthBp": 12,
                    "circular": false
                },
                {
                    "sourceSeqId": "source-B",
                    "name": "chrB",
                    "expectedLengthBp": 14,
                    "circular": false
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let output = Command::new(exe)
        .arg("ingest-fasta-assembly")
        .arg("--in")
        .arg(&input_fasta)
        .arg("--contig-map")
        .arg(&contig_map)
        .arg("--out-dir")
        .arg(&out_dir)
        .output()
        .expect("spawn failing FASTA-only assembly ingestion");
    assert!(
        !output.status.success(),
        "length mismatch unexpectedly passed"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("source-B FASTA length 15 does not match expectedLengthBp 14"),
        "unexpected diagnostic: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        out_dir.is_dir(),
        "the stable staging directory may remain after a failed build"
    );
    assert_eq!(
        std::fs::read_dir(&out_dir).unwrap().count(),
        0,
        "a late contig failure exposed a partial sequence assembly"
    );

    let stdout = String::from_utf8(output.stdout).unwrap();
    let terminal: serde_json::Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(terminal["ok"], false);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ingest_gff3_assembly_scopes_ids_by_source_and_preserves_cds_phase() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let root = unique_tmpdir("ingest_gff3_assembly");
    let out_dir = root.join("out");
    std::fs::create_dir_all(&root).unwrap();
    let input_gff3 = root.join("assembly.gff3");
    let input_fasta = root.join("assembly.fa");
    let contig_map = root.join("contig-map.json");
    std::fs::write(
        &input_gff3,
        "##gff-version 3\n\
         ##sequence-region source-A 1 12\n\
         source-A\ttest\tCDS\t1\t3\t.\t+\t0\tID=shared-cds;Parent=shared-tx\n\
         ##sequence-region source-B 1 15\n\
         source-B\ttest\tmRNA\t1\t15\t.\t+\t.\tID=shared-tx\n\
         source-A\ttest\tCDS\t7\t9\t.\t+\t2\tID=shared-cds;Parent=shared-tx\n\
         source-B\ttest\tCDS\t4\t9\t.\t+\t1\tID=shared-cds;Parent=shared-tx\n\
         source-B\ttest\tcDNA_match\t2\t4\t.\t+\t.\tID=stable-match;Target=query-2 1 3 +\n\
         source-B\ttest\tcDNA_match\t11\t13\t.\t+\t.\tID=stable-match;Target=query-2 1 3 +\n\
         source-A\ttest\tcDNA_match\t2\t4\t.\t+\t.\tID=shared-match;Target=query-1 1 3 +\n\
         source-A\ttest\tcDNA_match\t8\t10\t.\t+\t.\tID=shared-match;Target=query-1 4 6 +\n\
         source-A\ttest\tprotein_binding_site\t5\t5\t.\t+\t.\tID=shared-site;Note=segment-a\n\
         source-A\ttest\tprotein_binding_site\t11\t11\t.\t+\t.\tID=shared-site;Note=segment-b\n\
         source-A\ttest\tmRNA\t1\t12\t.\t+\t.\tID=shared-tx\n",
    )
    .unwrap();
    std::fs::write(
        &input_fasta,
        ">source-A\nACGTACGTACGT\n>source-B\nAAACCCGGGTTTAAA\n",
    )
    .unwrap();
    std::fs::write(
        &contig_map,
        serde_json::to_vec_pretty(&serde_json::json!({
            "contract": "dna-indexer-ingest-gff3-assembly.v1",
            "contigs": [
                {
                    "sourceSeqId": "source-B",
                    "name": "chrB",
                    "expectedLengthBp": 15,
                    "circular": false
                },
                {
                    "sourceSeqId": "source-A",
                    "name": "chrA",
                    "expectedLengthBp": 12,
                    "circular": false
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let output = Command::new(exe)
        .arg("ingest-gff3-assembly")
        .arg("--in")
        .arg(&input_gff3)
        .arg("--in-fasta")
        .arg(&input_fasta)
        .arg("--contig-map")
        .arg(&contig_map)
        .arg("--out-dir")
        .arg(&out_dir)
        .output()
        .expect("spawn assembly ingestion");
    assert!(
        output.status.success(),
        "assembly ingestion failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    for name in ["chrA", "chrB"] {
        for suffix in ["fa.gz", "fa.gz.fai", "fa.gz.gzi", "gff3.gz", "gff3.gz.tbi"] {
            assert!(
                out_dir.join(format!("{name}.{suffix}")).is_file(),
                "missing {name}.{suffix}"
            );
        }
    }
    assert_eq!(
        std::fs::read_to_string(out_dir.join("chrA.fa.gz.fai"))
            .unwrap()
            .split('\t')
            .take(2)
            .collect::<Vec<_>>(),
        vec!["chrA", "12"]
    );
    assert_eq!(
        std::fs::read_to_string(out_dir.join("chrB.fa.gz.fai"))
            .unwrap()
            .split('\t')
            .take(2)
            .collect::<Vec<_>>(),
        vec!["chrB", "15"]
    );
    let chr_a_gff3 = read_gff3(&out_dir.join("chrA.gff3.gz"));
    let chr_a_phases: Vec<&str> = chr_a_gff3
        .lines()
        .filter(|line| line.split('\t').nth(2) == Some("CDS"))
        .map(|line| line.split('\t').nth(7).unwrap())
        .collect();
    assert_eq!(chr_a_phases, vec!["0", "2"]);
    let chr_a_match_targets: Vec<&str> = chr_a_gff3
        .lines()
        .filter(|line| line.split('\t').nth(2) == Some("cDNA_match"))
        .map(|line| {
            line.split('\t')
                .nth(8)
                .unwrap()
                .split(';')
                .find(|attribute| attribute.starts_with("Target="))
                .unwrap()
        })
        .collect();
    assert_eq!(
        chr_a_match_targets,
        vec!["Target=query-1 1 3 +", "Target=query-1 4 6 +"]
    );
    let chr_b_gff3 = read_gff3(&out_dir.join("chrB.gff3.gz"));
    let chr_b_stable_match_rows: Vec<&str> = chr_b_gff3
        .lines()
        .filter(|line| line.split('\t').nth(2) == Some("cDNA_match"))
        .collect();
    assert_eq!(
        chr_b_stable_match_rows.len(),
        1,
        "schema-v2 inputs with identical interval attributes retain one bbox row"
    );
    let chr_b_stable_match_columns: Vec<&str> = chr_b_stable_match_rows[0].split('\t').collect();
    assert_eq!(chr_b_stable_match_columns[3], "2");
    assert_eq!(chr_b_stable_match_columns[4], "13");
    let chr_a_site_notes: Vec<&str> = chr_a_gff3
        .lines()
        .filter(|line| line.split('\t').nth(2) == Some("protein_binding_site"))
        .map(|line| {
            line.split('\t')
                .nth(8)
                .unwrap()
                .split(';')
                .find(|attribute| attribute.starts_with("Note="))
                .unwrap()
        })
        .collect();
    assert_eq!(chr_a_site_notes, vec!["Note=segment-a", "Note=segment-b"]);
    let stdout = String::from_utf8(output.stdout).unwrap();
    let terminal: serde_json::Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(terminal["ok"], true);
    assert_eq!(terminal["bundles"][0]["sourceSeqId"], "source-B");
    assert_eq!(terminal["bundles"][0]["name"], "chrB");
    assert_eq!(terminal["bundles"][0]["featureCount"], 3);
    assert_eq!(terminal["bundles"][1]["sourceSeqId"], "source-A");
    assert_eq!(terminal["bundles"][1]["name"], "chrA");
    assert_eq!(terminal["bundles"][1]["featureCount"], 4);
    assert!(std::fs::read_dir(&out_dir).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains("split")));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ingest_gff3_assembly_rejects_unbounded_semantic_candidates_without_outputs() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let root = unique_tmpdir("ingest_gff3_semantic_candidate_bound");
    let out_dir = root.join("out");
    std::fs::create_dir_all(&root).unwrap();
    let input_gff3 = root.join("assembly.gff3");
    let input_fasta = root.join("assembly.fa");
    let contig_map = root.join("contig-map.json");
    let mut gff = String::from("##gff-version 3\n##sequence-region source-A 1 1\n");
    for index in 0..=65_536 {
        gff.push_str(&format!(
            "source-A\ttest\tcentromere\t1\t1\t.\t.\t.\tID=cen-{index}\n"
        ));
    }
    std::fs::write(&input_gff3, gff).unwrap();
    std::fs::write(&input_fasta, ">source-A\nA\n").unwrap();
    std::fs::write(
        &contig_map,
        serde_json::to_vec_pretty(&serde_json::json!({
            "contract": "dna-indexer-ingest-gff3-assembly.v1",
            "contigs": [{
                "sourceSeqId": "source-A",
                "name": "chrA",
                "expectedLengthBp": 1,
                "circular": false
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let output = Command::new(exe)
        .arg("ingest-gff3-assembly")
        .arg("--in")
        .arg(&input_gff3)
        .arg("--in-fasta")
        .arg(&input_fasta)
        .arg("--contig-map")
        .arg(&contig_map)
        .arg("--out-dir")
        .arg(&out_dir)
        .output()
        .expect("spawn bounded semantic candidate ingestion");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("semantic candidate count exceeds bounded limit 65536"));
    assert_eq!(std::fs::read_dir(&out_dir).unwrap().count(), 0);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ingest_gff3_assembly_repairs_circular_virtual_start_during_split() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let root = unique_tmpdir("ingest_gff3_assembly_circular_wrap");
    let out_dir = root.join("out");
    std::fs::create_dir_all(&root).unwrap();
    let input_gff3 = root.join("assembly.gff3");
    let input_fasta = root.join("assembly.fa");
    let contig_map = root.join("contig-map.json");
    std::fs::write(
        &input_gff3,
        "##gff-version 3\n\
         ##sequence-region source-A 1 12\n\
         source-A\ttest\tgene\t1\t12\t.\t+\t.\tID=gene-A\n\
         ##sequence-region source-M 1 100\n\
         source-M\ttest\tregion\t1\t100\t.\t+\t.\tID=source-M;Is_circular=true\n\
         source-M\ttest\tmRNA\t130\t60\t.\t?\t.\tID=rna-wrap;exception=trans-splicing\n",
    )
    .unwrap();
    std::fs::write(
        &input_fasta,
        ">source-A\nACGTACGTACGT\n>source-M\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
    )
    .unwrap();
    std::fs::write(
        &contig_map,
        serde_json::to_vec_pretty(&serde_json::json!({
            "contract": "dna-indexer-ingest-gff3-assembly.v1",
            "contigs": [
                {
                    "sourceSeqId": "source-A",
                    "name": "chrA",
                    "expectedLengthBp": 12,
                    "circular": false
                },
                {
                    "sourceSeqId": "source-M",
                    "name": "chrM",
                    "expectedLengthBp": 100,
                    "circular": true
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let output = Command::new(exe)
        .arg("ingest-gff3-assembly")
        .arg("--in")
        .arg(&input_gff3)
        .arg("--in-fasta")
        .arg(&input_fasta)
        .arg("--contig-map")
        .arg(&contig_map)
        .arg("--out-dir")
        .arg(&out_dir)
        .output()
        .expect("spawn assembly ingestion");
    assert!(
        output.status.success(),
        "circular wrap assembly ingestion failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let chr_m_gff3 = read_gff3(&out_dir.join("chrM.gff3.gz"));
    let mrna_intervals: Vec<(&str, &str)> = chr_m_gff3
        .lines()
        .filter(|line| line.split('\t').nth(2) == Some("mRNA"))
        .map(|line| {
            let columns: Vec<&str> = line.split('\t').collect();
            (columns[3], columns[4])
        })
        .collect();
    assert_eq!(mrna_intervals, vec![("1", "30"), ("60", "100")]);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ingest_gff3_assembly_rejects_linear_inverted_interval_during_split() {
    let exe = env!("CARGO_BIN_EXE_dna-indexer");
    let root = unique_tmpdir("ingest_gff3_assembly_linear_inverted");
    let out_dir = root.join("out");
    std::fs::create_dir_all(&root).unwrap();
    let input_gff3 = root.join("assembly.gff3");
    let input_fasta = root.join("assembly.fa");
    let contig_map = root.join("contig-map.json");
    std::fs::write(
        &input_gff3,
        "##gff-version 3\n\
         ##sequence-region source-A 1 12\n\
         source-A\ttest\tgene\t12\t1\t.\t+\t.\tID=gene-A\n",
    )
    .unwrap();
    std::fs::write(&input_fasta, ">source-A\nACGTACGTACGT\n").unwrap();
    std::fs::write(
        &contig_map,
        serde_json::to_vec_pretty(&serde_json::json!({
            "contract": "dna-indexer-ingest-gff3-assembly.v1",
            "contigs": [
                {
                    "sourceSeqId": "source-A",
                    "name": "chrA",
                    "expectedLengthBp": 12,
                    "circular": false
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let output = Command::new(exe)
        .arg("ingest-gff3-assembly")
        .arg("--in")
        .arg(&input_gff3)
        .arg("--in-fasta")
        .arg(&input_fasta)
        .arg("--contig-map")
        .arg(&contig_map)
        .arg("--out-dir")
        .arg(&out_dir)
        .output()
        .expect("spawn assembly ingestion");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("feature end 1 precedes feature start 12"),
        "expected inverted-interval rejection, got:\n{stderr}"
    );

    let _ = std::fs::remove_dir_all(root);
}
