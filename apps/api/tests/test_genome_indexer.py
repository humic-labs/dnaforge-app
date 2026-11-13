"""DNA-G1 /  — Sidecar genome indexer tests.

Layers covered (per docs/TEST_PYRAMID.md):

  L0 — security (path traversal, workspace containment, name shape).
  L0 — byte-exact .fai vs `samtools faidx` (skip if samtools missing).
  L1 — POST /genome/index FastAPI route contract (200 + error shapes).
  L1 — GBFF → FASTA + GFF conversion correctness (BioPython reference).
  L1 — tabix functional equivalence (queries return same features as
       a reference tabix-built index).
  L1 — real-fixture happy paths (pUC19 circular, ecoli-mg1655-region
       linear, ecoli-mg1655-complete 4.6 Mb circular). Compound
       locations split into per-segment GFF rows with shared Parent.
  L1 — soft perf log on mg1655-complete (regression tripwire — flags
       O(n²) blow-ups, not a hard wall-clock gate).

Plan: tools/devops/plans/2026-05-03-indexed-genome-backend.md (DNA-G1).
"""

from __future__ import annotations

import gzip
import shutil
import subprocess
import time
from pathlib import Path

import pysam
import pytest

pytest.importorskip("Bio", reason="biopython is a test-only differential oracle")
from Bio import SeqIO
from Bio.SeqFeature import CompoundLocation, FeatureLocation
from fastapi import FastAPI

from src.routes.genome import router as genome_router
from src.services.genome_indexer import (
    GenomeIndexCancelledError,
    GenomeIndexerError,
    UnsupportedFormatError,
    WorkspaceContainmentError,
    index_genome,
)
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient

REPO_ROOT = Path(__file__).resolve().parents[3]
PUC19_GB = REPO_ROOT / "test-fixtures" / "sequences" / "circular" / "pUC19.gb"
MG1655_REGION_GB = (
    REPO_ROOT / "test-fixtures" / "sequences" / "linear" / "ecoli-mg1655-region.gb"
)
MG1655_COMPLETE_GB = (
    REPO_ROOT / "test-fixtures" / "sequences" / "circular" / "ecoli-mg1655-complete.gb"
)
YEAST_CHRIV_GBFF = (
    REPO_ROOT / "test-fixtures" / "genomes" / "yeast-chrIV" / "chrIV.gbff"
)
DEFAULT_GB = PUC19_GB
DEFAULT_SOURCE_NAME = "source.gb"
DEFAULT_SEQID = "pUC19"


def _index_one(workspace: Path, src_gb: Path, name: str = DEFAULT_SEQID):
    """Copy a repo fixture into ``workspace`` and run the indexer."""
    local = workspace / src_gb.name
    shutil.copyfile(src_gb, local)
    return index_genome(
        input_path=local,
        output_dir=workspace / "derived",
        name=name,
        workspace_root=workspace,
    )


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch) -> Path:
    """A clean workspace root containing a public GenBank flat file."""
    ws = tmp_path / "ws"
    ws.mkdir()
    src = ws / DEFAULT_SOURCE_NAME
    shutil.copyfile(DEFAULT_GB, src)
    monkeypatch.setenv(
        "WAYPOINT_ANNOTATION_PYRAMID_CACHE_DIR", str(tmp_path / "annotation-pyramid")
    )
    return ws


@pytest.fixture
def empty_workspace(tmp_path: Path) -> Path:
    """A clean workspace root with no fixture files seeded — tests copy
    the fixture they want via ``_index_one``."""
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


@pytest.fixture
def app() -> FastAPI:
    app = FastAPI()
    app.include_router(genome_router)
    return app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def _has_binary(name: str) -> bool:
    return shutil.which(name) is not None


