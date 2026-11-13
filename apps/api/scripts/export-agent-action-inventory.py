import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.agent_action_inventory import build_builtin_action_inventory, inventory_path

parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
result = (
    json.dumps(build_builtin_action_inventory(), indent=2, ensure_ascii=False) + "\n"
)
path = inventory_path()
if args.check:
    if not path.exists() or path.read_text() != result:
        raise SystemExit(
            "Built-in action inventory drifted; run apps/api/scripts/export-agent-action-inventory.py with the task's API Python."
        )
else:
    path.write_text(result)
print(f"{'Checked' if args.check else 'Generated'} {path.name}")
