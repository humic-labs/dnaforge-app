import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';

export function createStylingChecker(profile = {}) {
  const ROOT = 'apps/desktop/src/';
  const THEME = `${ROOT}index.css`;
  const PACKAGE_ROOT = 'packages/ui/components/src/';
  const THEMES = [THEME, ...(profile.themes ?? [])];
  const SOURCE_ROOTS = [ROOT, PACKAGE_ROOT, ...(profile.roots ?? [])];
  const OWNERS = new Set([
    ...(profile.owners ?? []),
    `${PACKAGE_ROOT}menu/presentation.tsx`,
    `${PACKAGE_ROOT}menu/menu.css`,
    `${ROOT}components/ui/controls.tsx`,
    `${ROOT}components/ui/navigation.tsx`,
    `${ROOT}components/ui/styles.ts`,
    'apps/desktop/tailwind.config.ts',
  ]);
  const MODULES = new Set([
    ...(profile.controlModules ?? []),
    `${ROOT}components/ActionMenu`,
    `${ROOT}components/ui`,
    `${ROOT}components/ui/controls`,
    `${ROOT}components/ui/navigation`,
    `${ROOT}components/SettingsSubsection`,
  ]);
  const CONTROLS = new Set([
    ...(profile.controls ?? []),
    'ActionMenu',
    'Button',
    'TextField',
    'TextArea',
    'Select',
    'Switch',
    'SegmentedControl',
    'SettingsButton',
    'SettingsInput',
    'SettingsTextArea',
    'SettingsSelect',
    'SettingsSwitch',
    'NavigationRow',
    'NavigationList',
    'NavigationAction',
  ]);
  const CONTROL_CLASSES = new Set([
    'UI_DISCLOSURE_SUMMARY_CLASS',
    'UI_APPBAR_ACTION_CLASS',
    'selectableCardClass',
    'UI_PRIMARY_BUTTON_CLASS',
    'UI_SECONDARY_BUTTON_CLASS',
    'UI_DANGER_BUTTON_CLASS',
    'UI_FIELD_CLASS',
    'UI_READONLY_FIELD_CLASS',
    'UI_TEXTAREA_CLASS',
    'UI_SELECT_TRIGGER_CLASS',
    'UI_MENU_OPTION_CLASS',
    'segmentedOptionClass',
    'splitPanelTabClass',
  ]);
  const STYLE_MODULES = new Set([
    `${ROOT}components/ui`,
    `${ROOT}components/ui/styles`,
    ...(profile.styleModules ?? []),
  ]);
  const STYLE_HELPERS = new Set([
    'navigationStatusClass',
    'segmentedOptionClass',
    'splitPanelTabClass',
  ]);
  const SHARED_MENU_MODULES = new Set([
    '@waypoint/ui-components',
    '@waypoint/ui-components/menu',
    `${PACKAGE_ROOT}menu`,
    `${PACKAGE_ROOT}menu/presentation`,
    `${PACKAGE_ROOT}menu/appearance`,
  ]);
  const SHARED_MENU_CONTROLS = new Set([
    'MenuSurface',
    'MenuTrigger',
    'MenuRow',
    'MenuLink',
    'MenuRowGroup',
    'MenuRowAction',
    'MenuSearchInput',
    'MenuNativeSelect',
    'MenuSectionLabel',
    'MenuStatus',
    'MenuSeparator',
  ]);
  const NATIVE = new Set(['button', 'input', 'select', 'textarea', 'summary']);
  const ROLES = new Set([
    'button',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'switch',
    'checkbox',
    'radio',
    'slider',
    'spinbutton',
    'combobox',
    'listbox',
  ]);
  const GEOMETRY_ELEMENTS = new Set([
    'canvas',
    'svg',
    'path',
    'g',
    'text',
    'tspan',
    'circle',
    'ellipse',
    'rect',
    'line',
    'polyline',
    'polygon',
    'image',
    'use',
    'foreignObject',
  ]);
  const PROTECTED =
    /^(?:font(?:-.+)?|line-height|letter-spacing|word-spacing|text-indent|padding(?:-.+)?|margin(?:-.+)?|(?:row-|column-)?gap|border(?:-.+)?|outline(?:-.+)?|color|background(?:-color|-image)?|box-shadow|text-shadow|opacity|transition(?:-.+)?|animation(?:-.+)?)$/u;
  const CONTROL_GEOMETRY =
    /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|white-space|overflow-wrap|word-break|text-wrap(?:-mode|-style)?)$/u;
  const CONTROL_SELECTOR =
    /(?:^|[^\w-])(?:button|input|select|textarea|summary)(?![\w-])|\[\s*(?:role\s*[~|^$*]?=\s*["']?(?:button|tab|menuitem(?:checkbox|radio)?|option|switch|checkbox|radio|slider|spinbutton|combobox|listbox)|data-(?:ui|settings)-control\b|data-ui-navigation-(?:list|action|row|primary|title|metadata|status|detail|actions)\b)|(?:^|[\s>+~,(])\*(?=$|[\s>+~.#[:)])/iu;
  const COLORS =
    'bg bg-subtle bg-muted fg fg-muted fg-subtle border border-hover accent accent-fg accent-subtle success warning error oligo-special benchling-link code-keyword code-string code-literal code-variable tooltip-bg selection-fill selection-stroke viewer-bg viewer-chrome viewer-stroke viewer-stroke-light'.split(
      ' '
    );
  const DEFAULT_TOKENS = new Set([
    '--interaction-hover',
    '--interaction-hover-foreground',
    ...COLORS.map((name) => `--color-${name}`),
    ...['0', '1', '2', '3', '4', '5', '6', '8', '10', '12'].map((n) => `--space-${n}`),
    ...['xs', 'sm', 'base', 'lg'].map((name) => `--text-${name}`),
    ...['sans', 'mono', 'normal', 'medium', 'semibold'].map((name) => `--font-${name}`),
    ...['sm', 'md', 'lg', 'xl', 'full'].map((name) => `--radius-${name}`),
    ...['sm', 'md', 'lg'].map((name) => `--shadow-${name}`),
    ...['fast', 'normal', 'slow'].map((name) => `--duration-${name}`),
    ...['out', 'in-out', 'spring'].map((name) => `--ease-${name}`),
  ]);
  const KEYWORDS = new Set(
    'auto inherit initial unset revert revert-layer none normal transparent currentcolor solid dashed dotted double hidden collapse separate italic oblique all color background-color opacity transform border-color linear ease ease-in ease-out ease-in-out infinite alternate forwards backwards both running paused'.split(
      ' '
    )
  );
  const FIX =
    'Use the canonical shared control or components/ui/styles.ts; add a reusable pattern to that owner instead of private appearance.';
  const RETIRED_UI_STYLE_FINGERPRINTS = Object.freeze([
    '65efbc89df1d3aa475c1e2cc7356bef3012f907d77b482763ce084f390d45520',
    '778b2d9e5d69fbce26ac912cb1edf3ffeeceeeb31e1110218110ff0edbc7e0bd',
    '4687d2877520ebd47e9cb4c156a143ad39d22f02f736a8a599237e00c7195738',
    '4f59bbace77e36066e52af64150d94517934c1f59cc94106780409137d827ed3',
    '85752e246e111706d39258a225984aff6ee54b8dac78f6c79c20eaa8230d8244',
    '3d94b497eaf31795e48ee33720c4ff59141e12efa689f0afd8e7e5651a7eb7cc',
    '3dc8678c0f6d073eb0e3ec44293670e9bf0dfd1fcfd68cb237cee20afd072315',
    'e461d92738d56559ed2e35efdc38282d625b5d58a835291e6640ef9cdd8d9244',
    'ed40926c16f8a1214f03a2b4b0654c3bfb938a4fa054ab05ccde2b40886e46d3',
    'b6b78ef49b58dfcf75a73fe25259094a4f9ce0d21b2303a97a6a73ea5ddb4d6b',
    'cc4f568cfc94ad0ca2dd380a70bc42c1e5f7c26902ef5b83811884aac81c947c',
    'ccabd6948190f0372418bf60a25c334a5f6cca899e649d5cd4c241dcdb244069',
    '50cc3c056679edf56e42f3f9ee0846bcca566d29838c69d128efdd5b015ac661',
    'b9529b7c25bd3b68031e165e1d20f302c8afea904e99a3d5302d7fb74c8b14f3',
    '5eba9d65bcb3394bb9eb43b626849825bc0f7ca5647b00d2c4f7faf4684892a4',
    '7dc84f128fa90f4d346cd57f044a4c88626952be3871e9d48ea9689fed2b1755',
    'c696a259d6b9452db5025947fa2ae4d922776cbf942e1c12208be1afbde2fcec',
    'd853cfd51d1f449c3fe23843e48d3bf73806723ea6a1486e7bda6f9f8c397c93',
    '570fc64fa77373ace1b55bc583c0b93157713fa9ce368e37485156e438b8f19c',
    '54ba35e7f8af0a2ccc390b867b9ac987e0c3d5c5f97f4530cb2d32b9f4e0fbc6',
    '3e47f4a761314e92864497eaa604b7955000f6db76691d835d29b5a9972fbd44',
    '781fff694d7384c0d2118ff23e252bf319520941b7345b29f06eca8d601ee6e2',
    'cfa6fe46008005ddf533e7edb9d3004d5ad90b03992ee2d1e0dd60222c0fc44e',
    '84ac240d2d2ae6f6ad30b09c291bdffc1cff385395b29b29ca462ab5d88b181b',
    '6f7753993e216ab86504b1b80b565825309ffd33bb1197b5fbec82fbfbf53240',
    'fab51ccd86e7d0debf952ff5567186e95a75ee1a623714e8718d9a3b37bd2997',
  ]);
  const RETIRED = new Set(RETIRED_UI_STYLE_FINGERPRINTS);
  const RETIRED_SOURCE_PATHS = ['apps/desktop/src/features/terminal/terminal.css'];
  const normalize = (text) =>
    String(text)
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
  const kebab = (name) => name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
  const production = (path) =>
    (SOURCE_ROOTS.some((root) => path.startsWith(root)) ||
      path === 'apps/desktop/tailwind.config.ts') &&
    /\.(?:css|[cm]?[jt]sx?)$/u.test(path) &&
    !/(?:\.(?:test|spec|stories)\.|\/(?:__tests__|test|test-utils)\/)/u.test(path);

  function tokensFrom(files) {
    const tokens = new Set(DEFAULT_TOKENS);
    const source = THEMES.map((path) => files.get(path) ?? '').join('\n');
    if (!source) return tokens;
    try {
      postcss.parse(source).walkDecls((declaration) => {
        if (
          declaration.prop.startsWith('--') &&
          /^(?::root|\.dark)$/u.test(declaration.parent?.selector ?? '')
        )
          tokens.add(declaration.prop);
      });
    } catch {}
    return tokens;
  }

  function privateValue(value, tokens) {
    let text = normalize(value).replace(/\s*!important\s*$/iu, '');
    let theme = false;
    text = text.replace(/var\(\s*(--[\w-]+)\s*\)/gu, (match, token) => {
      if (!tokens.has(token)) return match;
      theme = true;
      return ' THEME ';
    });
    if (/var\s*\(/iu.test(text)) return true;
    if (/(?:#[\da-f]{3,8}\b|["'])/iu.test(text)) return true;
    text = text.replace(/(?:[\w-]+)\s*\(/gu, (call) =>
      /^(?:calc|min|max|clamp|hsl|hsla|rgb|rgba|linear-gradient|radial-gradient|color-mix)\s*\($/iu.test(
        call
      )
        ? '('
        : ' PRIVATE('
    );
    let invalid = false;
    text = text.replace(/(?<![\w-])-?(?:\d*\.\d+|\d+)(?:[a-z%]+)?/giu, (number) => {
      if (Number.parseFloat(number) !== 0) invalid = true;
      return ' ';
    });
    for (const word of text.match(/[a-z][\w-]*/giu) ?? [])
      if (word !== 'THEME' && !KEYWORDS.has(word.toLowerCase())) invalid = true;
    return invalid || (!theme && /^(?:hsl|hsla|rgb|rgba|color-mix)\s*\(/iu.test(value));
  }

  function cssContext(declaration) {
    const parents = [];
    for (let node = declaration.parent; node && node.type !== 'root'; node = node.parent)
      parents.unshift(
        node.type === 'atrule'
          ? `@${node.name} ${normalize(node.params)}`
          : normalize(node.selector)
      );
    return parents.join(' | ');
  }

  function analyzeCss(path, source, emit, tokens, geometry) {
    let tree;
    try {
      tree = postcss.parse(source, { from: path });
    } catch (error) {
      emit(
        'css-parse',
        '',
        error.reason ?? error.message,
        'stylesheet',
        error.line,
        error.column,
        'Repair the CSS syntax; styling analysis cannot skip invalid source.'
      );
      return;
    }
    tree.walkDecls((declaration) => {
      const property = declaration.prop.toLowerCase();
      const selector = declaration.parent?.selector ?? '';
      if (
        THEMES.includes(path) &&
        property.startsWith('--') &&
        /^(?::root|\.dark)$/u.test(selector)
      )
        return;
      const control = CONTROL_SELECTOR.test(selector);
      if (
        OWNERS.has(path) ||
        !(PROTECTED.test(property) || (control && CONTROL_GEOMETRY.test(property)))
      )
        return;
      const context = cssContext(declaration);
      const position = declaration.source?.start;
      if (control)
        emit(
          'control-css-override',
          property,
          declaration.value,
          context,
          position?.line,
          position?.column,
          FIX
        );
      else if (!geometry(property, { selector }) && privateValue(declaration.value, tokens))
        emit(
          'private-css-appearance',
          property,
          declaration.value,
          context,
          position?.line,
          position?.column,
          FIX
        );
    });
  }

  function modulePath(path, specifier) {
    const resolved = specifier.startsWith('.')
      ? posix.normalize(posix.join(posix.dirname(path), specifier))
      : specifier.startsWith('@/')
        ? `${(profile.aliases ?? []).find((alias) => path.startsWith(alias.sourceRoot))?.targetRoot ?? ROOT}${specifier.slice(2)}`
        : specifier;
    return resolved.replace(/\.(?:tsx?|jsx?)$/u, '').replace(/\/index$/u, '');
  }

  function unwrap(node) {
    while (
      node &&
      (ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isNonNullExpression(node))
    )
      node = node.expression;
    return node;
  }

  function analyzeTs(path, source, emit, tokens, geometry) {
    const kind = /\.[jt]sx$/u.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
    for (const diagnostic of file.parseDiagnostics) {
      const position = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      emit(
        'typescript-parse',
        '',
        ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        'source',
        position.line + 1,
        position.character + 1,
        'Repair the source syntax; styling analysis cannot skip invalid source.'
      );
    }
    if (file.parseDiagnostics.length || OWNERS.has(path)) return;
    const imports = new Map();
    const variables = new Map();
    const migrationContexts = new Map();
    let objectShadowed = false;
    const position = (node) => {
      const point = file.getLineAndCharacterOfPosition(node.getStart(file));
      return [point.line + 1, point.character + 1];
    };
    const expressionIdentity = (source) => {
      const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.JSX,
        source
      );
      const parts = [];
      for (
        let token = scanner.scan();
        token !== ts.SyntaxKind.EndOfFileToken;
        token = scanner.scan()
      )
        parts.push([
          token,
          token === ts.SyntaxKind.StringLiteral || token === ts.SyntaxKind.NumericLiteral
            ? scanner.getTokenValue()
            : scanner.getTokenText(),
        ]);
      return JSON.stringify(parts);
    };
    const add = (node, rule, property, value, context, fix = FIX, migrationNode) =>
      emit(
        rule,
        property,
        value,
        context,
        ...position(node),
        fix,
        expressionIdentity(value),
        migrationNode
          ? {
              context,
              preservedContext: migrationContexts.get(context) ?? context,
              valueIdentity: expressionIdentity(value),
              legacyInteraction: interactionIdentity(migrationNode, true, node),
              legacyStateInteraction: interactionIdentity(migrationNode, true, node, true),
              sharedInteraction: interactionIdentity(migrationNode, false, node),
              sharedStateInteraction: interactionIdentity(migrationNode, false, node, true),
            }
          : undefined
      );
    const collect = (node) => {
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isBindingElement(node) ||
          ts.isParameter(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isImportClause(node)) &&
        node.name?.getText(file) === 'Object'
      )
        objectShadowed = true;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const origin = modulePath(path, node.moduleSpecifier.text);
        const binding = node.importClause?.namedBindings;
        if (binding && ts.isNamedImports(binding))
          for (const element of binding.elements)
            imports.set(element.name.text, {
              origin,
              name: (element.propertyName ?? element.name).text,
            });
        if (binding && ts.isNamespaceImport(binding))
          imports.set(binding.name.text, { origin, namespace: true });
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        variables.set(
          node.name.text,
          variables.has(node.name.text) || !(node.parent.flags & ts.NodeFlags.Const)
            ? null
            : node.initializer
        );
      ts.forEachChild(node, collect);
    };
    collect(file);
    const resolveNode = (node, seen = new Set()) => {
      node = unwrap(node);
      if (node && ts.isIdentifier(node) && variables.has(node.text)) {
        if (seen.has(node.text)) return null;
        return resolveNode(variables.get(node.text), new Set([...seen, node.text]));
      }
      return node;
    };
    const bindingFor = (node) => {
      node = unwrap(node);
      if (node && ts.isIdentifier(node)) return imports.get(node.text);
      if (node && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const imported = imports.get(node.expression.text);
        return imported?.namespace ? { origin: imported.origin, name: node.name.text } : null;
      }
      return null;
    };
    const interactionIdentity = (value, legacy, owner, normalizeState = false) => {
      let found = false;
      while (owner && !ts.isJsxOpeningElement(owner) && !ts.isJsxSelfClosingElement(owner))
        owner = owner.parent;
      const stateConditions = new Set();
      if (owner) {
        for (const attribute of owner.attributes.properties) {
          if (
            !ts.isJsxAttribute(attribute) ||
            !['data-active', 'data-selected'].includes(attribute.name.getText(file))
          )
            continue;
          const expression = ts.isJsxExpression(attribute.initializer ?? {})
            ? attribute.initializer.expression
            : null;
          if (expression) stateConditions.add(expressionIdentity(expression.getText(file)));
        }
      }
      const stateAppearance =
        /^(?:bg-(?:bg(?:-(?:muted|subtle))?|accent(?:\/\d+)?)|text-(?:fg(?:-(?:muted|subtle))?|accent)|ring-(?:1|inset|accent(?:\/\d+)?))$/u;
      const selectedBackground = /^bg-(?:bg(?:-(?:muted|subtle))?|accent(?:\/\d+)?)$/u;
      const ownedTokens = [];
      const neutral = /^(?:(?:dark|enabled):)?hover:(?:bg|text|border)-\S+$/u;
      const focus =
        /^(?:focus|focus-visible):(?:outline(?:-\S+)?|ring(?:-\S+)?|border-(?:accent|border)|bg-bg(?:-\w+)?|text-fg(?:-\w+)?)$/u;
      const literal = (text, state = false) => [
        'string',
        text
          .split(/\s+/u)
          .filter(Boolean)
          .filter((token) => {
            if (state && stateAppearance.test(token)) return false;
            if (neutral.test(token)) {
              ownedTokens.push(token);
              return false;
            }
            if (!legacy && token === 'wp-interactive') {
              found = true;
              return false;
            }
            if (
              token === 'outline-none' ||
              focus.test(token) ||
              /^(?:transition-(?:colors|\[background-color\])|duration-(?:fast|normal|slow|\d+)|ease-(?:out|in-out)|disabled:(?:cursor-default|hover:(?:bg-transparent|text-fg(?:-\w+)?)|opacity-\d+))$/u.test(
                token
              )
            ) {
              ownedTokens.push(token);
              return false;
            }
            return true;
          })
          .join(' '),
      ];
      const concat = (parts) => {
        const result = [];
        for (const part of parts) {
          if (part[0] === 'string' && !part[1]) continue;
          if (part[0] === 'string' && result.at(-1)?.[0] === 'string')
            result.at(-1)[1] += ` ${part[1]}`;
          else result.push(part);
        }
        return result.length === 1 ? result[0] : ['concat', result];
      };
      const visit = (value, depth = 0, state = false) => {
        const node = resolveNode(value);
        if (!node || depth > 16) return ['unknown'];
        const binding = bindingFor(node);
        if (
          !legacy &&
          binding?.name === 'INTERACTION_CLASS' &&
          SHARED_MENU_MODULES.has(binding.origin)
        ) {
          found = true;
          return ['string', ''];
        }
        if (ts.isStringLiteralLike(node)) return literal(node.text, state);
        if (ts.isTemplateExpression(node))
          return concat([
            literal(node.head.text),
            ...node.templateSpans.flatMap((span) => [
              visit(span.expression, depth + 1),
              literal(span.literal.text),
            ]),
          ]);
        if (ts.isConditionalExpression(node)) {
          const condition = expressionIdentity(node.condition.getText(file));
          const whenTrue = resolveNode(node.whenTrue);
          const whenFalse = resolveNode(node.whenFalse);
          const stateBranch = legacy
            ? normalizeState &&
              whenTrue &&
              whenFalse &&
              ts.isStringLiteralLike(whenTrue) &&
              ts.isStringLiteralLike(whenFalse) &&
              whenTrue.text.split(/\s+/u).some((token) => selectedBackground.test(token))
            : normalizeState && stateConditions.has(condition);
          if (stateBranch && legacy) stateConditions.add(condition);
          const yes = visit(node.whenTrue, depth + 1, stateBranch),
            no = visit(node.whenFalse, depth + 1, stateBranch);
          return JSON.stringify(yes) === JSON.stringify(no)
            ? yes
            : ['conditional', condition, yes, no];
        }
        if (ts.isCallExpression(node))
          return [
            'call',
            expressionIdentity(node.expression.getText(file)),
            node.arguments
              .map((argument) => visit(argument, depth + 1))
              .filter(
                (part) =>
                  !(
                    /^(?:cn|cx|clsx|classNames|classnames)$/u.test(node.expression.getText(file)) &&
                    part[0] === 'string' &&
                    !part[1]
                  )
              ),
          ];
        if (ts.isArrayLiteralExpression(node))
          return ['array', node.elements.map((element) => visit(element, depth + 1))];
        if (ts.isBinaryExpression(node))
          return [
            node.operatorToken.kind,
            visit(node.left, depth + 1),
            visit(node.right, depth + 1),
          ];
        return ['expression', expressionIdentity(node.getText(file))];
      };
      const identity = visit(value);
      return legacy || found
        ? { identity: JSON.stringify([identity, [...stateConditions].sort()]), tokens: ownedTokens }
        : null;
    };

    const canonicalClass = (node) => {
      node = resolveNode(node);
      const binding = bindingFor(node && ts.isCallExpression(node) ? node.expression : node);
      return binding && STYLE_MODULES.has(binding.origin) && CONTROL_CLASSES.has(binding.name);
    };
    const canonicalWrapperClass = (node) => {
      const call = ts.isCallExpression(node);
      const binding = bindingFor(call ? node.expression : node);
      return (
        binding &&
        STYLE_MODULES.has(binding.origin) &&
        (call ? STYLE_HELPERS.has(binding.name) : /^UI_[A-Z0-9_]+_CLASS$/u.test(binding.name))
      );
    };
    const dataOnlyProperties = (value) => {
      if (objectShadowed || imports.has('Object')) return false;
      const call = unwrap(value);
      if (
        !call ||
        !ts.isCallExpression(call) ||
        call.expression.getText(file) !== 'Object.fromEntries' ||
        call.arguments.length !== 1
      )
        return false;
      const filter = unwrap(call.arguments[0]);
      if (
        !ts.isCallExpression(filter) ||
        !ts.isPropertyAccessExpression(filter.expression) ||
        filter.expression.name.text !== 'filter' ||
        filter.arguments.length !== 1
      )
        return false;
      const entries = unwrap(filter.expression.expression);
      if (
        !ts.isCallExpression(entries) ||
        entries.expression.getText(file) !== 'Object.entries' ||
        entries.arguments.length !== 1
      )
        return false;
      const predicate = unwrap(filter.arguments[0]);
      if (
        !ts.isArrowFunction(predicate) ||
        predicate.parameters.length !== 1 ||
        predicate.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      )
        return false;
      const parameter = predicate.parameters[0].name;
      if (!ts.isArrayBindingPattern(parameter) || parameter.elements.length !== 1) return false;
      const key = parameter.elements[0];
      if (
        !ts.isBindingElement(key) ||
        key.dotDotDotToken ||
        key.initializer ||
        !ts.isIdentifier(key.name)
      )
        return false;
      const condition = unwrap(predicate.body);
      return (
        ts.isCallExpression(condition) &&
        ts.isPropertyAccessExpression(condition.expression) &&
        ts.isIdentifier(condition.expression.expression) &&
        condition.expression.expression.text === key.name.text &&
        condition.expression.name.text === 'startsWith' &&
        condition.arguments.length === 1 &&
        ts.isStringLiteral(condition.arguments[0]) &&
        condition.arguments[0].text === 'data-'
      );
    };
    const objectProperties = (value, seen = new Set(), branches = false) => {
      if (seen.size > 16) return null;
      const node = resolveNode(value, seen);
      if (node && dataOnlyProperties(node)) return [];
      if (branches && node && ts.isConditionalExpression(node)) {
        const yes = objectProperties(node.whenTrue, new Set([...seen, node]), true);
        const no = objectProperties(node.whenFalse, new Set([...seen, node]), true);
        return yes && no ? [...yes, ...no] : null;
      }
      if (!node || !ts.isObjectLiteralExpression(node)) return null;
      const entries = [];
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = objectProperties(property.expression, new Set([...seen, node]), branches);
          if (!spread) return null;
          entries.push(...spread);
        } else if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          entries.push({ name: property.name.text, value: property.initializer, node: property });
        else if (ts.isShorthandPropertyAssignment(property))
          entries.push({ name: property.name.text, value: property.name, node: property });
        else return null;
      }
      return entries;
    };
    const strings = (value, depth = 0) => {
      if (depth > 16) return null;
      const node = resolveNode(value);
      if (!node) return null;
      if (canonicalWrapperClass(node)) return [''];
      const imported = bindingFor(node);
      if (imported?.name === 'INTERACTION_CLASS' && SHARED_MENU_MODULES.has(imported.origin))
        return ['wp-interactive'];
      if (ts.isStringLiteralLike(node)) return [node.text];
      if (ts.isConditionalExpression(node)) {
        const left = strings(node.whenTrue, depth + 1),
          right = strings(node.whenFalse, depth + 1);
        return left && right ? [...left, ...right] : null;
      }
      if (ts.isTemplateExpression(node)) {
        let parts = [node.head.text];
        for (const span of node.templateSpans) {
          const inner = strings(span.expression, depth + 1);
          if (!inner) return null;
          parts = parts.flatMap((part) =>
            inner.map((item) => `${part}${item}${span.literal.text}`)
          );
        }
        return parts;
      }
      if (ts.isBinaryExpression(node)) {
        const right = strings(node.right, depth + 1);
        if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return right;
        const left = strings(node.left, depth + 1);
        if (!left || !right) return null;
        return node.operatorToken.kind === ts.SyntaxKind.PlusToken
          ? left.flatMap((a) => right.map((b) => a + b))
          : [...left, ...right];
      }
      if (
        ts.isArrayLiteralExpression(node) ||
        (ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          /^(?:cn|cx|clsx|classNames|classnames)$/u.test(node.expression.text))
      ) {
        const parts = [...(ts.isArrayLiteralExpression(node) ? node.elements : node.arguments)].map(
          (item) => strings(item, depth + 1)
        );
        return parts.every(Boolean) ? parts.flat() : null;
      }
      if (ts.isObjectLiteralExpression(node)) {
        const keys = node.properties.map((property) =>
          ts.isPropertyAssignment(property) &&
          (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))
            ? property.name.text
            : null
        );
        return keys.every((key) => key !== null) ? keys : null;
      }
      if (
        [ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.NullKeyword].includes(
          node.kind
        ) ||
        (ts.isIdentifier(node) && node.text === 'undefined')
      )
        return [];
      return null;
    };
    const style = (value, node, context, element) => {
      const entries = objectProperties(value, new Set(), true);
      if (!entries) {
        add(
          node,
          'unresolved-inline-style',
          'style',
          value?.getText(file) ?? '',
          context,
          'Use an explicit style object with inspectable properties; ordinary appearance belongs to the shared owner.'
        );
        return;
      }
      for (const entry of entries) {
        const property = kebab(entry.name);
        if (!PROTECTED.test(property) || geometry(property, { element })) continue;
        const expression = resolveNode(entry.value);
        const value =
          expression && (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression))
            ? expression.text
            : null;
        if (value === null || privateValue(value, tokens))
          add(
            entry.node,
            value === null ? 'unresolved-inline-appearance' : 'private-inline-appearance',
            property,
            value ?? entry.value.getText(file),
            context,
            FIX,
            entry.value
          );
      }
    };
    const glyphClassDefault = (value, node) => {
      if (
        path !== `${ROOT}components/icons/glyphs.tsx` ||
        !value ||
        !ts.isIdentifier(value) ||
        value.text !== 'className'
      )
        return null;
      const opening = node.parent?.parent;
      if (
        !opening ||
        !(ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) ||
        opening.tagName.getText(file) !== 'svg'
      )
        return null;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (!ts.isFunctionLike(parent)) continue;
        for (const parameter of parent.parameters) {
          if (!ts.isObjectBindingPattern(parameter.name)) continue;
          const binding = parameter.name.elements.find(
            (element) =>
              ts.isIdentifier(element.name) &&
              element.name.text === 'className' &&
              (!element.propertyName || element.propertyName.getText(file) === 'className')
          );
          if (binding) return binding.initializer ? strings(binding.initializer) : [''];
        }
        break;
      }
      return null;
    };
    const classes = (value, node, context) => {
      if (canonicalClass(value)) return;
      const values = glyphClassDefault(value, node) ?? strings(value);
      if (!values) {
        add(
          node,
          'unresolved-class-expression',
          'className',
          value?.getText(file) ?? '',
          context,
          'Use canonical shared classes or inspectable literal class composition; computed private appearance cannot be qualified.',
          value
        );
        return;
      }
      for (const text of values) {
        for (const token of text.split(/\s+/u).filter(Boolean)) {
          const pieces = [];
          let level = 0,
            start = 0;
          for (let index = 0; index < token.length; index++) {
            if (token[index] === '[') level++;
            if (token[index] === ']') level--;
            if (token[index] === ':' && level === 0) {
              pieces.push(token.slice(start, index));
              start = index + 1;
            }
          }
          pieces.push(token.slice(start));
          const utility = pieces.at(-1).replace(/^!/u, '');
          const arbitrary = /^(.*?)\[(.*)\]$/u.exec(utility);
          const prefix = arbitrary?.[1].replace(/-$/u, '');
          const dimensionPrefix = /^(min-w|max-w|min-h|max-h|w|h|size|whitespace)(?=-)/u.exec(
            utility
          )?.[1];
          let property = utilityProperty(
            prefix ?? dimensionPrefix ?? utility.split('-')[0],
            arbitrary?.[2]
          );
          let appearance = arbitrary?.[2].replaceAll('_', ' ');
          if (arbitrary && !prefix && appearance.includes(':')) {
            const split = appearance.indexOf(':');
            property = appearance.slice(0, split);
            appearance = appearance.slice(split + 1);
          }
          const control = pieces
            .slice(0, -1)
            .some((variant) => CONTROL_SELECTOR.test(variant.replaceAll('_', ' ')));
          if (
            !property ||
            !(PROTECTED.test(property) || (control && CONTROL_GEOMETRY.test(property)))
          )
            continue;
          if (control) add(node, 'control-utility-override', property, token, context);
          else if (arbitrary && privateValue(appearance, tokens))
            add(node, 'private-utility-appearance', property, token, context);
        }
      }
    };
    const jsxIdentity = (node, entries, preserve = false) => {
      const owners = [];
      for (let parent = node.parent; parent; parent = parent.parent) {
        const initializer =
          ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)
            ? unwrap(parent.initializer)
            : null;
        if (
          preserve &&
          initializer &&
          (ts.isJsxElement(initializer) ||
            ts.isJsxFragment(initializer) ||
            ts.isJsxSelfClosingElement(initializer))
        )
          continue;
        if (
          ts.isVariableDeclaration(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isClassExpression(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isFunctionExpression(parent)
        )
          owners.unshift(
            `${ts.SyntaxKind[parent.kind]}:${
              parent.name ? expressionIdentity(parent.name.getText(file)) : 'anonymous'
            }`
          );
        else if (ts.isArrowFunction(parent)) owners.unshift('ArrowFunction');
      }
      const attributes = entries
        .filter(
          (entry) =>
            !(
              preserve &&
              entry.name === 'role' &&
              node.tagName.getText(file) === 'input' &&
              entries.some((item) => item.name === 'type' && item.value?.text === 'text') &&
              entry.value?.text === 'combobox'
            )
        )
        .filter((entry) =>
          /^(?:id|key|name|role|type|title|href|aria-label|data-testid|data-test-id|data-test)$/u.test(
            entry.name
          )
        )
        .map((entry) => [entry.name, expressionIdentity(entry.value?.getText(file) ?? '')])
        .sort(([left], [right]) => left.localeCompare(right));
      const element = ts.isJsxElement(node.parent) ? node.parent : null;
      const text =
        element?.children
          .flatMap((child) => {
            if (ts.isJsxText(child)) return [normalize(child.text)];
            if (
              ts.isJsxExpression(child) &&
              child.expression &&
              ts.isStringLiteralLike(child.expression)
            )
              return [normalize(child.expression.text)];
            return [];
          })
          .filter(Boolean)
          .join(' ') ?? '';
      return JSON.stringify([owners, node.tagName.getText(file), attributes, text]);
    };
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(file);
        const binding = bindingFor(node.tagName);
        const shared =
          binding &&
          ((MODULES.has(binding.origin) && CONTROLS.has(binding.name)) ||
            (SHARED_MENU_MODULES.has(binding.origin) && SHARED_MENU_CONTROLS.has(binding.name)));
        const menuSurface =
          binding &&
          ((SHARED_MENU_MODULES.has(binding.origin) && binding.name === 'MenuSurface') ||
            (binding.origin === `${ROOT}components/PortalMenu` && binding.name === 'PortalMenu'));
        const entries = [];
        let unknownSpread = false;
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attribute)) {
            const properties = objectProperties(attribute.expression);
            if (properties) entries.push(...properties);
            else unknownSpread = true;
          } else
            entries.push({
              name: attribute.name.getText(file),
              value: ts.isJsxExpression(attribute.initializer ?? {})
                ? attribute.initializer.expression
                : attribute.initializer,
              node: attribute,
            });
        }
        const role = entries.find((entry) => entry.name === 'role')?.value;
        const roles = role ? strings(role) : [];
        const ordinary =
          (NATIVE.has(tag) &&
            !(
              tag === 'input' &&
              entries.some((entry) => entry.name === 'type' && entry.value?.text === 'hidden')
            )) ||
          (tag === 'a' && entries.some((entry) => entry.name === 'href')) ||
          roles?.some((value) => ROLES.has(value)) ||
          (!GEOMETRY_ELEMENTS.has(tag) &&
            /^[a-z]/u.test(tag) &&
            entries.some((entry) => entry.name === 'onClick'));
        const context = jsxIdentity(node, entries);
        migrationContexts.set(context, jsxIdentity(node, entries, true));
        const structuralList =
          tag === 'div' &&
          roles?.includes('listbox') &&
          roles.every((role) => ['listbox', 'presentation'].includes(role)) &&
          !unknownSpread &&
          !entries.some(
            (entry) =>
              entry.name === 'style' || entry.name === 'tabIndex' || entry.name.startsWith('on')
          ) &&
          entries
            .filter((entry) => entry.name === 'className')
            .every((entry) => {
              const values = strings(entry.value);
              return (
                values &&
                values.every((value) =>
                  value
                    .split(/\s+/u)
                    .filter(Boolean)
                    .every((token) =>
                      /^(?:m[trblxy]?-(?:0|1|2|3|4|6|8)|(?:min|max)-h-(?:0|full|screen|\d+)|overflow-[xy]-(?:auto|hidden)|overscroll-contain)$/u.test(
                        token
                      )
                    )
                )
              );
            }) &&
          (() => {
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (!ts.isJsxElement(parent)) continue;
              const owner = bindingFor(parent.openingElement.tagName);
              if (
                owner &&
                ((SHARED_MENU_MODULES.has(owner.origin) && owner.name === 'MenuSurface') ||
                  (owner.origin === `${ROOT}components/PortalMenu` && owner.name === 'PortalMenu'))
              )
                return true;
            }
            return false;
          })();
        if (role && roles === null && !shared && !menuSurface)
          add(
            node,
            'unresolved-control-role',
            'role',
            role.getText(file),
            context,
            'Use an inspectable role; an unknown role can hide a competing ordinary control.'
          );
        if ((shared || menuSurface || ordinary || /^[a-z]/u.test(tag)) && unknownSpread)
          add(
            node,
            'unresolved-control-spread',
            'props',
            'spread',
            context,
            'Pass explicit behavior props or an inspectable object without className/style; unknown spreads can override canonical appearance.'
          );
        const controlClasses = entries.filter((entry) => entry.name === 'className');
        if (
          ordinary &&
          !shared &&
          !menuSurface &&
          !structuralList &&
          (!controlClasses.length || controlClasses.some((entry) => !canonicalClass(entry.value)))
        )
          add(
            node,
            'native-control-owner',
            'className',
            entries.find((entry) => entry.name === 'className')?.value?.getText(file) ?? '',
            context,
            'Use the canonical shared control or import its canonical class from components/ui/styles.ts; copied classes create a competing control.',
            controlClasses[0]?.value ?? ts.factory.createStringLiteral('')
          );
        for (const entry of entries) {
          if ((shared || menuSurface || ordinary) && entry.name === 'style')
            add(
              entry.node,
              'control-inline-override',
              'style',
              entry.value?.getText(file) ?? '',
              context
            );
          if ((shared || menuSurface) && entry.name === 'className')
            add(
              entry.node,
              'shared-control-class-override',
              'className',
              entry.value?.getText(file) ?? '',
              context
            );
          if (entry.name === 'style') style(entry.value, entry.node, context, tag);
          if (entry.name === 'className') classes(entry.value, entry.node, context);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  function utilityProperty(prefix, value = '') {
    if (/^(?:w|size|min-w|max-w)$/u.test(prefix)) return 'width';
    if (/^(?:h|min-h|max-h)$/u.test(prefix)) return 'height';
    if (prefix === 'whitespace') return 'white-space';
    if (/^-?(?:p|px|py|pt|pr|pb|pl|ps|pe)$/u.test(prefix)) return 'padding';
    if (/^-?(?:m|mx|my|mt|mr|mb|ml|ms|me)$/u.test(prefix)) return 'margin';
    if (/^gap(?:-[xy])?$/u.test(prefix)) return 'gap';
    if (prefix === 'text') return /(?:#|rgb|hsl|--color-)/iu.test(value) ? 'color' : 'font-size';
    if (prefix === 'font') return 'font-weight';
    if (prefix === 'leading') return 'line-height';
    if (prefix === 'tracking') return 'letter-spacing';
    if (prefix.startsWith('rounded')) return 'border-radius';
    if (prefix.startsWith('border')) return 'border';
    if (prefix === 'bg') return 'background';
    if (prefix.startsWith('shadow')) return 'box-shadow';
    if (prefix.startsWith('outline')) return 'outline';
    if (prefix === 'opacity') return 'opacity';
    if (['duration', 'ease', 'transition'].includes(prefix)) return 'transition';
    if (prefix === 'animate') return 'animation';
    return null;
  }

  function checkDesktopUiStyling({
    files,
    allowedDebt = [],
    previousDebt,
    scientificGeometry = [],
  }) {
    const findings = [];
    const occurrences = new Map();
    const allowed = new Set(allowedDebt);
    const previous = previousDebt === undefined ? allowed : new Set(previousDebt);
    const tokens = tokensFrom(files);
    for (const [path, source] of files) {
      if (!production(path)) continue;
      const emit = (
        rule,
        property,
        value,
        context,
        line = 1,
        column = 1,
        fix = FIX,
        identityValue = value,
        migration
      ) => {
        const identity = JSON.stringify([
          path,
          rule,
          property,
          normalize(identityValue),
          normalize(context),
        ]);
        const occurrence = (occurrences.get(identity) ?? 0) + 1;
        occurrences.set(identity, occurrence);
        const fingerprint = createHash('sha256').update(`${identity}\0${occurrence}`).digest('hex');
        if (
          allowed.has(fingerprint) &&
          previous.has(fingerprint) &&
          !RETIRED.has(fingerprint) &&
          !rule.endsWith('-parse')
        )
          return;
        findings.push({
          fingerprint,
          path,
          line,
          column,
          rule,
          property,
          value,
          fix,
          ...(migration ? { migration } : {}),
        });
      };
      const geometry = (property, location) =>
        scientificGeometry.some(
          (entry) =>
            entry.path === path &&
            entry.properties?.includes(property) &&
            ((entry.selector && entry.selector === location.selector) ||
              (entry.element &&
                GEOMETRY_ELEMENTS.has(entry.element) &&
                entry.element === location.element))
        );
      if (path.endsWith('.css')) analyzeCss(path, source, emit, tokens, geometry);
      else analyzeTs(path, source, emit, tokens, geometry);
    }
    for (const fingerprint of allowed) {
      if (previous.has(fingerprint)) continue;
      findings.push({
        fingerprint,
        path: 'scripts/guard-ui-styling.mjs',
        line: 1,
        column: 1,
        rule: 'debt-allowance-growth',
        property: 'allowedDebt',
        value: fingerprint,
        fix: 'Existing styling debt may only shrink; remove the new competing appearance instead of expanding its allowance.',
      });
    }
    return findings;
  }

  function checkDesktopUiStylingChange({ before, after, incoming = new Map() }) {
    const previous = new Map(before);
    for (const [path, source] of incoming)
      if (after.get(path) === source) previous.set(path, source);
    const previousFindings = checkDesktopUiStyling({ files: previous });
    const debt = previousFindings.map((finding) => finding.fingerprint);
    const unchanged = new Set(
      checkDesktopUiStyling({ files: after }).map((finding) => finding.fingerprint)
    );
    const migrations = new Map();
    for (const finding of previousFindings) {
      if (
        !['native-control-owner', 'unresolved-class-expression'].includes(finding.rule) ||
        !finding.migration?.legacyInteraction ||
        RETIRED.has(finding.fingerprint) ||
        unchanged.has(finding.fingerprint)
      )
        continue;
      for (const legacy of [
        finding.migration.legacyInteraction,
        finding.migration.legacyStateInteraction,
      ]) {
        if (!legacy) continue;
        const key = JSON.stringify([
          finding.rule,
          finding.path,
          finding.migration.preservedContext ?? finding.migration.context,
          legacy.identity,
        ]);
        migrations.set(key, [
          ...(migrations.get(key) ?? []),
          { id: finding.fingerprint, tokens: legacy.tokens },
        ]);
      }
    }
    const preserved = new Map();
    for (const finding of previousFindings) {
      if (
        !['native-control-owner', 'unresolved-inline-appearance'].includes(finding.rule) ||
        !finding.migration ||
        RETIRED.has(finding.fingerprint) ||
        unchanged.has(finding.fingerprint)
      )
        continue;
      const key = JSON.stringify([
        finding.rule,
        finding.property,
        finding.path,
        finding.migration.preservedContext,
        finding.migration.valueIdentity,
      ]);
      preserved.set(key, [...(preserved.get(key) ?? []), finding.fingerprint]);
    }
    const hoverColors = previousFindings.filter(
      (finding) =>
        finding.rule === 'control-css-override' &&
        finding.property === 'color' &&
        /^hsl\(var\(--color-fg\)\)$/u.test(finding.value.replace(/\s/gu, '')) &&
        !unchanged.has(finding.fingerprint)
    );
    const consumed = new Set();
    return checkDesktopUiStyling({ files: after, allowedDebt: debt, previousDebt: debt }).filter(
      (finding) => {
        if (
          finding.rule === 'control-css-override' &&
          finding.property === 'color' &&
          finding.value.replace(/\s/gu, '') === 'var(--interaction-hover-foreground)'
        ) {
          const beforeSource = previous.get(finding.path);
          const afterSource = after.get(finding.path);
          const selectorAt = (source, line) => {
            let result = null;
            postcss.parse(source).walkDecls((declaration) => {
              if (declaration.source.start.line === line && declaration.prop === 'color')
                result = cssContext(declaration);
            });
            return result;
          };
          const selector = selectorAt(afterSource, finding.line);
          const match =
            selector?.endsWith(':hover') &&
            hoverColors.find(
              (original) =>
                original.path === finding.path &&
                !consumed.has(original.fingerprint) &&
                selectorAt(beforeSource, original.line) === selector
            );
          if (match) {
            consumed.add(match.fingerprint);
            return false;
          }
        }
        if (
          ['native-control-owner', 'unresolved-inline-appearance'].includes(finding.rule) &&
          finding.migration
        ) {
          const key = JSON.stringify([
            finding.rule,
            finding.property,
            finding.path,
            finding.migration.preservedContext,
            finding.migration.valueIdentity,
          ]);
          const matches = preserved.get(key) ?? [];
          const match = matches.find((id) => !consumed.has(id));
          if (match) {
            consumed.add(match);
            return false;
          }
        }
        if (
          !['native-control-owner', 'unresolved-class-expression'].includes(finding.rule) ||
          !finding.migration?.sharedInteraction
        )
          return true;
        for (const shared of [
          finding.migration.sharedInteraction,
          finding.migration.sharedStateInteraction,
        ]) {
          if (!shared) continue;
          const key = JSON.stringify([
            finding.rule,
            finding.path,
            finding.migration.preservedContext ?? finding.migration.context,
            shared.identity,
          ]);
          const remaining = migrations.get(key) ?? [];
          const match = remaining.findIndex(({ id, tokens }) => {
            if (consumed.has(id)) return false;
            const retained = [...tokens];
            return shared.tokens.every((token) => {
              const index = retained.indexOf(token);
              if (index < 0) return false;
              retained.splice(index, 1);
              return true;
            });
          });
          if (match < 0) continue;
          consumed.add(remaining[match].id);
          remaining.splice(match, 1);
          return false;
        }
        return true;
      }
    );
  }

  return {
    checkDesktopUiStyling,
    checkDesktopUiStylingChange,
    RETIRED_UI_STYLE_FINGERPRINTS,
    production,
    sourcePaths: [...THEMES, ...RETIRED_SOURCE_PATHS],
  };
}

export const { checkDesktopUiStyling, checkDesktopUiStylingChange, RETIRED_UI_STYLE_FINGERPRINTS } =
  createStylingChecker();
