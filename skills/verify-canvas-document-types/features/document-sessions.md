# Document sessions

## Sub-features

Ordinary and indexed sequence sessions, embedded assembly editing, standalone
designs, files, proteins, notebook pages and structures.

## How to get to it (user POV)

Open a project document from the file tree. A sequence document can use either
the normal editor or the indexed viewer without changing its stable identity.

## Driving it with native CDP and Vitest

Run both Drive commands. The native helper opens a sequence and a text file
through file-tree controls, edits text and saves through the editor shortcut. It
checks actual file bytes, loaded sequence content and the selected save target.
The matrix covers all mapped document variants, including indexed sessions using
ordinary document references. Generic presentation updates must not change
identity, and incompatible identity fields must be refused before admission.

## Gotchas

Indexed rendering is not synonymous with an `indexed-sequence` document
reference. Large catalog or managed sequences can also use it. A load-status
hint is not a second document identity. Unsaved artifacts retain their existing
persistence policy; this skill does not claim to save discarded drafts.