class TestSecurity:
    def test_input_outside_workspace_rejected(
        self, workspace: Path, tmp_path: Path
    ) -> None:
        outside = tmp_path / "elsewhere.gbff"
        shutil.copyfile(DEFAULT_GB, outside)
        out = workspace / "derived"
        with pytest.raises(WorkspaceContainmentError):
            index_genome(
                input_path=outside,
                output_dir=out,
                name="chrI",
                workspace_root=workspace,
            )

    def test_output_outside_workspace_rejected(
        self, workspace: Path, tmp_path: Path
    ) -> None:
        out = tmp_path / "elsewhere"
        with pytest.raises(WorkspaceContainmentError):
            index_genome(
                input_path=workspace / "source.gb",
                output_dir=out,
                name="chrI",
                workspace_root=workspace,
            )

    def test_path_traversal_in_input_rejected(self, workspace: Path) -> None:
        with pytest.raises(WorkspaceContainmentError):
            index_genome(
                input_path=workspace / ".." / "source.gb",
                output_dir=workspace / "derived",
                name="chrI",
                workspace_root=workspace,
            )

    def test_symlink_escaping_workspace_rejected(
        self, workspace: Path, tmp_path: Path
    ) -> None:
        outside = tmp_path / "secret.gbff"
        shutil.copyfile(DEFAULT_GB, outside)
        link = workspace / "linked.gbff"
        link.symlink_to(outside)
        with pytest.raises(WorkspaceContainmentError):
            index_genome(
                input_path=link,
                output_dir=workspace / "derived",
                name="chrI",
                workspace_root=workspace,
            )

    @pytest.mark.parametrize(
        "bad_name",
        [
            "../escape",
            "a/b",
            "a\\b",
            "name with spaces; rm -rf /",
            "name`whoami`",
            "$(ls)",
            "",
        ],
    )
    def test_invalid_names_rejected(self, workspace: Path, bad_name: str) -> None:
        with pytest.raises((GenomeIndexerError, ValueError)):
            index_genome(
                input_path=workspace / "source.gb",
                output_dir=workspace / "derived",
                name=bad_name,
                workspace_root=workspace,
            )

    def test_unsupported_extension_rejected(self, workspace: Path) -> None:
        bogus = workspace / "source.txt"
        bogus.write_text("not a sequence file\n")
        with pytest.raises(UnsupportedFormatError):
            index_genome(
                input_path=bogus,
                output_dir=workspace / "derived",
                name="chrI",
                workspace_root=workspace,
            )

    def test_multi_record_genbank_rejected(self, workspace: Path) -> None:
        """v1 contract: one chromosome per call (plan §4.1). A two-record
        GBFF must be rejected so the seqid <-> file mapping stays 1:1."""
        multi = workspace / "multi.gbff"
        text = DEFAULT_GB.read_text()
        multi.write_text(text + text)
        with pytest.raises(GenomeIndexerError, match="multi-record"):
            index_genome(
                input_path=multi,
                output_dir=workspace / "derived",
                name="chrI",
                workspace_root=workspace,
            )


