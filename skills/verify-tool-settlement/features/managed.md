# Finish managed work through its owner

## Sub-features

A renderer preparation audit does not finish a managed operation's admission.
The sidecar handler supplies its final result or error.

## How to get to it (user POV)

Start a primer match operation through the agent tool service.

## Driving it with pytest

Run `test_managed_preparation_waits_for_job_owner` in
`tests/test_tool_settlement.py`. Observe an incomplete action after renderer
preparation, followed by the managed handler's terminal outcome.
`test_file_document_persists_selected_owner_before_handler` in
`tests/test_action_completion.py` covers tab-based renderer admission and native
file/document admission.

## Gotchas

This proves completion ownership at admission. It does not run a primer search
or qualify the scientific output.
