""" — constrain pLannotate to a selected range.

annotate(AnnotationRequest(sequence, start, end)) slices the sequence to the wire subrange
(0-indexed, half-open, source-space), forces linear annotation for the subrange
(circular doubling would corrupt coordinates), then offsets returned feature
QUERY coords back into whole-sequence space. Reference (subject) coords are
untouched and sequence_length stays the FULL length.
"""

import importlib
from pathlib import Path

import pytest

from src.services.plannotate import AnnotationFeature, AnnotationRequest


def synthetic_feature(**overrides) -> AnnotationFeature:
    """A complete feature at subrange-local 1-indexed query coords."""
    values = {
        "name": "x",
        "start": 11,
        "end": 20,
        "strand": 1,
        "ref_start": 5,
        "ref_end": 14,
        "ref_length": 100,
        "identity": 100.0,
        "coverage": 50.0,
        "fragment": True,
        "db_source": "nucleotide",
    }
    values.update(overrides)
    return AnnotationFeature(**values)


class TestNormalizeAnnotateRange:
    """The pure wire {start, end} → 0-indexed half-open slice normalizer."""

    def _fn(self):
        pm = importlib.import_module("src.services.plannotate")
        return pm._normalize_annotate_range

    def test_none_when_bounds_missing(self):
        fn = self._fn()
        assert fn(None, None, 1000) is None
        assert fn(100, None, 1000) is None
        assert fn(None, 200, 1000) is None

    def test_none_when_non_numeric(self):
        fn = self._fn()
        assert fn("abc", 200, 1000) is None

    def test_valid_subrange_passthrough(self):
        fn = self._fn()
        assert fn(100, 200, 1000) == (100, 200)

    def test_string_ints_coerced(self):
        fn = self._fn()
        assert fn("100", "200", 1000) == (100, 200)

    def test_clamped_to_sequence_bounds(self):
        fn = self._fn()
        assert fn(-50, 200, 1000) == (0, 200)
        assert fn(100, 5000, 1000) == (100, 1000)

    def test_none_when_degenerate(self):
        fn = self._fn()
        assert fn(200, 100, 1000) is None
        assert fn(200, 200, 1000) is None

    def test_none_when_whole_sequence(self):
        fn = self._fn()
        assert fn(0, 1000, 1000) is None


class TestExecuteSubrange:
    """annotate() slice + force-linear + query-coord offset behavior."""

    @pytest.fixture
    def service(self):
        from src.services.plannotate import PlannotateService

        return PlannotateService()

    async def _run_with_stub(self, service, monkeypatch, seq, **kwargs):
        pm = importlib.import_module("src.services.plannotate")
        captured = {}

        async def fake_run(sequence, linear):
            captured["sequence"] = sequence
            captured["linear"] = linear
            return [synthetic_feature()]

        service._plannotate_available = True
        service._binaries_dir = Path("/x")
        monkeypatch.setattr(
            service, "get_database_status", lambda: {"downloaded": True}
        )
        monkeypatch.setattr(
            pm,
            "check_required_binaries",
            lambda *_a, **_k: {"blastn": "/b", "diamond": "/d", "cmscan": "/c"},
        )
        monkeypatch.setattr(service, "_run_plannotate", fake_run)
        result = await service.annotate(AnnotationRequest(sequence=seq, **kwargs))
        return result, captured

    @pytest.mark.asyncio
    async def test_subrange_slices_forces_linear_and_offsets(
        self, service, monkeypatch
    ):
        seq = "ACGT" * 100
        result, captured = await self._run_with_stub(
            service, monkeypatch, seq, start=100, end=200
        )
        assert captured["sequence"] == seq[100:200]
        assert captured["linear"] is True
        f = result.features[0]
        assert f.start == 111
        assert f.end == 120
        assert f.ref_start == 5
        assert f.ref_end == 14
        assert result.sequence_length == 400

    @pytest.mark.asyncio
    async def test_offset_applies_to_both_strands_query_coords_only(
        self, service, monkeypatch
    ):
        """The +start offset lands on QUERY coords for BOTH strands; ref_* (subject
        coords) stay untouched regardless of strand."""
        pm = importlib.import_module("src.services.plannotate")

        async def fake_run(sequence, linear):
            return [
                synthetic_feature(name="fwd"),
                synthetic_feature(
                    name="rev",
                    start=30,
                    end=40,
                    strand=-1,
                    ref_start=7,
                    ref_end=17,
                    identity=90.0,
                    coverage=60.0,
                ),
            ]

        service._plannotate_available = True
        service._binaries_dir = Path("/x")
        monkeypatch.setattr(
            service, "get_database_status", lambda: {"downloaded": True}
        )
        monkeypatch.setattr(
            pm,
            "check_required_binaries",
            lambda *_a, **_k: {"blastn": "/b", "diamond": "/d", "cmscan": "/c"},
        )
        monkeypatch.setattr(service, "_run_plannotate", fake_run)
        result = await service.annotate(
            AnnotationRequest(sequence="ACGT" * 100, start=100, end=200)
        )

        feats = {f.name: f for f in result.features}
        assert feats["fwd"].start == 111 and feats["fwd"].end == 120
        assert feats["rev"].start == 130 and feats["rev"].end == 140
        assert feats["rev"].strand == -1
        assert feats["rev"].ref_start == 7 and feats["rev"].ref_end == 17

    @pytest.mark.asyncio
    async def test_subrange_forces_linear_even_for_circular_input(
        self, service, monkeypatch
    ):
        seq = "ACGT" * 100
        _, captured = await self._run_with_stub(
            service, monkeypatch, seq, start=50, end=150, linear=False
        )
        assert captured["linear"] is True

    @pytest.mark.asyncio
    async def test_no_range_runs_full_sequence_unchanged(self, service, monkeypatch):
        seq = "ACGT" * 100
        result, captured = await self._run_with_stub(service, monkeypatch, seq)
        assert captured["sequence"] == seq
        assert captured["linear"] is False
        f = result.features[0]
        assert f.start == 11
        assert f.end == 20

    @pytest.mark.asyncio
    async def test_whole_sequence_range_is_noop(self, service, monkeypatch):
        seq = "ACGT" * 100
        result, captured = await self._run_with_stub(
            service, monkeypatch, seq, start=0, end=400, linear=True
        )
        assert captured["sequence"] == seq
        f = result.features[0]
        assert f.start == 11

    @pytest.mark.asyncio
    async def test_degenerate_range_falls_back_to_full(self, service, monkeypatch):
        seq = "ACGT" * 100
        result, captured = await self._run_with_stub(
            service, monkeypatch, seq, start=300, end=100
        )
        assert captured["sequence"] == seq
        f = result.features[0]
        assert f.start == 11


