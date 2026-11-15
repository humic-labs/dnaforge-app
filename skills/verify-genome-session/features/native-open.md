# Native open and restoration

## Sub-features

- Cold open of a prepared local reference with a real data track.
- Coordinate navigation, saving the view, closing and warm reopening.
- New native session identity with restored viewport and available tracks.

## How to get to it (user POV)

Create a project, add a local reference, save a Track View and open that file
from Files. Use the coordinate field, Save view and the tab close button, then
reopen the file.

## Driving it with Playwright

Run check-genome-session.mjs from the skill. Its tiny FASTA and BigWig fixture
exercise real native preparation, IPC, filesystem persistence and canvas
rendering. Assert native session readiness and matching saved/restored
coordinate range.

## Gotchas

A restored saved view is an input to a new live session. Its stored manifest
does not establish native readiness. Track View dirty state belongs to its
document owner; genome opening must not silently mutate that document.
