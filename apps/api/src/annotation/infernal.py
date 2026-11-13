"""Compatibility alias for the standalone Infernal parser."""

import sys

from dnaforge_annotation import infernal as _infernal

sys.modules[__name__] = _infernal
