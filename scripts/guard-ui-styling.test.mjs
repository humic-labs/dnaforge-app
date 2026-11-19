import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDesktopUiStyling, checkDesktopUiStylingChange } from './guard-ui-styling.mjs';

test('rejects asynchronous metadata filters that retain every entry', () => {
  const path = 'apps/desktop/src/features/example/Picker.tsx';
  const source =
    "import {MenuRow} from '@waypoint/ui-components'; <MenuRow {...Object.fromEntries(Object.entries(data).filter(async ([key]) => key.startsWith('data-')))} />";
  assert.ok(checkDesktopUiStyling({ files: new Map([[path, source]]) }).length);
});

const sourcePath = 'apps/desktop/src/features/example/Example.tsx';
const cssPath = 'apps/desktop/src/features/example/example.css';
const scan = (source, path = sourcePath, options = {}) =>
  checkDesktopUiStyling({ files: new Map([[path, source]]), ...options });
const rejected = (source, path = sourcePath) => {
  const violations = scan(source, path);
  assert.ok(violations.length > 0, `competing appearance was accepted: ${source}`);
  assert.ok(violations.every((v) => v.path && v.rule && v.fix));
  return violations;
};

test('rejects published terminal metrics under original and unrelated selector names', () => {
  for (const selector of [
    '.dnaforge-terminal-sidebar-tabs .dnaforge-terminal-tab-row',
    '.new-widget',
  ]) {
    const violations = rejected(
      `${selector} { padding: 5px; gap: 3px; font-size: 12px; }`,
      cssPath
    );
    for (const property of ['padding', 'gap', 'font-size'])
      assert.ok(
        violations.some((v) => v.property === property),
        property
      );
  }
});

test('rejects literals hidden in functions, fallbacks and private metric aliases', () => {
  for (const source of [
    '.row { padding: calc(var(--space-1) + 5px); }',
    '.row { padding: var(--space-1, 5px); }',
    '.row { --private-padding: 5px; padding: var(--private-padding); }',
    '.row { font-size: calc(var(--text-xs) + 1px); }',
  ])
    rejected(source, cssPath);
});

test('rejects private JSX appearance, arbitrary utilities and descendant overrides', () => {
  for (const source of [
    '<div style={{ fontSize: 11, padding: 5 }} />',
    '<div className="text-[11px] p-[5px]" />',
    '<div className="hover:text-[11px] [&_button]:p-[5px]" />',
    '<div className="[padding:5px]" />',
  ])
    rejected(source);
  rejected('.wrapper button { padding: var(--space-1); }', cssPath);
});

test('ordinary controls consume the canonical owner rather than copied or unknown classes', () => {
  rejected(
    '<button className="rounded-md border border-transparent px-3 py-2 text-xs">Run</button>'
  );
  rejected('<button role="tab" className={makeClasses()}>Run</button>');
  rejected('<div role="button" tabIndex={0} className="text-xs">Run</div>');
  assert.deepEqual(
    scan(
      "import { Button as Action } from '../../components/ui'; <Action onClick={run}>Run</Action>"
    ),
    []
  );
  assert.deepEqual(
    scan(
      "import { UI_SECONDARY_BUTTON_CLASS as action } from '../../components/ui/styles'; <button className={action} onClick={run}>Run</button>"
    ),
    []
  );
  rejected(
    '<button style={{ padding: 5 }}>Run</button>',
    'apps/desktop/src/components/ui/Unregistered.tsx'
  );
});

test('rejects shared-control overrides through aliases and object spreads', () => {
  for (const source of [
    "import { Button as Action } from '../../components/ui'; <Action style={{ padding: 5 }}>Run</Action>",
    "import { Button } from '../../components/ui'; <Button className='competing'>Run</Button>",
    "import { TextField } from '../../components/ui'; const props = { style: { fontSize: 11 } }; <TextField {...props} />",
    "import { Button } from '../../components/ui'; <Button {...unknownProps}>Run</Button>",
  ])
    rejected(source);
});

test('accepts theme-backed wrapper layout and actual scientific/native geometry', () => {
  assert.deepEqual(
    scan(
      '.layout { display: grid; grid-template-columns: minmax(0, 1fr) 1fr; gap: var(--space-1); color: hsl(var(--color-fg)); }',
      cssPath
    ),
    []
  );
  assert.deepEqual(
    scan(
      '<><canvas width={1024} height={768} /><svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z" /></svg></>'
    ),
    []
  );
  rejected(
    '<button className="p-[5px]">Configure</button>',
    'apps/desktop/src/features/sequence/NewToolbar.tsx'
  );
});

