import { expect, it } from 'vitest';
import {
  editMolViewSpecPresentation,
  ensureMolViewSpecViewIds,
  molViewSpecStorySteps,
  preserveUneditedMolViewSpecSnapshots,
} from './molViewSpecStory';
import { molViewSpecColorGroups } from '../molstar/molViewSpecLegend';
const overview = {
  metadata: { title: 'Whole molecule' },
  root: { kind: 'root', children: [{ kind: 'focus', params: { radius: 20 } }] },
};
const detail = {
  metadata: { title: 'Binding pocket' },
  root: { kind: 'root', children: [{ kind: 'focus', params: { radius: 5 } }] },
};
const story = JSON.stringify({
  kind: 'multiple',
  metadata: { version: '1' },
  snapshots: [overview, detail],
});

it.each([undefined, 'edit-current', 'add', 'replace'] as const)(
  'reports malformed input as an invalid scene before applying action %s',
  (action) => {
    expect(() => editMolViewSpecPresentation(story, '{bad', action, 1)).toThrowError(
      expect.objectContaining({ code: 'MVS_INVALID_SCENE', stateChanged: false })
    );
  }
);

it('retains a named view identity through edits, additions and reordering', () => {
  const initial = JSON.parse(ensureMolViewSpecViewIds(story));
  const ids = initial.snapshots.map((step: { metadata: { key: string } }) => step.metadata.key);
  expect(new Set(ids).size).toBe(2);
  const proposed = JSON.stringify({
    kind: 'single',
    metadata: { title: 'Renamed', key: 'replacement-id' },
    root: { kind: 'root' },
  });
  const edited = JSON.parse(
    editMolViewSpecPresentation(JSON.stringify(initial), proposed, 'edit-current', 1).scene
  );
  expect(edited.snapshots[0]).toEqual(initial.snapshots[0]);
  expect(edited.snapshots[1].metadata.key).toBe(ids[1]);
  const added = JSON.parse(
    editMolViewSpecPresentation(JSON.stringify(edited), proposed, 'add', 1).scene
  );
  expect(added.snapshots[2].metadata.key).not.toBe(ids[1]);
  expect(added.snapshots[2].metadata.key).not.toBe('replacement-id');
  added.snapshots.reverse();
  const reordered = molViewSpecStorySteps(ensureMolViewSpecViewIds(JSON.stringify(added)));
  expect(reordered[1].id).toBe(ids[1]);
  expect(reordered[2].id).toBe(ids[0]);
});

it('rejects duplicate named-view identities rather than guessing by position', () => {
  const duplicate = JSON.parse(story);
  for (const step of duplicate.snapshots) step.metadata.key = 'same-view';
  expect(() => ensureMolViewSpecViewIds(JSON.stringify(duplicate))).toThrow(/unique|duplicate/i);
});

it('retains a selection ID when its label and color change without changing its molecular target', () => {
  const scene = (label: string, color: string) =>
    JSON.stringify({
      kind: 'single',
      root: {
        kind: 'root',
        children: [
          {
            kind: 'component',
            params: { selector: { label_asym_id: 'A' } },
            children: [
              {
                kind: 'representation',
                params: { type: 'cartoon' },
                children: [
                  { kind: 'color', params: { color }, custom: { dnaforge_legend_label: label } },
                ],
              },
            ],
          },
        ],
      },
    });
  const initial = editMolViewSpecPresentation('', scene('Pocket', '#ff0000'), undefined, 0);
  const id = molViewSpecColorGroups(initial.scene, 0)[0].id;
  const proposed = JSON.parse(scene('Catalytic region', '#0000ff'));
  proposed.root.children[0].children[0].children[0].custom.dnaforge_selection_id =
    'accidental-new-id';
  const edited = editMolViewSpecPresentation(
    initial.scene,
    JSON.stringify(proposed),
    'edit-current',
    0
  );
  const group = molViewSpecColorGroups(edited.scene, 0)[0];
  expect(group.id).toBe(id);
  expect(group.label).toBe('Catalytic region');
});

it('treats an omitted action as an edit of the current perspective in an existing story', () => {
  const proposed = JSON.stringify({
    kind: 'single',
    metadata: { title: 'Updated pocket' },
    root: { kind: 'root', children: [] },
  });
  const edited = editMolViewSpecPresentation(story, proposed, undefined, 1);
  expect(edited.action).toBe('edit-current');
  expect(JSON.parse(edited.scene).snapshots[0]).toEqual(overview);
  expect(JSON.parse(edited.scene).snapshots).toHaveLength(2);
  const compiled = preserveUneditedMolViewSpecSnapshots(story, proposed, undefined, 1);
  expect(JSON.parse(compiled).snapshots[0]).toEqual(overview);
  expect(JSON.parse(compiled).snapshots[1].metadata.title).toBe('Updated pocket');
});

it('rejects an omitted full-story replacement while retaining explicit replacements and initial stories', () => {
  expect(() => editMolViewSpecPresentation(story, story, undefined, 1)).toThrow(/replace/i);
  expect(() => preserveUneditedMolViewSpecSnapshots(story, story, undefined, 1)).toThrow(
    /replace/i
  );
  expect(editMolViewSpecPresentation(story, story, 'replace', 0).action).toBe('replace');
  expect(
    JSON.parse(editMolViewSpecPresentation('', story, undefined, 0).scene).snapshots
  ).toHaveLength(2);
});
it('edits only the active named perspective and preserves the other perspective', () => {
  const revised = JSON.stringify({
    kind: 'single',
    metadata: { title: 'Revised pocket' },
    root: { kind: 'root', children: [] },
  });
  const result = editMolViewSpecPresentation(story, revised, 'edit-current', 1);
  const parsed = JSON.parse(result.scene);
  expect(parsed.snapshots[0]).toEqual(overview);
  expect(parsed.snapshots[1].metadata.title).toBe('Revised pocket');
  expect(result.activeIndex).toBe(1);
});
it('adds a named perspective without replacing earlier perspectives and rejects an ambiguous multi-view edit', () => {
  const extra = JSON.stringify({
    kind: 'single',
    metadata: { title: 'Other side' },
    root: { kind: 'root' },
  });
  const result = editMolViewSpecPresentation(story, extra, 'add', 0);
  expect(JSON.parse(result.scene).snapshots.slice(0, 2)).toEqual([overview, detail]);
  expect(result.activeIndex).toBe(2);
  expect(() => editMolViewSpecPresentation(story, story, 'edit-current', 1)).toThrow(/single|one/i);
});

it('does not let full-scene normalization rewrite the unedited perspective', () => {
  const compiled = JSON.parse(story);
  compiled.snapshots[0].root.children[0].params = { radius: 20, ignoreHydrogens: true };
  compiled.snapshots[1].root.children[0].params.radius = 8;
  const result = preserveUneditedMolViewSpecSnapshots(
    story,
    JSON.stringify(compiled),
    'edit-current',
    1
  );
  expect(JSON.parse(result).snapshots[0]).toEqual(overview);
  expect(JSON.parse(result).snapshots[1]).toEqual(compiled.snapshots[1]);
});
