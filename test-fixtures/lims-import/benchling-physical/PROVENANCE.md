# Synthetic Benchling V2 physical capture

`representative-capture.json` is DNAForge-owned synthetic test data. It contains
invented IDs, names, actors, quantities and records. It contains no tenant data,
credentials, downloaded biological sequences or copied documentation examples.
The outer `dnaforge.benchling-physical-capture.v1` wrapper is a DNAForge format,
not an export format published by Benchling. The declared scope is selected
records, never a claim of complete tenant inventory.

SHA-256 of the complete UTF-8 fixture, including its final newline:
`d6e5539beb9bebd4453d5cf22a97b442c4fb9ea053a4b3691a85af7224a403bb`.

The response shapes were checked against these official contracts on
2026-11-16:

- [Get a location](https://docs.benchling.com/docs/api/v2/benchling-api/locations/get-location).
  `/api/v2/locations/:location_id` supplies identity, parent and optional capacity
  observations. A capacity value is not a grid or a freezer specification.
- [Get a box](https://docs.benchling.com/docs/api/v2/benchling-api/boxes/get-box).
  `/api/v2/boxes/:box_id` supplies the box and schema reference.
- [Get a box schema](https://docs.benchling.com/docs/api/v2/benchling-api/schemas/get-box-schema).
  The actual endpoint is `/api/v2/box-schemas/:schema_id`; height and width are
  numeric source observations.
- [List a box's contents](https://docs.benchling.com/docs/api/v2/benchling-api/boxes/list-box-contents).
  `/api/v2/boxes/:box_id/contents` returns containers with separate gridPosition
  and gridNumber fields and pagination metadata.
- [Get a container](https://docs.benchling.com/docs/api/v2/benchling-api/containers/get-container).
  `/api/v2/containers/:container_id` has quantity, contents and parent fields.
  Quantity can express dimensions other than volume, and the deprecated volume
  field does not guarantee a volume dimension. Foreign checkout/restriction
  metadata remains source evidence.
- [Get a plate](https://docs.benchling.com/docs/api/v2/benchling-api/plates/get-plate).
  `/api/v2/plates/:plate_id` distinguishes well_plate and matrix_plate and has
  wells keyed by position.
- [Get a plate schema](https://docs.benchling.com/docs/api/v2/benchling-api/schemas/get-plate-schema).
  The actual endpoint is `/api/v2/plate-schemas/:schema_id`. The fixture omits
  its optional plateType string; the plate record supplies the documented type.
- [Filters and pagination](https://docs.benchling.com/docs/filters-and-pagination).
  Empty-string nextToken terminates a page chain; a nonempty token belongs in
  the next request. Omitted nextToken does not prove termination.

The direct objects under each well position also follow the historical official
[SDK 1.6.1 PlateWells](https://benchling.com/sdk-docs/1.6.1/benchling_sdk.models.html#benchling_sdk.models.PlateWells)
and [Well](https://benchling.com/sdk-docs/1.6.1/benchling_sdk.models.html#benchling_sdk.models.Well)
model definitions. PlateWells allows Well, InaccessibleResource and unknown
variants. A Well has its own ID, parent, contents and quantity. This is a pinned
historical model reference; it does not establish compatibility with every
current or future SDK/V3 response variant.

The fixture deliberately includes observations requiring interpretation: an
empty movable tube, zero, exact decimal and exponent tokens, an unsafe integer
with count units, a non-volume deprecated-volume value, an omitted parent and
contents, an unknown amount, two entities sharing one container quantity and
contradictory quantity observations. Nothing in source inspection creates
stock, chooses a mixture member, infers dimensions from names or grants local
authority. Live Benchling access and physical import remain separate acceptance
workflows.