class TestConversionCorrectness:
    def test_fasta_per_base_matches_biopython(self, workspace: Path) -> None:
        result = index_genome(
            input_path=workspace / "source.gb",
            output_dir=workspace / "derived",
            name=DEFAULT_SEQID,
            workspace_root=workspace,
        )
        records = list(SeqIO.parse(DEFAULT_GB, "genbank"))
        assert len(records) == 1
        ref_seq = str(records[0].seq).upper()

        with pysam.FastaFile(str(result.fasta_path)) as fa:
            out_seq = fa.fetch(DEFAULT_SEQID).upper()
        assert out_seq == ref_seq
        assert result.metadata.length == len(ref_seq) == 2686
        assert result.metadata.circular is True
        assert result.metadata.feature_count == sum(
            len(feature.location.parts) for feature in records[0].features
        )

    def test_gff_features_round_trip_genbank(self, workspace: Path) -> None:
        result = index_genome(
            input_path=workspace / "source.gb",
            output_dir=workspace / "derived",
            name=DEFAULT_SEQID,
            workspace_root=workspace,
        )
        with gzip.open(result.gff_path, "rt") as fh:
            lines = [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]

        expected_cds = {
            ("lacZ", 146, 469, "-"),
            ("bla", 1626, 2486, "-"),
        }
        seen_cds: set[tuple[str, int, int, str]] = set()
        for line in lines:
            parts = line.split("\t")
            if len(parts) < 9:
                continue
            seqid, _src, ftype, start, end, _score, strand, _phase, attrs = parts
            assert seqid == DEFAULT_SEQID
            if ftype != "CDS":
                continue
            gene = ""
            for kv in attrs.split(";"):
                if kv.startswith("gene=") or kv.startswith("Name="):
                    gene = kv.split("=", 1)[1]
                    break
            seen_cds.add((gene, int(start), int(end), strand))
        assert expected_cds.issubset(seen_cds), f"missing CDS rows. saw={seen_cds}"

    def test_genbank_rna_subtype_qualifiers_survive_gff(
        self, empty_workspace: Path
    ) -> None:
        source = empty_workspace / "lncrna.gb"
        source.write_text(
            """LOCUS       TESTCHR                  120 bp    DNA     linear   UNA 01-JAN-2000
DEFINITION  Synthetic lncRNA qualifier preservation fixture.
ACCESSION   TESTCHR
FEATURES             Location/Qualifiers
     source          1..120
                     /organism=\"synthetic construct\"
     gene            10..80
                     /gene=\"LINC_TEST\"
     ncRNA           join(10..40,60..80)
                     /ncRNA_class=\"lncRNA\"
                     /gene=\"LINC_TEST\"
                     /product=\"long intergenic non-protein coding RNA, test\"
                     /transcript_id=\"NR_TEST.1\"
ORIGIN
        1 aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa
       61 aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa aaaaaaaaaa
//
""",
            encoding="utf-8",
        )

        result = index_genome(
            input_path=source,
            output_dir=empty_workspace / "derived",
            name="TESTCHR",
            workspace_root=empty_workspace,
        )

        with gzip.open(result.gff_path, "rt") as fh:
            rows = [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
        ncrna_rows = [row for row in rows if "\tncRNA\t" in row]
        assert len(ncrna_rows) == 1
        assert ncrna_rows[0].split("\t")[3:5] == ["10", "80"]
        for row in ncrna_rows:
            attrs = row.split("\t")[8]
            assert "ncRNA_class=lncRNA" in attrs
            assert "transcript_id=NR_TEST.1" in attrs
            assert "gene=LINC_TEST" in attrs
            assert "product=long intergenic non-protein coding RNA%2C test" in attrs

    def test_fasta_input_uses_requested_seqid(self, workspace: Path) -> None:
        genbank_result = index_genome(
            input_path=workspace / "source.gb",
            output_dir=workspace / "derived",
            name=DEFAULT_SEQID,
            workspace_root=workspace,
        )
        fasta_result = index_genome(
            input_path=genbank_result.fasta_path,
            output_dir=workspace / "fasta-derived",
            name="pUC19-renamed",
            workspace_root=workspace,
        )

        assert fasta_result.metadata.length == 2686
        assert fasta_result.metadata.circular is False
        assert fasta_result.gff_path is None
        assert fasta_result.tbi_path is None
        with pysam.FastaFile(str(fasta_result.fasta_path)) as fa:
            assert list(fa.references) == ["pUC19-renamed"]
            assert list(fa.lengths) == [2686]


@pytest.mark.skipif(not _has_binary("samtools"), reason="samtools not on PATH")
class TestFaiByteExact:
    def test_fai_byte_exact_with_samtools(
        self, workspace: Path, tmp_path: Path
    ) -> None:
        result = index_genome(
            input_path=workspace / "source.gb",
            output_dir=workspace / "derived",
            name=DEFAULT_SEQID,
            workspace_root=workspace,
        )
        ref_fa = tmp_path / "ref.fa.gz"
        shutil.copyfile(result.fasta_path, ref_fa)
        gzi = Path(str(result.fasta_path) + ".gzi")
        if gzi.exists():
            shutil.copyfile(gzi, Path(str(ref_fa) + ".gzi"))
        subprocess.run(
            ["samtools", "faidx", str(ref_fa)],
            check=True,
            capture_output=True,
        )
        ref_fai = ref_fa.with_suffix(ref_fa.suffix + ".fai")
        assert ref_fai.exists()
        ours = Path(result.fai_path).read_bytes()
        ref = ref_fai.read_bytes()
        assert ours == ref, "our .fai differs from samtools faidx output"


class TestTabixFunctional:
    def test_tabix_query_returns_overlapping_features(self, workspace: Path) -> None:
        import pysam

        source = workspace / "source.gb"
        record = SeqIO.read(source, "genbank")
        record.features = [
            feature for feature in record.features if feature.type != "source"
        ]
        assert record.features
        assert all(
            int(feature.location.end) <= 600 or int(feature.location.start) >= 650
            for feature in record.features
        )
        SeqIO.write(record, source, "genbank")
        result = index_genome(
            input_path=source,
            output_dir=workspace / "derived",
            name=DEFAULT_SEQID,
            workspace_root=workspace,
        )
        tbx = pysam.TabixFile(str(result.gff_path))
        rows = list(tbx.fetch(DEFAULT_SEQID, 1625, 1645))
        assert any("gene=bla" in r for r in rows), f"no bla hit: {rows}"
        rows = list(tbx.fetch(DEFAULT_SEQID, 600, 650))
        assert rows == []


class TestRouteContract:
    def test_cancelled_before_start_does_not_create_outputs(
        self, workspace: Path
    ) -> None:
        output_dir = workspace / "cancelled-derived"
        with pytest.raises(GenomeIndexCancelledError, match="cancelled"):
            index_genome(
                input_path=workspace / "source.gb",
                output_dir=output_dir,
                name=DEFAULT_SEQID,
                workspace_root=workspace,
                cancel_check=lambda: True,
            )
        assert not output_dir.exists()

    def test_happy_path_200(self, client: TestClient, workspace: Path) -> None:
        body = {
            "input": str(workspace / "source.gb"),
            "outputDir": str(workspace / "derived"),
            "name": DEFAULT_SEQID,
            "workspaceRoot": str(workspace),
        }
        resp = client.post("/genome/index", json=body)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        for key in ("fastaPath", "faiPath", "gffPath", "tbiPath", "metadata"):
            assert key in data, key
        for key in (
            "length",
            "circular",
            "featureCount",
            "annotationTypes",
            "annotationRasterReady",
        ):
            assert key in data["metadata"], key
        assert data["metadata"]["length"] == 2686
        assert data["metadata"]["circular"] is True
        assert data["metadata"]["annotationRasterReady"] is True
        assert "CDS" in data["metadata"]["annotationTypes"]

    def test_missing_input_404(self, client: TestClient, workspace: Path) -> None:
        body = {
            "input": str(workspace / "no-such-file.gbff"),
            "outputDir": str(workspace / "derived"),
            "name": "chrI",
            "workspaceRoot": str(workspace),
        }
        resp = client.post("/genome/index", json=body)
        assert resp.status_code == 404

    def test_unsupported_extension_400(
        self, client: TestClient, workspace: Path
    ) -> None:
        bogus = workspace / "junk.txt"
        bogus.write_text("hello\n")
        body = {
            "input": str(bogus),
            "outputDir": str(workspace / "derived"),
            "name": "chrI",
            "workspaceRoot": str(workspace),
        }
        resp = client.post("/genome/index", json=body)
        assert resp.status_code == 400

    def test_invalid_name_is_rejected_at_the_request_boundary(
        self, client: TestClient, workspace: Path
    ) -> None:
        """The shared managed-operation contract rejects unsafe names before work."""
        body = {
            "input": str(workspace / "source.gb"),
            "outputDir": str(workspace / "derived"),
            "name": "../escape",
            "workspaceRoot": str(workspace),
        }
        resp = client.post("/genome/index", json=body)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"][0]["loc"] == ["body", "name"]

    def test_outside_workspace_422(
        self, client: TestClient, workspace: Path, tmp_path: Path
    ) -> None:
        outside = tmp_path / "elsewhere.gbff"
        shutil.copyfile(DEFAULT_GB, outside)
        body = {
            "input": str(outside),
            "outputDir": str(workspace / "derived"),
            "name": "chrI",
            "workspaceRoot": str(workspace),
        }
        resp = client.post("/genome/index", json=body)
        assert resp.status_code == 422


class TestRealFixtureHappyPaths:
    def test_puc19_circular_round_trip(self, empty_workspace: Path) -> None:
        result = _index_one(empty_workspace, PUC19_GB, name="pUC19")
        assert result.metadata.circular is True
        assert result.metadata.length == 2686
        record = SeqIO.read(PUC19_GB, "genbank")
        assert result.metadata.feature_count == sum(
            len(feature.location.parts) for feature in record.features
        )
        with pysam.FastaFile(str(result.fasta_path)) as fa:
            assert list(fa.references) == ["pUC19"]
            assert list(fa.lengths) == [2686]
            head = fa.fetch("pUC19", 0, 8)
            assert len(head) == 8

    def test_puc19_compound_locations_split_into_segments(
        self, empty_workspace: Path
    ) -> None:
        record = SeqIO.read(PUC19_GB, "genbank")
        rep_origin = next(
            feature for feature in record.features if feature.type == "rep_origin"
        )
        rep_origin.location = CompoundLocation(
            [FeatureLocation(2314, 2686, strand=1), FeatureLocation(0, 217, strand=1)]
        )
        bla = next(
            feature
            for feature in record.features
            if feature.type == "CDS" and feature.qualifiers.get("gene") == ["bla"]
        )
        bla_sequence = bla.extract(record.seq)
        bla.location = CompoundLocation(
            [
                FeatureLocation(1694, 2486, strand=-1),
                FeatureLocation(1625, 1694, strand=-1),
            ]
        )
        assert bla.extract(record.seq) == bla_sequence
        source = empty_workspace / "pUC19-compound-test.gb"
        SeqIO.write(record, source, "genbank")
        result = index_genome(
            input_path=source,
            output_dir=empty_workspace / "derived",
            name="pUC19",
            workspace_root=empty_workspace,
        )
        with gzip.open(result.gff_path, "rt") as fh:
            rows = [
                ln.strip().split("\t")
                for ln in fh
                if ln.strip() and not ln.startswith("#")
            ]

        def attrs(row: list[str]) -> dict[str, str]:
            return dict(kv.split("=", 1) for kv in row[8].split(";") if "=" in kv)

        rep_origin_rows = [r for r in rows if r[2] == "rep_origin"]
        assert sorted((int(r[3]), int(r[4])) for r in rep_origin_rows) == [
            (1, 217),
            (2315, 2686),
        ]
        assert len({attrs(r)["ID"] for r in rep_origin_rows}) == 1
        assert all(
            attrs(r).get("_dnaforge_origin_spanning") == "true" for r in rep_origin_rows
        )

        bla_cds = [r for r in rows if r[2] == "CDS" and attrs(r).get("gene") == "bla"]
        assert sorted((int(r[3]), int(r[4])) for r in bla_cds) == [
            (1626, 1694),
            (1695, 2486),
        ]
        assert all(r[6] == "-" for r in bla_cds)

    def test_mg1655_region_linear(self, empty_workspace: Path) -> None:
        """78 kb linear region — real annotation density, no compound
        locations. Validates per-segment iteration is identical to the
        single-segment path."""
        result = _index_one(empty_workspace, MG1655_REGION_GB, name="region")
        assert result.metadata.circular is False
        assert result.metadata.length == 78345
        assert result.metadata.feature_count == 182
        with pysam.TabixFile(str(result.gff_path)) as tbx:
            mid_hits = list(tbx.fetch("region", 30_000, 40_000))
            assert len(mid_hits) > 0

    @pytest.mark.slow
    @pytest.mark.skipif(
        not YEAST_CHRIV_GBFF.exists(), reason="yeast-chrIV fixture not present"
    )
    def test_yeast_chrIV_eukaryote(self, empty_workspace: Path) -> None:
        """1.5 Mb linear yeast chromosome IV — eukaryotic feature shapes
        (joined CDS for spliced genes). Plan §9.1 fixture."""
        result = _index_one(empty_workspace, YEAST_CHRIV_GBFF, name="chrIV")
        assert result.metadata.length == 1_531_933
        assert result.metadata.circular is False
        assert result.metadata.feature_count > 1000
        with pysam.FastaFile(str(result.fasta_path)) as fa:
            assert list(fa.references) == ["chrIV"]
            assert fa.lengths[0] == 1_531_933
        with pysam.TabixFile(str(result.gff_path)) as tbx:
            hits = list(tbx.fetch("chrIV", 500_000, 600_000))
            assert len(hits) > 5, f"expected eukaryote density, got {len(hits)}"

    @pytest.mark.slow
    def test_mg1655_complete_circular_density(self, empty_workspace: Path) -> None:
        """4.6 Mb circular complete genome with ~10k features. Real
        density, real circular topology. Slow enough to deselect from the
        default `-m "not slow"` run, but blocks deeper PRs."""
        result = _index_one(empty_workspace, MG1655_COMPLETE_GB, name="mg1655")
        assert result.metadata.circular is True
        assert result.metadata.length == 4_641_652
        assert result.metadata.feature_count == 9_306
        with pysam.FastaFile(str(result.fasta_path)) as fa:
            assert list(fa.references) == ["mg1655"]
            assert fa.lengths[0] == 4_641_652
            chunk = fa.fetch("mg1655", 1_000_000, 1_001_000)
            assert len(chunk) == 1000
        with pysam.TabixFile(str(result.gff_path)) as tbx:
            hits = list(tbx.fetch("mg1655", 1_000_000, 1_100_000))
            assert len(hits) > 50, f"expected dense feature hits, got {len(hits)}"


class TestPerfTripwire:
    @pytest.mark.slow
    def test_mg1655_complete_under_upper_bound(self, tmp_path: Path) -> None:
        ws = tmp_path / "ws"
        ws.mkdir()
        t0 = time.monotonic()
        result = _index_one(ws, MG1655_COMPLETE_GB, name="mg1655")
        elapsed = time.monotonic() - t0
        print(
            f"\n[perf] mg1655-complete index: {elapsed:.2f}s "
            f"(features={result.metadata.feature_count})"
        )
        assert (
            elapsed < 60.0
        ), f"mg1655-complete indexing took {elapsed:.1f}s — investigate before raising the bound"


class TestAtomicity:
    """A partial-failure run must not leave the workspace observably
    half-built. The implementation stages outputs in a sibling tempdir
    and `os.replace`s into place after every step succeeded; on
    exception the staging dir is wiped before propagation.
    """

    def test_partial_failure_leaves_no_orphans(
        self,
        empty_workspace: "Path",
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from src.services import genome_indexer as svc

        def boom(*args, **kwargs):
            raise RuntimeError("forced publish failure")

        monkeypatch.setattr(svc, "_publish_staged_bundle", boom)

        out = empty_workspace / "derived"
        with pytest.raises(RuntimeError, match="forced publish failure"):
            _index_one(empty_workspace, PUC19_GB, name="pUC19")

        assert not (out / "pUC19.fa").exists(), "leaked .fa from failed run"
        assert not (out / "pUC19.fa.gz").exists(), "leaked .fa.gz from failed run"
        assert not (out / "pUC19.fa.fai").exists(), "leaked .fai"
        assert not (out / "pUC19.fa.gz.fai").exists(), "leaked .fa.gz.fai"
        assert not (out / "pUC19.fa.gz.gzi").exists(), "leaked .gzi"
        assert not (out / "pUC19.gff3.gz").exists(), "leaked .gff3.gz"
        assert not (out / "pUC19.gff3.gz.tbi").exists(), "leaked .tbi"
        leftovers = [
            p
            for p in (out.iterdir() if out.exists() else [])
            if p.name.startswith(".pUC19.indexing.")
        ]
        assert leftovers == [], f"staging dir not cleaned: {leftovers}"

    def test_partial_failure_does_not_clobber_prior_run(
        self,
        empty_workspace: "Path",
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        first = _index_one(empty_workspace, PUC19_GB, name="pUC19")
        first_fa_bytes = Path(first.fasta_path).read_bytes()
        first_fai_bytes = Path(first.fai_path).read_bytes()

        from src.services import genome_indexer as svc

        def boom(*args, **kwargs):
            raise RuntimeError("forced publish failure")

        monkeypatch.setattr(svc, "_publish_staged_bundle", boom)
        with pytest.raises(RuntimeError):
            _index_one(empty_workspace, PUC19_GB, name="pUC19")

        assert Path(first.fasta_path).read_bytes() == first_fa_bytes
        assert Path(first.fai_path).read_bytes() == first_fai_bytes


class TestIdempotency:
    """Published output directories are immutable source generations."""

    def test_repeat_call_reuses_committed_generation(
        self, empty_workspace: Path
    ) -> None:
        first = _index_one(empty_workspace, PUC19_GB, name="pUC19")
        first_meta = first.metadata
        first_fa = Path(first.fasta_path).read_bytes()
        first_fai = Path(first.fai_path).read_bytes()
        first_gff = Path(first.gff_path).read_bytes()
        first_tbi = Path(first.tbi_path).read_bytes()

        second = index_genome(
            input_path=empty_workspace / PUC19_GB.name,
            output_dir=empty_workspace / "derived",
            name="pUC19",
            workspace_root=empty_workspace,
        )
        assert second.metadata == first_meta
        assert Path(second.fasta_path).read_bytes() == first_fa
        assert Path(second.fai_path).read_bytes() == first_fai
        assert Path(second.gff_path).read_bytes() != b"" and len(first_gff) > 0
        assert Path(second.tbi_path).read_bytes() != b"" and len(first_tbi) > 0
        with pysam.TabixFile(str(second.gff_path)) as tbx:
            second_hits = sorted(tbx.fetch("pUC19", 0, 2686))
        with pysam.TabixFile(str(first.gff_path)) as tbx:
            first_hits = sorted(tbx.fetch("pUC19", 0, 2686))
        assert second_hits == first_hits

    def test_different_input_cannot_replace_committed_generation(
        self, empty_workspace: Path
    ) -> None:
        first = _index_one(empty_workspace, PUC19_GB, name="chr")
        assert first.metadata.length == 2686
        output_dir = empty_workspace / "derived"
        before = {path.name: path.read_bytes() for path in output_dir.iterdir()}

        with pytest.raises(
            GenomeIndexerError,
            match="different source or schema",
        ):
            _index_one(empty_workspace, MG1655_REGION_GB, name="chr")

        assert {path.name: path.read_bytes() for path in output_dir.iterdir()} == before
        with pysam.FastaFile(str(first.fasta_path)) as fa:
            assert fa.lengths[0] == 2686
