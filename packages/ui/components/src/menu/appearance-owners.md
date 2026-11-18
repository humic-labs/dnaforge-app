# Appearance ownership

The menu module owns popup chrome, field and toolbar trigger geometry, row
slots, carets, checkmarks, captions, density and neutral interaction colors.
Feature content supplies labels, scientific data, option IDs and actions. It
does not supply a second menu padding, caret or hover recipe.

| Control family                               | Appearance owner                                                                             | Host responsibility                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Button, link and selection menu rows         | `MenuRow`, `MenuLink`, `MenuRowGroup`, `MenuRowAction`                                       | Native role, action, stable ID, selected and active state                                  |
| Menu shell and rich picker shell             | `MenuSurface`                                                                                | Typed `layout` sets placement and size; `content` selects menu, rich panel or form padding |
| Native select fields                         | `MenuNativeSelect`                                                                           | Native values, options, option groups, callbacks and a layout-only wrapper                 |
| Search and custom text fields within pickers | `MenuSearchInput`                                                                            | Query or draft value and input semantics                                                   |
| Shared compact filter controls               | `form-controls/CompactFilterSelect.tsx`, `CompactFilterMultiSelect.tsx`                      | Feature labels and domain selection                                                        |
| Sequence context actions                     | `context-menu/SequenceContextMenu.tsx`                                                       | Scientific capability gating and callback arguments                                        |
| Restriction enzyme picker                    | `restriction-enzymes/RestrictionEnzymeDropdown.tsx`, `EnzymeList.tsx`                        | Virtualized content and cut-site rendering                                                 |
| Desktop menus                                | `apps/desktop/src/components/PortalMenu.tsx`, `ActionMenu.tsx`, `components/ui/controls.tsx` | Presentation ownership, placement and focus policy                                         |
| Ordinary desktop buttons and rows            | `INTERACTION_CLASS` / `wp-interactive`; `components/ui/styles.ts` forwards it                | Existing layout, content and domain state                                                  |
| Public-hosted chrome                         | `apps/desktop/src/hosted/hosted.css`                                                         | Host layout; hover colors read `--interaction-*`                                           |

Paths below are relative to the repository root. They identify rendering
boundaries, not permission to create another ordinary menu or neutral hover
recipe.

## Domain rendering boundaries

| Boundary                           | Source owners                                                                                                                                                                                                                                                                                                                                  | What remains distinct                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scientific source and value colors | `apps/desktop/src/features/structure-drawer/components/structure-candidate-ui.tsx`, `StructureCandidatePicker.tsx`; `apps/desktop/src/features/assembly-panel/components/ProductSegmentCard.tsx`; `apps/desktop/src/components/ui/styles.ts` source-card tokens                                                                                | Blue/emerald source identity, segment type and validation colors, scientific preview selection                                                                  |
| Color swatches                     | `apps/desktop/src/features/page/components/ColorPalette.tsx`; `apps/desktop/src/features/sequence/components/IndexedViewerTrackGutter.tsx`; structure viewer color legends                                                                                                                                                                     | The displayed value is the color itself; focus and selected swatch indicators must not paint over it                                                            |
| Scientific selection               | `apps/desktop/src/features/sequence/components/annotations-drawer/VirtualAnnotationList.tsx`, `apps/desktop/src/features/sequence/components/annotations-drawer/annotation-fields.tsx`, `apps/desktop/src/features/sequence/components/AnnotationReviewPanel.tsx`; `apps/desktop/src/features/alignment-manager/panel/TrackMutationsPanel.tsx` | Committed biological selection and curation statuses remain separate from neutral pointer hover                                                                 |
| Numeric editors                    | `apps/desktop/src/features/primers/components/PrimerLengthField.tsx`; `apps/desktop/src/features/sequence/components/IndexedViewerTrackGutter.tsx`; `SequencePaneControls.tsx`, `SequenceMapPaneControls.tsx`; `apps/desktop/src/features/terminal/TerminalDimensions.tsx`                                                                     | Unit suffixes, scientific increments, constrained numeric geometry and native number semantics; they are not menus                                              |
| Inline document title              | `apps/desktop/src/features/scientific-document/ScientificDocumentTab.tsx`                                                                                                                                                                                                                                                                      | The title retains document typography and its inline editing underline                                                                                          |
| Scientific topology control        | `apps/desktop/src/index.css` `.sequence-map-topology-*`; sequence map controls                                                                                                                                                                                                                                                                 | The pointer moves a continuous scientific view control; marker and rail colors encode its position                                                              |
| Drag and resize feedback           | `apps/desktop/src/shared/components/tree/TreeRow.tsx`; `features/canvas/components/ResizeHandle.tsx`; `features/design/components/DesignDrawer.tsx`; `features/sequence/components/TrackGutter.tsx`; table, structure-viewer and terminal resizers                                                                                             | Drop targets, resize handles and drag previews are separate interaction states; neutral fills exclude `data-drop-active`                                        |
| Terminal rendering                 | `apps/desktop/src/features/terminal/terminal.css`, terminal command decorations and xterm themes                                                                                                                                                                                                                                               | Terminal canvas, command status decorations and completion selection retain terminal theme semantics; ordinary toolbar buttons use the shared interaction class |
| Animated annotation summary        | `apps/desktop/src/features/sequence/components/AnnotationTypePicker.tsx`                                                                                                                                                                                                                                                                       | Summary-to-panel motion and scientific chips retain their layout; popup chrome, caret, search and neutral controls use shared presentation                      |

## Other semantic appearances

Primary, destructive and status actions use accent, error, warning or success
semantics instead of neutral fills. Their theme color meanings remain separate.
The common owners include `apps/desktop/src/shared/components/Button.tsx`,
`apps/desktop/src/components/ui/styles.ts` and `components/toast-rules.ts`.
Feature status actions preserve those meanings in reference downloads, import
recovery, sequence review, job cancellation and terminal command status.

Text links and inline disclosure links retain text/underline feedback. These
include `components/SourceControlPanel.tsx`, `features/auth/AuthFlowHost.tsx`,
`features/sequence/components/ReferenceGenomePicker.tsx`,
`features/lims/components/registry/RegistryFilterPopover.tsx`, and document,
annotation and structure-viewer links. They do not define menu rows.

## Native and startup boundaries

- Native option popups belong to the operating system. Their visible trigger
  shell uses `MenuNativeSelect`.
- `apps/desktop/src/features/sequence/components/IndexedGenomeTabChrome.tsx`
  retains one `sr-only` native window-size select as an accessibility control;
  it has no visible dropdown shell.
- `apps/desktop/src/startup/blank-window-fallback.ts` and `StartupSurface.tsx`
  must render before the normal React/CSS application is available. Their small
  fallback controls remain self-contained.
- `apps/desktop/src/design-lab/import-picker/variants/VariantA.tsx` through
  `VariantJ.tsx` and `ImportPickerComparisonPage.tsx` are deliberately different
  design comparisons. They are not application menu implementations.

The host theme adapter changes token values once. It does not copy the menu
selectors, row slot markup or interaction reducer into each host.