test('canonical wrapper classes compose without authorizing competing native controls', () => {
  assert.deepEqual(
    scan(
      "import { UI_NAVIGATION_HEADER_CLASS as header } from '../../components/ui/styles'; <header className={header} />"
    ),
    []
  );
  assert.deepEqual(
    scan(
      "import { UI_NAVIGATION_PANEL_CLASS as panel } from '../../components/ui/styles'; <div className={active ? panel : 'legacy-layout'} />"
    ),
    []
  );
  rejected(
    "import { UI_CONTENT_WIDTH_CLASS } from '../../components/ui/styles'; <button className={UI_CONTENT_WIDTH_CLASS}>Run</button>"
  );
  assert.deepEqual(
    scan(
      'export function Glyph({className}) { return <svg className={className}><path d="M0 0h1" /></svg>; }',
      'apps/desktop/src/components/icons/glyphs.tsx'
    ),
    []
  );
  rejected(
    'export function Glyph({className}) { return <button className={className}>Run</button>; }',
    'apps/desktop/src/components/icons/glyphs.tsx'
  );
  rejected('<Glyph className="p-[5px]" />');
});

test('exact existing debt cannot be exchanged for another violation or increased', () => {
  const source = '.legacy { padding: 5px; }';
  const findings = scan(source, cssPath);
  assert.ok(findings.length > 0);
  assert.ok(findings.every((v) => typeof v.fingerprint === 'string' && v.fingerprint.length > 0));
  const debt = findings.map((v) => v.fingerprint);
  assert.deepEqual(
    scan('.legacy {\n  padding: 5px;\n}', cssPath, { allowedDebt: debt, previousDebt: debt }),
    []
  );
  const changed = '.legacy { padding: 7px; }';
  assert.ok(scan(changed, cssPath, { allowedDebt: debt, previousDebt: debt }).length > 0);
  const added = scan(changed, cssPath).map((v) => v.fingerprint);
  assert.ok(
    scan(changed, cssPath, { allowedDebt: [...debt, ...added], previousDebt: debt }).length > 0
  );
});

test('the reported sidebar metric remains forbidden even when supplied as existing debt', () => {
  const path = 'apps/desktop/src/features/terminal/terminal.css';
  const files = new Map([
    [path, '.dnaforge-terminal-sidebar-tabs .dnaforge-terminal-tab-row { padding: 5px; }'],
  ]);
  const findings = checkDesktopUiStyling({ files });
  assert.ok(findings.some((finding) => finding.property === 'padding'));
  const debt = findings.map((finding) => finding.fingerprint);
  assert.ok(
    checkDesktopUiStyling({ files, allowedDebt: debt, previousDebt: debt }).some(
      (finding) => finding.property === 'padding'
    )
  );
});

test('existing JSX debt belongs to its original control and semantic owner', () => {
  const original =
    "function Legacy(){return <button data-testid='legacy-action' className='legacy-action'>Run</button>}";
  const debt = scan(original).map((finding) => finding.fingerprint);
  assert.ok(debt.length > 0);
  const options = { allowedDebt: debt, previousDebt: debt };
  assert.deepEqual(
    scan(
      'function Legacy() {\n return <button data-testid="legacy-action" className="legacy-action">Run</button>;\n}',
      sourcePath,
      options
    ),
    []
  );
  for (const replacement of [
    "function Replacement(){return <button data-testid='legacy-action' className='legacy-action'>Run</button>}",
    "function Legacy(){return <button data-testid='replacement-action' className='legacy-action'>Run</button>}",
  ]) {
    assert.ok(scan(replacement, sourcePath, options).length > 0);
  }
});

test('feature CSS cannot override canonical navigation density through tokens or geometry', () => {
  for (const source of [
    '[data-ui-navigation-row] { padding: var(--space-2); }',
    '[data-ui-navigation-row] { min-height: 79px; }',
    '[data-ui-navigation-detail] { white-space: normal; }',
    '.wrapper button { height: 79px; }',
  ])
    rejected(source, cssPath);
  assert.deepEqual(
    scan('.layout { min-height: 79px; width: 100%; } canvas { height: 768px; }', cssPath),
    []
  );
});

test('invalid production styling cannot silently skip analysis', () => {
  const violations = scan('.row { padding:', cssPath);
  assert.ok(violations.length > 0);
  assert.ok(violations.some((v) => /parse/i.test(v.rule)));
});

