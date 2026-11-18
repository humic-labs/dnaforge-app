# Equipment incidents and retained subject restrictions

Open Inventory, select the project and an existing storage location, then open
Equipment incidents. Report an outage with an explicit description, optional
noticed time and reason. Preview makes no changes; Close retains the draft.
Record captures contents at recording time. A freezer name does not establish
its equipment type, geometry, temperature, qualification or physical fit.

Contents when recorded, Contents now and Review obligations are separate views.
Keep identified stock, confirmed unidentified contents, unobserved possible
contents and declared-empty containers distinct. Identification of an initial
confirmed episode records existing material with its independently chosen
quantity and quality; it is not a receipt or count-to-volume conversion.

Record manual temperature with Celsius, an explicit observation time and a
measurement point. Inspect the selected exact fact under an explicit age policy.
Freshness belongs to that observation, not a global current chamber reading.
History is in recording order. Corrections and withdrawals pin their exact
predecessor; the original fact remains retained.

Report only completed whole-holder relocations. Select each entire holder and
its actual existing destination and position. Preview must exclude occupied
positions and refuse incomplete or invalid selections without a Record action.
Normal custody, reservation, stacking and fit rules apply. Moving one box does
not imply the source equipment was fully evacuated or physical fit qualified.

Each subject review explicitly keeps or removes THIS incident restriction.
Reviewed is separate from usable: quality, batch assessment, validity and other
restrictions still apply. Superseding a removal with Keep also restricts derived
material carrying that root. Resolve equipment explicitly; this never releases
subjects. Reviews and manual follow-ups remain independent after resolution.

## Maintained journey

`equipment-incidents` and `equipment-incidents-resume` in
`apps/desktop/scripts/inventory-journey.mjs` continue an accepted report
fixture. They preserve its original request and receipt. No fresh outage is
created. The selected fixture needs an existing whole tube box, confirmed
unidentified episode, known volume stock, empty movable tube, rescue location
and ordinary receiving box. Resolve identities from current native facts, not
literal IDs. The existing runner's isolated-profile guard remains in force.

The journey records one manual fact, identifies existing unknown contents,
clears an already declared-empty destination occupant, reports one whole-box
move, records Keep then superseding Remove, transfers one microlitre into an
existing co-moved empty tube, resolves the occurrence, then supersedes with Keep
and corrects/withdraws the manual reading. A selected observation is shown Fresh
and later Stale under the same explicit policy. Source and child remain blocked
without reopening equipment. Other source holders and pending obligations stay.

Visible Prepared requests are saved before incident Record clicks. Ordinary
Identify, Move and Transfer use a read-only subscription to the existing pending
coordinator: retain its first durable request publication before its flight. The
observer neither intercepts execution nor changes application state. Keep its
observation time distinct from the later disk checkpoint time. Save each
matching acknowledgement immediately before later state assertions. A failed or
missing acknowledgement resumes the original pending operation; it never creates
a replacement identity or repeats physical intent under a new request.

`equipment-incidents-reopen` uses the final fixture after a full native restart.
It reads exact state/history, initial/current/review views and retained facts
without accepted actions. Keep original failed captures and accepted prefixes.
Before subject captures, wait for the requested view and its settled native row
keys. Capture the selected initial/current vessel, individual retained root and
source/child articles, the selected exact manual fact, and each stock’s visible
incident blocker. Avoid screenshots of the entire tall incident section.
Interaction video covers selection, preview, recording and recovery. Native/core
checks and this manual demonstration establish no hardware, continuous
monitoring, emergency override or team-sharing qualification.