class TestInputTypes:
    def test_start_end_declared_optional(self):
        from src.services.plannotate import PlannotateService

        s = PlannotateService()
        assert AnnotationRequest.model_fields["start"].is_required() is False
        assert AnnotationRequest.model_fields["end"].is_required() is False
        assert s.INPUT_TYPES["start"]["required"] is False
        assert s.INPUT_TYPES["end"]["required"] is False


class TestSubrangeRealAnnotation:
    """Real-boundary proof: slice + offset round-trips through the ACTUAL
    cmscan/blast/diamond pipeline on the provisioned DB. Mocks prove the offset
    math; this proves the whole path lands features at whole-sequence coords.
    Skipped when databases/binaries are absent (CI without the 309 MB DB)."""

    @pytest.fixture
    def service(self):
        from src.services.plannotate import PlannotateService

        return PlannotateService()

    @pytest.fixture
    def skip_if_no_databases(self, service):
        status = service.get_database_status()
        if not status.get("plannotate_available"):
            pytest.skip("pLannotate library not installed")
        if not status.get("downloaded"):
            pytest.skip("Annotation databases not downloaded")
        missing = [k for k, v in status.get("binaries", {}).items() if v is None]
        if missing:
            pytest.skip(f"Missing binaries: {', '.join(missing)}")

    @pytest.mark.asyncio
    async def test_subrange_features_land_at_whole_sequence_coords(
        self, service, skip_if_no_databases
    ):
        from tests.test_plannotate import TestPlannotateAnnotationIntegration as Fx

        seq = Fx.PUC19_SEQUENCE
        full = await service.annotate(AnnotationRequest(sequence=seq))
        assert full.error is None, full.error
        assert full.features, "pUC19 must annotate on the real DB"

        candidates = [
            f for f in full.features if f.start < f.end and f.end - f.start > 150
        ]
        assert candidates, "need a non-wrapping feature to test the offset"
        target = max(candidates, key=lambda f: f.end - f.start)

        pad = 60
        wire_start = max(0, target.start - 1 - pad)
        wire_end = min(len(seq), target.end + pad)
        sub = await service.annotate(
            AnnotationRequest(sequence=seq, start=wire_start, end=wire_end)
        )

        assert sub.error is None, sub.error
        assert sub.sequence_length == len(seq)
        assert sub.features, "the subrange around the target must find features"

        for f in sub.features:
            assert f.start >= wire_start + 1 - 5, f
            assert f.end <= wire_end + 5, f

        matched = [f for f in sub.features if f.name == target.name]
        assert matched, f"target {target.name} vanished in the subrange"
        assert any(
            abs(f.start - target.start) <= 5 and abs(f.end - target.end) <= 5
            for f in matched
        ), f"target not at offset position: {matched} vs target {target}"