test('resolved merges preserve unchanged incoming styling debt and reject new styling', () => {
  const inherited = '<button className="rounded border px-2 py-1">Restore</button>';
  const incoming = new Map([[sourcePath, inherited]]);
  assert.deepEqual(
    checkDesktopUiStylingChange({ before: new Map(), after: incoming, incoming }),
    []
  );
  const changed = new Map([[sourcePath, inherited.replace('px-2', 'px-3')]]);
  assert.ok(
    checkDesktopUiStylingChange({ before: new Map(), after: changed, incoming }).length > 0
  );
  assert.ok(checkDesktopUiStylingChange({ before: new Map(), after: incoming }).length > 0);
});

{
  const path = 'apps/desktop/src/features/example/Example.tsx';
  const old = '<button className="p-1 text-fg-muted hover:bg-bg-muted">Run</button>';
  const migrated = '<button className="p-1 text-fg-muted wp-interactive">Run</button>';
  const shared = "import { INTERACTION_CLASS } from '@waypoint/ui-components';";
  const change = (a, b) =>
    checkDesktopUiStylingChange({ before: new Map([[path, a]]), after: new Map([[path, b]]) });

  test('moves only interaction appearance to the shared owner', () => {
    assert.deepEqual(change(old, migrated), []);
    assert.deepEqual(
      change(
        old,
        shared + '<button className={`${INTERACTION_CLASS} p-1 text-fg-muted`}>Run</button>'
      ),
      []
    );
    assert.deepEqual(
      change(
        '<button className="p-1">Run</button>',
        '<button className="p-1 wp-interactive">Run</button>'
      ),
      []
    );
  });

  test('retains geometry, semantic color and exact conditional requirements', () => {
    for (const after of [
      migrated.replace('p-1', 'p-2'),
      migrated.replace('text-fg-muted', 'text-accent'),
      migrated.replace('wp-interactive', 'wp-interactive hover:bg-bg'),
    ])
      assert.ok(change(old, after).length);
    const before =
      '<button className={selected ? "text-accent" : "hover:bg-bg-muted text-fg"}>Run</button>';
    assert.ok(
      change(
        before,
        '<button className={!selected ? "text-accent" : "wp-interactive text-fg"}>Run</button>'
      ).length
    );
  });

  test('does not let new or duplicated controls inherit another control debt', () => {
    assert.ok(change('', migrated).length);
    assert.ok(change(old, `<>${migrated}${migrated}</>`).length);
    assert.ok(change(old, `<>${old}${migrated}</>`).length);
    assert.ok(change(old, migrated.replace('Run', 'Stop')).length);
  });

  test('resolves the package export and refuses a same-named private helper', () => {
    const after = '<button className={`${INTERACTION_CLASS} p-1 text-fg-muted`}>Run</button>';
    assert.ok(change(old, "import { INTERACTION_CLASS } from './private';" + after).length);
    assert.ok(change(old, shared + after.replace('p-1', 'p-[5px]')).length);
  });

  test('canonical menu roles keep the shared owner and reject overrides', () => {
    const prefix = "import { MenuRow } from '@waypoint/ui-components';";
    const scan = (source) => checkDesktopUiStyling({ files: new Map([[path, source]]) });
    assert.deepEqual(scan(prefix + '<MenuRow role="menuitem">Run</MenuRow>'), []);
    for (const props of ['className="p-4"', 'style={{padding:4}}', '{...unknown}'])
      assert.ok(scan(prefix + `<MenuRow role="menuitem" ${props}>Run</MenuRow>`).length);
  });

  test('retains unresolved pre-existing wrapper composition only for exact shared migration', () => {
    const before = '<button className={`p-1 hover:bg-bg-muted ${className}`}>Run</button>';
    const after =
      shared + '<button className={`${INTERACTION_CLASS} p-1 ${className}`}>Run</button>';
    assert.deepEqual(change(before, after), []);
    for (const source of [
      after.replace('p-1', 'p-2'),
      after.replace('${className}', '${other}'),
      after.replace('p-1', 'p-1 hover:bg-error'),
    ])
      assert.ok(change(before, source).length);
    assert.ok(change('', after).length);
  });

  test('recognizes authoritative appbar class and interaction tokens only', () => {
    const scan = (source) => checkDesktopUiStyling({ files: new Map([[path, source]]) });
    assert.deepEqual(
      scan(
        "import { UI_APPBAR_ACTION_CLASS } from '../../components/ui/styles';<button className={UI_APPBAR_ACTION_CLASS}>Run</button>"
      ),
      []
    );
    assert.ok(
      scan(
        "import { UI_APPBAR_ACTION_CLASS } from './private';<button className={UI_APPBAR_ACTION_CLASS}>Run</button>"
      ).length
    );
    const css = (source) =>
      checkDesktopUiStyling({
        files: new Map([['apps/desktop/src/features/example.css', source]]),
      });
    assert.deepEqual(
      css(
        '.item:hover {background:var(--interaction-hover);color:var(--interaction-hover-foreground)}'
      ),
      []
    );
    assert.ok(css('.item:hover {background:var(--private-hover)}').length);
  });

  test('inspects both branches of inline placement without admitting appearance', () => {
    const scan = (source) => checkDesktopUiStyling({ files: new Map([[path, source]]) });
    assert.deepEqual(scan('<div style={{...(left ? {left: x} : {right: x}), top: y}} />'), []);
    assert.ok(scan('<div style={{...(left ? {left: x} : {padding: 7}), top: y}} />').length);
    assert.ok(scan('<div style={{...(left ? {left: x} : unknown), top: y}} />').length);
    assert.ok(
      scan('<div {...(enabled ? {role: "presentation"} : {role:"button",className:"p-8"})} />')
        .length
    );
  });

  test('migrates selected or active appearance only with the exact state condition', () => {
    const before =
      '<button className={`p-1 hover:bg-bg-muted ${chosen ? "bg-accent/15 text-accent" : "text-fg"}`}>Run</button>';
    const after =
      shared + '<button data-selected={chosen} className={`${INTERACTION_CLASS} p-1`}>Run</button>';
    assert.deepEqual(change(before, after), []);
    for (const source of [
      after.replace('{chosen}', '{!chosen}'),
      after.replace('{chosen}', '{other}'),
      after.replace('p-1', 'p-2'),
      after.replace('data-selected={chosen}', ''),
      after.replace('p-1', 'p-1 text-error'),
    ])
      assert.ok(change(before, source).length);
    assert.ok(change(before.replace('text-accent', 'text-error'), after).length);
    assert.ok(change(before.replace('bg-accent/15', 'bg-error'), after).length);
    assert.ok(change(old, after).length);
    const retainedBefore =
      '<button className={`p-1 ${chosen ? "bg-accent/15 text-fg" : "text-fg-muted hover:bg-bg-muted"}`}>Run</button>';
    const retainedAfter =
      shared +
      '<button data-selected={chosen} className={`${INTERACTION_CLASS} p-1 ${chosen ? "text-fg" : "text-fg-muted"}`}>Run</button>';
    assert.deepEqual(change(retainedBefore, retainedAfter), []);
    assert.ok(
      change(retainedBefore, retainedAfter.replace('text-fg-muted', 'text-warning')).length
    );
    const activeBefore =
      '<button className={`p-1 ${active ? "bg-bg-muted ring-1 ring-inset ring-accent/40" : ""}`}>Run</button>';
    const activeAfter = '<button data-active={active} className="p-1 wp-interactive">Run</button>';
    assert.deepEqual(change(activeBefore, activeAfter), []);
    assert.ok(change(activeBefore, activeAfter.replace('{active}', '{selected}')).length);
  });

  test('retains conditional appearance unless state actually moves, and consumes migration once', () => {
    const before =
      '<button className={`p-1 ${chosen ? "bg-accent/15" : "hover:bg-bg-muted"}`}>Run</button>';
    const kept = before.replace('p-1', 'p-1 wp-interactive');
    const moved = '<button data-selected={chosen} className="p-1 wp-interactive">Run</button>';
    assert.deepEqual(change(before, kept), []);
    assert.ok(change(before, `<>${kept}${moved}</>`).length);
    assert.ok(change(before, `<>${moved}${kept}</>`).length);
  });

  test('preserves pre-existing state attributes when only hover ownership changes', () => {
    const before = '<button data-active={active} className="p-1 hover:bg-bg-muted">Run</button>';
    assert.deepEqual(change(before, before.replace('hover:bg-bg-muted', 'wp-interactive')), []);
    assert.ok(
      change(
        before,
        before.replace('hover:bg-bg-muted', 'wp-interactive').replace('{active}', '{other}')
      ).length
    );
  });

  test('keeps an existing active indicator and its conditional text colors', () => {
    const before =
      '<button data-active={active} className={`p-1 ${active ? "text-accent" : "text-fg-muted hover:bg-bg-muted"}`}>Run</button>';
    const after = before.replace('hover:bg-bg-muted', 'wp-interactive');
    assert.deepEqual(change(before, after), []);
    assert.ok(change(before, after.replace('text-accent', 'text-warning')).length);
  });
}

