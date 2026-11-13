"""Compatibility alias for the standalone scientific engine."""

import sys

from dnaforge_annotation import engine as _engine

sys.modules[__name__] = _engine
