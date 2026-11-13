import importlib.metadata
import json
import sys

import tiktoken

payloads = json.load(sys.stdin)
codec = tiktoken.get_encoding("o200k_base")
print(
    json.dumps(
        {
            "tokenizer": "o200k_base",
            "package": f"tiktoken=={importlib.metadata.version('tiktoken')}",
            "interpretation": "Exact counts under the named comparison codec; not provider billing or a cross-provider token equivalence.",
            "tokens": {
                name: len(codec.encode(value, disallowed_special=()))
                for name, value in payloads.items()
            },
        }
    )
)