{
  const path = 'apps/desktop/src/features/example/Example.tsx';
  const change = (before, after, p = path) =>
    checkDesktopUiStylingChange({ before: new Map([[p, before]]), after: new Map([[p, after]]) });
  const moved = (control, owner = 'Picker') =>
    `function ${owner}(){const content=(<div>${control}</div>);return content;}`;
  const original = (control) => `function Picker(){return <div>${control}</div>;}`;

  test('preserves an unchanged control moved into local JSX content once within its owner', () => {
    const control = '<input type="checkbox" checked={checked} onChange={change} />';
    assert.deepEqual(change(original(control), moved(control)), []);
    assert.ok(change(original(control), moved(control, 'Other')).length);
    assert.ok(change(original(control), moved(control + control)).length);
    assert.ok(
      change(original(control), moved(control.replace('type="checkbox"', 'type="radio"'))).length
    );
    assert.ok(change(original(control), moved(control.replace('/>', 'className="p-4" />'))).length);
  });

  test('matches relocated interaction ownership without accepting new resting appearance', () => {
    const before =
      '<button aria-label="Close" className="h-8 rounded hover:bg-bg-muted">Close</button>';
    const after = before.replace('hover:bg-bg-muted', 'wp-interactive');
    assert.deepEqual(change(original(before), moved(after)), []);
    for (const modified of [
      after.replace('h-8', 'h-9'),
      after.replace('Close', 'Remove'),
      after.replace('wp-interactive', 'wp-interactive hover:bg-error'),
    ])
      assert.ok(change(original(before), moved(modified)).length);
    assert.ok(change(original(before), moved(after + after)).length);
  });

  test('retains an existing text input appearance across a combobox role addition only', () => {
    const before = '<input type="text" data-testid="name" className="border border-border px-2" />';
    const after = before.replace('<input', '<input role="combobox"');
    assert.deepEqual(change(original(before), original(after)), []);
    for (const altered of [
      after.replace('px-2', 'px-4'),
      after.replace('combobox', 'button'),
      after.replace('data-testid="name"', 'data-testid="other"'),
    ])
      assert.ok(change(original(before), original(altered)).length);
    assert.ok(change('', original(after)).length);
  });

  test('allows only structural listbox layout inside the actual shared surface', () => {
    const prefix = "import {MenuSurface} from '@waypoint/ui-components';";
    const list = '<div role="listbox" className="mt-2 max-h-64 overflow-y-auto" />';
    assert.deepEqual(change('', prefix + `<MenuSurface>${list}</MenuSurface>`), []);
    assert.ok(change('', list).length);
    for (const bad of [
      list.replace('mt-2', 'bg-bg'),
      list.replace('/>', 'onClick={run} />'),
      list.replace('/>', 'style={{color:"red"}} />'),
      list.replace('listbox', 'option'),
    ])
      assert.ok(change('', prefix + `<MenuSurface>${bad}</MenuSurface>`).length);
    assert.ok(
      change(
        '',
        prefix.replace('@waypoint/ui-components', './private') +
          `<MenuSurface>${list}</MenuSurface>`
      ).length
    );
  });

  test('recognizes a data-only entry filter but rejects arbitrary or shadowed spreads', () => {
    const filter =
      "Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => key.startsWith('data-')))";
    const prefix = "import {MenuRow} from '@waypoint/ui-components';";
    assert.deepEqual(change('', prefix + `<MenuRow {...${filter}} />`), []);
    for (const source of [
      filter.replace('data-', 'class'),
      filter.replace("key.startsWith('data-')", 'allowed(key)'),
      filter.replace("key.startsWith('data-')", 'true'),
      filter.replace('([key])', '([value])'),
    ])
      assert.ok(change('', prefix + `<MenuRow {...${source}} />`).length);
    assert.ok(change('', prefix + `const Object=other;<MenuRow {...${filter}} />`).length);
    assert.ok(
      change('', prefix + `function Row(Object){return <MenuRow {...${filter}} />}`).length
    );
    assert.ok(change('', prefix + '<MenuRow {...unknown} />').length);
  });

  test('migrates only an existing neutral hover color to its exact shared token', () => {
    const p = 'apps/desktop/src/features/example/example.css';
    const before = '.header > button:hover { color:hsl(var(--color-fg)); }';
    const after = '.header > button:hover { color:var(--interaction-hover-foreground); }';
    assert.deepEqual(change(before, after, p), []);
    assert.ok(change('', after, p).length);
    for (const altered of [
      after.replace('.header', '.other'),
      after.replace('--interaction-hover-foreground', '--private'),
      after.replace('foreground)', 'foreground, red)'),
      after.replace('color:', 'background:'),
      after + after,
    ])
      assert.ok(change(before, altered, p).length);
    assert.ok(change(before.replace('--color-fg', '--color-error'), after, p).length);
  });

  test('preserves an existing scientific color expression moved into a JSX label without widening it', () => {
    const before =
      'function Picker(){return colors.map(c => <span key={c} style={{backgroundColor:c}} />)}';
    const after =
      'function Picker(){return colors.map(c => ({label:<span key={c} style={{backgroundColor:c}} />}))}';
    assert.deepEqual(change(before, after), []);
    for (const altered of [
      after.replace('backgroundColor:c', 'backgroundColor:other'),
      after.replace('backgroundColor:c', 'padding:99'),
      after.replace('key={c}', 'key={other}'),
      after.replace('function Picker', 'function Other'),
    ])
      assert.ok(change(before, altered).length);
    assert.ok(change('', after).length);
    const doubled =
      'function Picker(){return colors.map(c => ({label:<><span key={c} style={{backgroundColor:c}} /><span key={c} style={{backgroundColor:c}} /></>}))}';
    assert.ok(change(before, doubled).length);
  });

  test('rejects data filters when Object is rebound through destructuring', () => {
    const spread =
      "Object.fromEntries(Object.entries(data).filter(([key]) => key.startsWith('data-')))";
    const row = `<MenuRow {...${spread}} />`;
    const prefix = "import {MenuRow} from '@waypoint/ui-components';";
    for (const source of [
      `function Row({Object}){return ${row}}`,
      `const {Object}=value;${row}`,
      `const {value:Object}=other;${row}`,
    ])
      assert.ok(change('', prefix + source).length);
  });
}

