""" — cmscan --rfam sensitivity cutoff.

`--rfam` is a cmscan SPEED filter that REDUCES sensitivity (Infernal guide). Small
inputs (plasmids / subranges) should get full sensitivity (drop the filter); only
genome-scale queries keep it so runtime stays bounded. The branch is keyed off the
EFFECTIVE cmscan query length — the DOUBLED length for a circular whole-sequence
annotate (annotate() runs cmscan over seq+seq), the plain length for linear inputs
and subranges — so the ~60 s runtime budget the cutoff protects is never blown by a
circular input whose doubled query crosses it  review fix).

These are pure-logic tests (no real cmscan); the actual runtime cutoff is validated
by the measurement harness recorded in the  evidence.
"""

import importlib

import pandas as pd


class TestShouldDropRfam:
    """The size-keyed decision to drop cmscan's --rfam speed filter."""

    def test_drops_rfam_at_or_below_cutoff(self, monkeypatch):
        ann = importlib.import_module("src.annotation.annotate")
        monkeypatch.setattr(ann, "RFAM_FULL_SENSITIVITY_MAX_LEN", 1000)
        assert ann._should_drop_rfam(1) is True
        assert ann._should_drop_rfam(999) is True
        assert ann._should_drop_rfam(1000) is True

    def test_keeps_rfam_above_cutoff(self, monkeypatch):
        ann = importlib.import_module("src.annotation.annotate")
        monkeypatch.setattr(ann, "RFAM_FULL_SENSITIVITY_MAX_LEN", 1000)
        assert ann._should_drop_rfam(1001) is False
        assert ann._should_drop_rfam(5_000_000) is False


class TestBuildCmscanArgs:
    """The isolated cmscan arg-assembly helper (re-vendor guard)."""

    def _args(self, drop_rfam):
        ann = importlib.import_module("src.annotation.annotate")
        return ann._build_cmscan_args(
            cmscan_exe="/tools/cmscan",
            drop_rfam=drop_rfam,
            param_args=["--cpu", "1"],
            tmp_name="/tmp/out.tbl",
            safe_clanin="/db/Rfam.clanin",
            safe_cm="/db/Rfam.cm",
            query_name="/tmp/q.fasta",
        )

    def test_keeps_rfam_when_not_dropping(self):
        args = self._args(drop_rfam=False)
        assert "--rfam" in args

    def test_omits_rfam_when_dropping(self):
        args = self._args(drop_rfam=True)
        assert "--rfam" not in args

    def test_core_flags_present_in_both_branches(self):
        """--cut_ga (Rfam GA reporting thresholds) and --nohmmonly (force CM
        scoring) must survive in BOTH branches — only --rfam is the lever."""
        for drop in (True, False):
            args = self._args(drop_rfam=drop)
            assert "--cut_ga" in args
            assert "--nohmmonly" in args
            assert "--noali" in args
            assert "--cpu" in args and "1" in args
            assert args[0] == "/tools/cmscan"
            assert args[-1] == "/tmp/q.fasta"
            assert args[-2] == "/db/Rfam.cm"


class TestAnnotateThreadsDropRfam:
    """annotate() decides drop_rfam from the EFFECTIVE query length and threads it."""

    def _capture(self, ann, seq, linear, monkeypatch):
        seen = {}

        def fake_get_raw_hits(query, lin, yaml_file, env=None, drop_rfam=False):
            seen["drop_rfam"] = drop_rfam
            seen["query_len"] = len(query)
            return pd.DataFrame()

        monkeypatch.setattr(ann, "get_raw_hits", fake_get_raw_hits)
        ann.annotate(seq, linear=linear)
        return seen

    def test_small_linear_input_drops_rfam(self, monkeypatch):
        ann = importlib.import_module("src.annotation.annotate")
        monkeypatch.setattr(ann, "RFAM_FULL_SENSITIVITY_MAX_LEN", 100)
        seen = self._capture(ann, "ACGT" * 10, linear=True, monkeypatch=monkeypatch)
        assert seen["drop_rfam"] is True

    def test_large_linear_input_keeps_rfam(self, monkeypatch):
        ann = importlib.import_module("src.annotation.annotate")
        monkeypatch.setattr(ann, "RFAM_FULL_SENSITIVITY_MAX_LEN", 100)
        seen = self._capture(ann, "ACGT" * 50, linear=True, monkeypatch=monkeypatch)
        assert seen["drop_rfam"] is False

    def test_circular_gates_on_the_DOUBLED_query_length(self, monkeypatch):
        """THE trap  review): annotate() doubles circular queries (seq+seq),
        so the runtime budget the cutoff protects sees 2x the sequence. A 60 bp
        circular doubles to a 120 bp query; with cutoff 100 the decision must be KEEP
        --rfam (effective 120 > 100), NOT drop (pre-doubling 60 <= 100) — otherwise a
        circular in the (cutoff/2, cutoff] band blows the budget."""
        ann = importlib.import_module("src.annotation.annotate")
        monkeypatch.setattr(ann, "RFAM_FULL_SENSITIVITY_MAX_LEN", 100)
        seen = self._capture(ann, "AT" * 30, linear=False, monkeypatch=monkeypatch)
        assert seen["query_len"] == 120
        assert seen["drop_rfam"] is False

    def test_small_circular_still_drops_after_doubling(self, monkeypatch):
        """A circular small enough that even its DOUBLED query fits the budget still
        gets full sensitivity: 40 bp → 80 bp query <= cutoff 100 → drop."""
        ann = importlib.import_module("src.annotation.annotate")
        monkeypatch.setattr(ann, "RFAM_FULL_SENSITIVITY_MAX_LEN", 100)
        seen = self._capture(ann, "AT" * 20, linear=False, monkeypatch=monkeypatch)
        assert seen["query_len"] == 80
        assert seen["drop_rfam"] is True

    def test_linear_of_same_length_is_unaffected_by_doubling(self, monkeypatch):
        """A LINEAR 60 bp (incl. a  subrange, which forces linear) is gated
        on 60, not 120 — so it drops --rfam where the circular of the same length
        keeps it."""
        ann = importlib.import_module("src.annotation.annotate")
        monkeypatch.setattr(ann, "RFAM_FULL_SENSITIVITY_MAX_LEN", 100)
        seen = self._capture(ann, "AT" * 30, linear=True, monkeypatch=monkeypatch)
        assert seen["query_len"] == 60
        assert seen["drop_rfam"] is True