{
  const hosts = [
    'apps/desktop/src/features/example/Picker.tsx',
    'packages/ui/components/src/example/Picker.tsx',
  ];
  const scan = (path, source) => checkDesktopUiStyling({ files: new Map([[path, source]]) });
  const change = (path, before, after) =>
    checkDesktopUiStylingChange({
      before: new Map([[path, before]]),
      after: new Map([[path, after]]),
    });
  for (const path of hosts) {
    test(`rejects competing rows and caller appearance in ${path}`, () => {
      const imported =
        "import {MenuRow,MenuTrigger,MenuSurface} from '@waypoint/ui-components/menu';";
      assert.deepEqual(
        scan(
          path,
          imported +
            '<MenuSurface><MenuRow label="Open" /><MenuTrigger label="Choose" /></MenuSurface>'
        ),
        []
      );
      for (const source of [
        '<button role="menuitem" className="p-2 hover:bg-gray-200">Open</button>',
        ...['MenuRow', 'MenuTrigger', 'MenuSurface'].flatMap((tag) => [
          `<${tag} className="p-99" />`,
          `<${tag} style={{padding:99}} />`,
          `<${tag} {...unknown} />`,
        ]),
      ])
        assert.ok(scan(path, imported + source).length, source);
    });
    test(`preserves unchanged scientific colors without accepting changed values in ${path}`, () => {
      const before = 'const swatch=<span style={{backgroundColor:color}} />;';
      assert.deepEqual(change(path, before, before), []);
      assert.ok(change(path, before, before.replace('backgroundColor:color', 'padding:99')).length);
    });
    test(`rejects independent menu CSS in ${path}`, () => {
      const css = path.replace(/\.tsx$/, '.css');
      for (const source of [
        '.wp-menu-row {padding:99px}',
        '[role="menuitem"]:hover{background:red}',
        '.private-menu:hover{background:var(--interaction-hover-background)}',
      ])
        assert.ok(scan(css, source).length, source);
    });
  }
}

test('resolves shared-package relative imports to the declared presentation owner', () => {
  const path = 'packages/ui/components/src/example/Picker.tsx';
  const scan = (source) => checkDesktopUiStyling({ files: new Map([[path, source]]) });
  assert.deepEqual(
    scan('import {MenuRow} from \'../menu/presentation\'; <MenuRow label="Open" />'),
    []
  );
  assert.ok(
    scan(
      'import {MenuRow} from \'../private/presentation\'; <MenuRow role="menuitem" className="p-99" />'
    ).length
  );
});
