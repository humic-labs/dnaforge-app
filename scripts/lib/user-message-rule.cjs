const DIAGNOSTIC_FIELD =
  /^(?:message|name|code|stack|detail|error_description|statusText|bodyPreview)$/u;
const FAILURE_NAME =
  /(?:^|[._])(?:e|err|error|cause|reason|exception|failure|rejection|caught)(?:$|[._])|(?:Error|Failure|Exception|Reason|error|failure)(?:$|[A-Z._])/u;
const RESPONSE_NAME = /(?:response|body|json|payload|result|data|record)/iu;
const INTERNAL_TEXT =
  /\b(?:VITE_|NEXT_PUBLIC_|DNAFORGE_|WAYPOINT_|SUPABASE_|DATABASE_URL|API_URL)[A-Z0-9_]*\b|\b[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)+\b|\b(?:platform|electronAPI|lims|db)\.[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*|\b[a-z_$][\w$]*\.[a-z_$][\w$]*[A-Z][\w$]*\b|hosted browser runtime|\b[A-Z][A-Za-z0-9]*(?:Error|Exception)\b|\bat \S+ \([^\n]+:\d+:\d+\)|\b[a-zA-Z_$][\w$]*\.[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*\b|\b[\w-]+\.(?:tsx?|jsx?|[cm]js|py)\b|\b[a-z][a-z0-9]*_[a-z][\w_]*\b/u;
const FIX =
  'Use userMessage(key), userMessageWithValues(key, values) or toUserMessage(failure, fallbackKey) from @waypoint/user-messages; use userEntityLabel(name) for identity labels; keep raw diagnostics in logging or Error.cause.';

const internalCopy = (value) =>
  INTERNAL_TEXT.test(
    value
      .replace(/\b(?:e\.g\.|i\.e\.)/giu, 'example')
      .replace(
        /https?:\/\/[^\s"'<>]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io)(?:\/[^\s"'<>]*)?/giu,
        'website'
      )
      .replace(/\b(?:GC[AF]_|N[CGMPRSTW]_|X[MRP]_)\d+(?:\.\d+)?\b/gu, 'accession')
      .replace(
        /\b[\w.-]+\.(?:bigWig|bigBed|gb|gbk|genbank|fasta|fa|fna|fastq|fq|bam|cram|gff|gff3|gtf|bed|bcf|vcf|pdb|cif|md|txt|json|csv|tsv|ntpx|ntx|ipynb|cpuprofile|cmd|exe)(?:\.(?:gz|bgz))?(?:\.(?:bai|crai|csi|tbi|gzi|fai))?\b/giu,
        'document'
      )
  );

function inspectUserMessages(source, filename, ts) {
  if (!/^(?:apps\/desktop\/src\/|apps\/web\/|packages\/)/u.test(filename)) return [];
  if (
    /\.(?:test|test-harness|spec|stories)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|__mocks__|generated|test|e2e|scripts)\//u.test(
      filename
    )
  )
    return [];
  if (filename.startsWith('packages/core/user-messages/') && !filename.endsWith('/catalog.ts'))
    return [];
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length) {
    return sf.parseDiagnostics.map((diagnostic) => {
      const start = diagnostic.start ?? 0;
      const { line, character } = sf.getLineAndCharacterOfPosition(start);
      return {
        path: filename,
        line: line + 1,
        column: character + 1,
        start,
        end: start + (diagnostic.length ?? 0),
        kind: 'invalid-source',
        expression: source.slice(start, start + (diagnostic.length ?? 0)),
        fix: 'Fix the syntax error so the user-message boundary can inspect this source.',
      };
    });
  }
  const findings = [];
  const seen = new Set();
  const textSetters = new Set();
  const bindings = new Map();
  const functions = new Map();
  const diagnosticSetters = new Set();
  const containsView = (node) => {
    if (!node) return false;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return containsView(node.expression);
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
      return true;
    if (ts.isConditionalExpression(node))
      return containsView(node.whenTrue) || containsView(node.whenFalse);
    if (ts.isBinaryExpression(node)) return containsView(node.left) || containsView(node.right);
    if (ts.isArrayLiteralExpression(node)) return node.elements.some(containsView);
    return false;
  };
  const structuredSetters =
    /(?:Errors|Id|Ids|Key|Keys|Count|Index|Record|Records|Rows|Kind|Code|State|Status|Details)$/u;
  const text = (node) => node?.getText(sf) ?? '';
  const walk = (node, visit) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };
  const unwrap = (node) => {
    while (
      node &&
      (ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isTypeAssertionExpression(node))
    )
      node = node.expression;
    return node;
  };
  const callee = (node) => text(node.expression).replaceAll('?.', '.');
  const scopeFor = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        ts.isFunctionLike(parent) ||
        ts.isBlock(parent) ||
        ts.isCatchClause(parent) ||
        ts.isSourceFile(parent)
      )
        return parent;
    }
    return sf;
  };
  const declaredTypes = new Map();
  for (const statement of sf.statements)
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      declaredTypes.set(statement.name.text, statement);
  const memberTypes = (type, name) => {
    if (type && ts.isUnionTypeNode(type))
      return type.types.flatMap((member) => memberTypes(member, name));
    if (type && ts.isTypeReferenceNode(type)) {
      const declaration = declaredTypes.get(text(type.typeName));
      if (declaration && ts.isTypeAliasDeclaration(declaration))
        return memberTypes(declaration.type, name);
      type = declaration;
    }
    return (
      type?.members?.filter((member) => text(member.name) === name).map((member) => member.type) ??
      []
    );
  };
  const memberType = (type, name) => {
    const fields = memberTypes(type, name);
    return fields.length &&
      fields.every((field) =>
        /^User(?:Message|MessageInput|MessagePayload|EntityLabel|MessageValue|VisibleText)(?:\s*\|\s*(?:null|undefined))*$/u.test(
          text(field)
        )
      )
      ? fields[0]
      : undefined;
  };
  const bind = (name, declaration, initializer, type) => {
    if (ts.isIdentifier(name)) {
      const scope = scopeFor(declaration);
      if (!bindings.has(scope)) bindings.set(scope, new Map());
      const fields = new Map();
      if (initializer && ts.isObjectLiteralExpression(initializer))
        for (const property of initializer.properties) {
          if (ts.isPropertyAssignment(property))
            fields.set(text(property.name), [property.initializer]);
        }
      bindings.get(scope).set(name.text, { initializer, type, writes: [], fields });
    } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (!ts.isBindingElement(element)) continue;
        bind(
          element.name,
          declaration,
          null,
          ts.isArrayBindingPattern(name) &&
            name.elements[0] === element &&
            initializer &&
            ts.isCallExpression(initializer) &&
            /^(?:React\.)?useState$/u.test(callee(initializer))
            ? initializer.typeArguments?.[0]
            : memberTypes(type, text(element.propertyName ?? element.name))[0]
        );
        if (ts.isObjectBindingPattern(name) && ts.isIdentifier(element.name)) {
          const entry = bindings.get(scopeFor(declaration))?.get(element.name.text);
          if (entry && element.propertyName)
            entry.diagnostic =
              /^(?:message|detail|stack|errorMessage|error_description|statusText|capabilityKey|toolName)$/u.test(
                text(element.propertyName ?? element.name)
              );
        }
      }
    }
  };
  const bindingFor = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      const scope = bindings.get(parent);
      if (scope?.has(node.text)) return scope.get(node.text);
    }
    return null;
  };
  const expressionTypes = (node) => {
    if (node && ts.isIdentifier(node)) {
      const type = bindingFor(node)?.type;
      return type ? [type] : [];
    }
    if (node && ts.isPropertyAccessExpression(node))
      return expressionTypes(node.expression).flatMap((type) => memberTypes(type, node.name.text));
    return [];
  };
  const approved = (node, visited = new Set(), respectParameterTypes = true) => {
    node = unwrap(node);
    if (
      respectParameterTypes &&
      node &&
      ts.isPropertyAccessExpression(node) &&
      expressionTypes(node.expression).length > 0 &&
      expressionTypes(node.expression).every((type) => memberType(type, node.name.text))
    )
      return true;
    if (node && ts.isIdentifier(node) && !visited.has(node.text)) {
      const binding = bindingFor(node);
      if (
        respectParameterTypes &&
        binding?.type &&
        /^User(?:Message|MessageInput|MessagePayload|EntityLabel|MessageValue|VisibleText)(?:\s*\|\s*(?:null|undefined))*$/u.test(
          text(binding.type)
        )
      )
        return true;
      if (binding?.initializer)
        return (
          approved(binding.initializer, new Set([...visited, node.text]), respectParameterTypes) &&
          binding.writes.every((write) =>
            approved(write, new Set([...visited, node.text]), respectParameterTypes)
          )
        );
    }
    if (
      node &&
      (node.kind === ts.SyntaxKind.NullKeyword ||
        text(node) === 'undefined' ||
        (ts.isStringLiteralLike(node) && !node.text))
    )
      return true;
    if (node && ts.isConditionalExpression(node))
      return (
        approved(node.whenTrue, visited, respectParameterTypes) &&
        approved(node.whenFalse, visited, respectParameterTypes)
      );
    if (
      node &&
      ts.isCallExpression(node) &&
      functions.get(callee(node))?.type &&
      /^User(?:Message|MessageInput|MessagePayload|EntityLabel|MessageValue|VisibleText)(?:\s*\|\s*(?:null|undefined))*$/u.test(
        text(functions.get(callee(node)).type)
      )
    )
      return true;
    return (
      node &&
      ts.isCallExpression(node) &&
      /^(?:userMessage|userMessagePayload|renderUserMessage|renderUserMessagePayload|resolveUserMessage|toUserMessage|toOptionalUserMessage|userMessageWithValues|userEntityLabel|toOptionalUserEntityLabel|userToolLabel)$/u.test(
        callee(node)
      )
    );
  };
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node)) bind(node.name, node, node.initializer, node.type);
    if (ts.isParameter(node)) bind(node.name, node, node.initializer, node.type);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      text(node.initializer.expression) === 'useState' &&
      node.initializer.typeArguments?.length &&
      ts.isBindingElement(node.name.elements[0])
    ) {
      bind(node.name.elements[0].name, node, null, node.initializer.typeArguments[0]);
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      functions.set(node.name.text, node.initializer);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      /^useState$/u.test(text(node.initializer.expression)) &&
      node.initializer.typeArguments?.some(
        (type) => !/\b(?:string|UserMessage)\b/u.test(text(type))
      )
    ) {
      const setter = node.name.elements[1];
      if (setter) diagnosticSetters.add(text(setter.name));
    }
  });
  walk(sf, (node) => {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const entry = bindings
        .get(scopeFor(node.variableDeclaration))
        ?.get(text(node.variableDeclaration.name));
      if (entry) {
        entry.diagnostic = true;
        entry.caught = true;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      bindingFor(node.left)?.writes.push(node.right);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression)
    ) {
      const owner = bindingFor(node.left.expression);
      if (owner) {
        const key = node.left.name.text;
        if (!owner.fields.has(key)) owner.fields.set(key, []);
        owner.fields.get(key).push(node.right);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      /^(?:React\.)?useState$/u.test(text(node.initializer.expression))
    ) {
      const setter = node.name.elements[1];
      if (setter && ts.isBindingElement(setter)) textSetters.add(text(setter.name));
    }
  });
  const errorType = (type) =>
    /^(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*(?:Error|Exception)(?:\s*\|\s*(?:null|undefined))*$/u.test(
      text(type)
    );
  const failureName = (value) => FAILURE_NAME.test(value);
  const formattedCopy = (node, visited = new Set()) => {
    node = unwrap(node);
    if (!node || approved(node) || visited.has(node)) return false;
    const next = new Set([...visited, node]);
    if (ts.isTemplateExpression(node)) return true;
    if (ts.isIdentifier(node)) {
      const binding = bindingFor(node);
      return (
        formattedCopy(binding?.initializer, next) ||
        (binding?.writes.some((write) => formattedCopy(write, next)) ?? false)
      );
    }
    if (ts.isConditionalExpression(node))
      return formattedCopy(node.whenTrue, next) || formattedCopy(node.whenFalse, next);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return formattedCopy(node.left, next) || formattedCopy(node.right, next);
    if (ts.isCallExpression(node)) {
      const local = functions.get(callee(node));
      if (!local?.body) return false;
      if (!ts.isBlock(local.body)) return formattedCopy(local.body, next);
      let formatted = false;
      const inspectReturn = (part) => {
        if (ts.isFunctionLike(part)) return;
        if (ts.isReturnStatement(part) && formattedCopy(part.expression, next)) formatted = true;
        ts.forEachChild(part, inspectReturn);
      };
      inspectReturn(local.body);
      return formatted;
    }
    return false;
  };
  const raw = (node, visited = new Set()) => {
    node = unwrap(node);
    if (!node || approved(node)) return false;
    if (ts.isIdentifier(node)) {
      if (visited.has(node.text)) return false;
      const binding = bindingFor(node);
      if (
        binding?.diagnostic ||
        (binding?.type && errorType(binding.type)) ||
        binding?.writes.some((write) => raw(write, new Set([...visited, node.text])))
      )
        return true;
      const init = binding?.initializer;
      if (init && ts.isNewExpression(init) && /(?:Error|Exception)$/u.test(text(init.expression)))
        return true;
      if (init && containsView(init)) return false;
      if (init && approved(init) && !binding?.writes.length) return false;
      if (
        init &&
        (ts.isNumericLiteral(init) ||
          (ts.isPropertyAccessExpression(init) && init.name.text === 'length'))
      )
        return false;
      if (
        failureName(node.text) ||
        /^(?:toolName|toolId|tool_name|tool_id|capabilityKey|capability_key|methodName|method_name|attributeName|attribute_name|class_name|errorClass|error_class|uuid)$/u.test(
          node.text
        )
      )
        return true;
      return init ? raw(init, new Set([...visited, node.text])) : false;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression &&
          (ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : '');
      const owner = text(node.expression);
      if (ts.isIdentifier(node.expression)) {
        const field = bindingFor(node.expression)?.fields.get(key);
        const id = `${node.expression.text}.${key}`;
        if (
          field &&
          !visited.has(id) &&
          field.some((value) => raw(value, new Set([...visited, id])))
        )
          return true;
      }
      if (key === 'detail' && /CustomEvent<(?:boolean|number)>/u.test(owner)) return false;
      if (key === 'partialEffects') return true;
      if (owner === 'console') return false;
      if (/^(?:value|id|key)$/u.test(key) && /(?:scope|capability|permission)/iu.test(owner))
        return true;
      if (ts.isIdentifier(unwrap(node.expression))) {
        const receiver = unwrap(node.expression);
        const binding = bindingFor(receiver);
        if (
          !/^(?:length|count|size|total|retryable|canRetry)$/u.test(key) &&
          ((binding?.type && errorType(binding.type)) ||
            (binding?.initializer &&
              ts.isNewExpression(binding.initializer) &&
              /(?:Error|Exception)$/u.test(text(binding.initializer.expression))) ||
            binding?.caught)
        )
          return true;
      }
      if (/^(?:detail|error_description|statusText|bodyPreview)$/u.test(key)) return true;
      if (key === 'message') {
        const declaration = ts.isIdentifier(node.expression) ? bindingFor(node.expression) : null;
        if (declaration?.type && /\bError\b/u.test(text(declaration.type))) return true;
        if (
          declaration?.initializer &&
          ts.isNewExpression(declaration.initializer) &&
          /(?:Error|Exception)$/u.test(text(declaration.initializer.expression))
        )
          return true;
        const writtenHistory =
          owner === 'entry' &&
          /import type \{ GitLogEntry \} from ['"][^'"]*workspace\/(?:public\/)?git['"]/u.test(
            source
          );
        if (owner !== 'chat' && !writtenHistory) return true;
      }
      if (
        /^(?:error|errorMessage|error_message|failureReason|stack|stack_trace|traceback|exception|capabilityKey|capability_key|methodName|method_name|attributeName|attribute_name|className|class_name|errorClass|error_class|toolName|tool_name|toolId|tool_id|actorLabel|ownerLabel)$/u.test(
          key
        )
      )
        return true;
      if (
        DIAGNOSTIC_FIELD.test(key) &&
        (failureName(owner) ||
          (['message', 'detail', 'error_description', 'statusText', 'bodyPreview'].includes(key) &&
            RESPONSE_NAME.test(owner)))
      )
        return true;
      return false;
    }
    if (ts.isStringLiteralLike(node)) return internalCopy(node.text);
    if (ts.isConditionalExpression(node))
      return raw(node.whenTrue, visited) || raw(node.whenFalse, visited);
    if (ts.isBinaryExpression(node)) {
      if (
        [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
          node.operatorToken.kind
        ) &&
        /(?:name|title|label)$/iu.test(text(node.left)) &&
        /(?:\bid|Id|uuid)$/u.test(text(node.right))
      )
        return true;
      if (
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind)
      )
        return (
          raw(node.right, visited) ||
          (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken &&
            raw(node.left, visited))
        );
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken)
        return raw(node.left, visited) || raw(node.right, visited);
      return false;
    }
    if (ts.isTemplateExpression(node))
      return (
        internalCopy(node.head.text) ||
        node.templateSpans.some(
          (span) => raw(span.expression, visited) || internalCopy(span.literal.text)
        )
      );
    if (ts.isCallExpression(node)) {
      if (
        /^(?:Boolean|Number|parseInt|parseFloat|Array\.isArray|Object\.hasOwn)$/u.test(
          callee(node)
        ) ||
        /\.(?:includes|startsWith|endsWith|test|has|some|every)$/u.test(callee(node))
      )
        return false;
      if (/^(?:JSON.stringify|String)$/u.test(callee(node)))
        return node.arguments.some((arg) => raw(arg, visited));
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        /^(?:join|trim|toString|slice|substring)$/u.test(node.expression.name.text)
      )
        return raw(node.expression.expression, visited);
      const local = functions.get(callee(node));
      if (local?.body && !visited.has(callee(node))) {
        let tainted = false;
        walk(local.body, (part) => {
          if (
            ts.isReturnStatement(part) &&
            raw(part.expression, new Set([...visited, callee(node)]))
          )
            tainted = true;
        });
        return tainted;
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        raw(node.expression.expression, visited)
      )
        return true;
      return node.arguments.some((arg) => raw(arg, visited));
    }
    return false;
  };
  const rawRenderInput = (node, visited = new Set()) => {
    node = unwrap(node);
    if (!node || approved(node)) return false;
    if (ts.isCallExpression(node))
      return (
        (/^(?:String|JSON.stringify)$/u.test(callee(node)) &&
          node.arguments.some((argument) => raw(argument))) ||
        (ts.isPropertyAccessExpression(node.expression) && raw(node.expression.expression))
      );
    if (ts.isIdentifier(node) && !visited.has(node.text)) {
      const binding = bindingFor(node);
      if (binding?.initializer)
        return (
          rawRenderInput(binding.initializer, new Set([...visited, node.text])) ||
          binding.writes.some((write) => rawRenderInput(write, new Set([...visited, node.text])))
        );
    }
    if (ts.isConditionalExpression(node))
      return rawRenderInput(node.whenTrue, visited) || rawRenderInput(node.whenFalse, visited);
    if (ts.isBinaryExpression(node))
      return rawRenderInput(node.left, visited) || rawRenderInput(node.right, visited);
    if (ts.isTemplateExpression(node))
      return node.templateSpans.some((span) => rawRenderInput(span.expression, visited));
    return raw(node);
  };
  const report = (node, kind, fix = FIX) => {
    const start = node.getStart(sf);
    if (seen.has(start)) return;
    seen.add(start);
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    findings.push({
      path: filename,
      line: line + 1,
      column: character + 1,
      start,
      end: node.end,
      kind,
      expression: text(node),
      fix,
    });
  };
  const literalCopy = (node) => {
    node = unwrap(node);
    if (!node) return '';
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node))
      return node.head.text + node.templateSpans.map((span) => span.literal.text).join(' ');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return literalCopy(node.left) + literalCopy(node.right);
    if (ts.isConditionalExpression(node))
      return literalCopy(node.whenTrue) + ' ' + literalCopy(node.whenFalse);
    return '';
  };
  const diagnosticContext = (node) => {
    for (let p = node.parent; p && !ts.isStatement(p); p = p.parent) {
      if (ts.isBinaryExpression(p) && /\.__test$/u.test(text(p.left))) return true;
      if (
        ts.isPropertyAssignment(p) &&
        /^(?:cause|diagnostic|diagnostics|debug)$/u.test(text(p.name))
      )
        return true;
      if (
        ts.isCallExpression(p) &&
        /^(?:console\.|logger\.|log\.|Sentry\.|captureException|reportErrorBoundary|reportErrorForDisplay|useStore$|useShallow$|use[A-Za-z]+Store$)/u.test(
          callee(p)
        )
      )
        return true;
    }
    return false;
  };
  const scalarFailure = (node, visited = new Set()) => {
    node = unwrap(node);
    if (!node) return false;
    if (ts.isIdentifier(node)) {
      if (visited.has(node.text)) return false;
      const binding = bindingFor(node);
      if (binding?.type && /\bstring\b/u.test(text(binding.type))) return true;
      if (binding?.type && /(?:Error|Failure)\b/u.test(text(binding.type))) return false;
      if (binding?.initializer)
        return scalarFailure(binding.initializer, new Set([...visited, node.text]));
      return false;
    }
    if (ts.isConditionalExpression(node))
      return scalarFailure(node.whenTrue, visited) && scalarFailure(node.whenFalse, visited);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : '';
      return !/^(?:error|partialEffects)$/u.test(key);
    }
    return (
      !ts.isNewExpression(node) &&
      !ts.isObjectLiteralExpression(node) &&
      node.kind !== ts.SyntaxKind.NullKeyword
    );
  };
  const diagnosticText = (node, visited = new Set()) => {
    node = unwrap(node);
    if (!node || approved(node)) return false;
    if (ts.isIdentifier(node)) {
      if (visited.has(node.text)) return false;
      const binding = bindingFor(node);
      if (
        binding?.diagnostic ||
        binding?.writes.some((write) => diagnosticText(write, new Set([...visited, node.text])))
      )
        return true;
      const initializer = binding?.initializer;
      return initializer ? diagnosticText(initializer, new Set([...visited, node.text])) : false;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : '';
      return /^(?:partialEffects|message|detail|errorMessage|error_message|error_description|stack|stack_trace|traceback|exception|statusText|bodyPreview|capabilityKey|capability_key|methodName|method_name|attributeName|attribute_name|className|class_name|errorClass|error_class|toolName|tool_name|toolId|tool_id)$/u.test(
        key
      );
    }
    if (ts.isCallExpression(node)) {
      const local = functions.get(callee(node));
      if (local?.body && !visited.has(callee(node))) {
        let diagnostic = false;
        walk(local.body, (part) => {
          if (
            ts.isReturnStatement(part) &&
            diagnosticText(part.expression, new Set([...visited, callee(node)]))
          )
            diagnostic = true;
        });
        if (diagnostic) return true;
      }
      return (
        (/^(?:String|JSON.stringify)$/u.test(callee(node)) &&
          node.arguments.some((argument) => raw(argument))) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          diagnosticText(node.expression.expression, visited)) ||
        node.arguments.some((argument) => diagnosticText(argument, visited))
      );
    }
    if (ts.isConditionalExpression(node))
      return diagnosticText(node.whenTrue, visited) || diagnosticText(node.whenFalse, visited);
    if (ts.isBinaryExpression(node))
      return diagnosticText(node.left, visited) || diagnosticText(node.right, visited);
    if (ts.isTemplateExpression(node))
      return node.templateSpans.some((span) => diagnosticText(span.expression, visited));
    return false;
  };
  const publicFormatterName = (formatter) => {
    if (!ts.isFunctionLike(formatter) || !formatter.body) return '';
    return text(formatter.name ?? formatter.parent?.name);
  };
  const isPublicErrorFormatter = (formatter) =>
    /^format.*(?:(?:Display|Public|User).*(?:Error|Failure)|(?:Error|Failure).*(?:Display|Public|User))/u.test(
      publicFormatterName(formatter)
    );
  walk(sf, (node) => {
    if (
      isPublicErrorFormatter(node) &&
      !/^UserMessage(?:\s*\|\s*(?:null|undefined))*$/u.test(text(node.type))
    )
      report(
        node.type ?? node.name ?? node,
        'untyped-public-error-formatter',
        'Return UserMessage (optionally null) from public error formatters; use toUserMessage(failure, fallbackKey) or a catalog factory and keep raw diagnostics private.'
      );
    if (isPublicErrorFormatter(node) && node.body && !ts.isBlock(node.body) && !approved(node.body))
      report(
        node.body,
        'raw-public-error-return',
        'Return userMessage(key) or toUserMessage(failure, fallbackKey) from this public error formatter; do not return raw exception text.'
      );
    if (ts.isReturnStatement(node) && node.expression) {
      let owner = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (
        owner &&
        isPublicErrorFormatter(owner) &&
        node.expression.kind !== ts.SyntaxKind.NullKeyword &&
        text(node.expression) !== 'undefined' &&
        !approved(node.expression)
      )
        report(
          node.expression,
          'raw-public-error-return',
          'Return userMessage(key) or toUserMessage(failure, fallbackKey) from this public error formatter; do not return raw exception text.'
        );
    }
    if (
      ts.isCallExpression(node) &&
      textSetters.has(callee(node)) &&
      !diagnosticSetters.has(callee(node)) &&
      node.arguments[0] &&
      diagnosticText(node.arguments[0]) &&
      scalarFailure(node.arguments[0]) &&
      raw(node.arguments[0])
    )
      report(
        node.arguments[0],
        'state-diagnostic',
        /partialEffects/u.test(text(node.arguments[0]))
          ? 'Use importReceiptMessage(receipt) for import outcomes, or project a validated userMessagePayload into UserMessage; keep partialEffects as private diagnostics.'
          : FIX
      );
    if (ts.isJsxExpression(node) && node.expression && raw(node.expression)) {
      const attribute = ts.isJsxAttribute(node.parent) ? text(node.parent.name) : null;
      if (
        !attribute ||
        (!/^(?:key|ref|className|data-|toolName$|on[A-Z])/u.test(attribute) &&
          (diagnosticText(node.expression) ||
            (!/^(?:id|className|style|data-|aria-describedby|aria-errormessage|aria-controls|htmlFor|href|src|poster|to|action|method|type|name|role|value|phase|stage|status|state|pendingState|variant|tone|intent|severity|can[A-Z]|is[A-Z]|has[A-Z]|show[A-Z]|hide[A-Z]|disabled|enabled|error|failure|reason|diagnostic)/u.test(
              attribute
            ) &&
              scalarFailure(node.expression))))
      )
        report(node.expression, 'display-diagnostic');
    }
    if (
      ts.isJsxSpreadAttribute(node) &&
      raw(node.expression) &&
      (diagnosticText(node.expression) ||
        (ts.isIdentifier(node.expression) && failureName(node.expression.text)))
    )
      report(node.expression, 'spread-diagnostic');
    if (filename.endsWith('packages/core/user-messages/src/catalog.ts')) {
      if (
        ts.isPropertyAssignment(node) &&
        (() => {
          for (let p = node.parent; p; p = p.parent)
            if (ts.isVariableDeclaration(p))
              return /^(?:USER_MESSAGES|USER_MESSAGE_TEMPLATES)$/u.test(text(p.name));
          return false;
        })() &&
        ts.isStringLiteralLike(node.initializer) &&
        (internalCopy(node.initializer.text) ||
          /\b(?:internal fixture|internal invariant|browser runtime|sidecar|renderer|preload|npm run|pnpm|apps\/desktop|vi\.stubEnv)\b/iu.test(
            node.initializer.text
          ))
      )
        report(node.initializer, 'catalog-internal-copy');
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      /^(?:userMessage|renderUserMessage|renderUserMessagePayload|resolveUserMessage|userMessagePayload|toUserMessage|toOptionalUserMessage|userMessageWithValues|userMessageValue|userEntityLabel|toOptionalUserEntityLabel|userToolLabel)$/u.test(
        text(node.name)
      )
    )
      report(node, 'shadowed-public-text-boundary');
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isCallExpression(node.expression) &&
      callee(node.expression) === 'JSON.stringify' &&
      /\b(?:output|toolData|failure|diagnostics|response)\b/u.test(
        text(node.expression.arguments[0])
      )
    )
      report(node.expression, 'raw-diagnostic-result');
    if (ts.isJsxText(node) && internalCopy(node.text)) report(node, 'internal-copy');
    if (ts.isCallExpression(node)) {
      const name = callee(node).split('.').at(-1);
      if (
        /^(?:showErrorBox|showMessageBox|showMessageBoxSync)$/u.test(name) &&
        !/^createUserDialogs\(dialog\)\./u.test(callee(node)) &&
        !filename.endsWith('/main/user-dialogs.ts') &&
        !(
          ts.isIdentifier(node.expression) &&
          /createUserDialogs/.test(text(bindingFor(node.expression)?.initializer))
        )
      )
        report(node.expression, 'untyped-native-dialog');
      if (
        /^(?:confirmDialog|promptDialog)$/u.test(callee(node)) &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const property of node.arguments[0].properties)
          if (
            ts.isPropertyAssignment(property) &&
            text(property.name) === 'message' &&
            !approved(property.initializer)
          )
            report(property.initializer, 'catalog-confirmation');
      }
      if (
        /^(?:toUserMessage|toOptionalUserMessage)$/u.test(name) &&
        node.arguments[0] &&
        approved(node.arguments[0], new Set(), false) &&
        ![ts.SyntaxKind.NullKeyword, ts.SyntaxKind.StringLiteral].includes(
          node.arguments[0].kind
        ) &&
        text(node.arguments[0]) !== 'undefined'
      )
        report(
          node.arguments[0],
          'public-message-reclassification',
          'Display the approved UserMessage directly. Convert unknown failures once in the responsible operation with toUserMessage(failure, fallbackKey).'
        );
      if (
        /^(?:toUserMessage|toOptionalUserMessage)$/.test(name) &&
        node.arguments[0] &&
        formattedCopy(node.arguments[0])
      )
        report(
          node.arguments[0],
          'formatted-copy-needs-catalog-template',
          'Build authored outcome text with userMessageWithValues(key, approvedValues), return UserMessage, and display it directly. Use toUserMessage only for unknown failures.'
        );
      if (
        name === 'toUserMessage' &&
        node.arguments[0] &&
        ts.isIdentifier(node.arguments[0]) &&
        containsView(bindingFor(node.arguments[0])?.initializer)
      )
        report(node.arguments[0], 'view-as-failure-text');
      const nativeTextArguments = /^(?:showErrorBox|fillText|drawText)$/u.test(name)
        ? name === 'showErrorBox'
          ? node.arguments.slice(0, 2)
          : node.arguments.slice(0, 1)
        : [];
      for (const argument of nativeTextArguments)
        if (raw(argument)) report(argument, 'native-display-diagnostic');
      if (/^(?:showMessageBox|showMessageBoxSync)$/u.test(name)) {
        for (const argument of node.arguments) {
          if (ts.isObjectLiteralExpression(argument))
            for (const property of argument.properties) {
              if (
                ts.isPropertyAssignment(property) &&
                /^(?:message|detail|title)$/u.test(text(property.name)) &&
                raw(property.initializer)
              )
                report(property.initializer, 'native-display-diagnostic');
            }
        }
      }
      const sink =
        /^(?:set\w*Error\w*|showError|alert|addToast|toast|notifyError)$/u.test(name) ||
        /(?:^|\.)toast\.(?:error|warning|info|success)$/u.test(callee(node));
      if (
        sink &&
        node.arguments[0] &&
        raw(node.arguments[0]) &&
        !diagnosticSetters.has(name) &&
        !structuredSetters.test(name)
      )
        report(node.arguments[0], 'message-sink');
      if (
        sink &&
        /^set\w*Error\w*$/u.test(name) &&
        !diagnosticSetters.has(name) &&
        !structuredSetters.test(name) &&
        node.arguments[0] &&
        !approved(node.arguments[0])
      ) {
        const value = unwrap(node.arguments[0]);
        if (
          ![
            ts.SyntaxKind.NullKeyword,
            ts.SyntaxKind.TrueKeyword,
            ts.SyntaxKind.FalseKeyword,
            ts.SyntaxKind.ObjectLiteralExpression,
            ts.SyntaxKind.ArrayLiteralExpression,
            ts.SyntaxKind.ArrowFunction,
          ].includes(value.kind) &&
          text(value) !== 'undefined' &&
          !(ts.isStringLiteralLike(value) && !value.text)
        )
          report(value, 'catalog-failure-state');
      }
      if (name === 'addToast' && node.arguments[0] && !approved(node.arguments[0]))
        report(node.arguments[0], 'catalog-toast');
      if (
        /^(?:renderUserMessage|userMessageValue|userEntityLabel|toOptionalUserEntityLabel)$/u.test(
          name
        ) &&
        node.arguments[0] &&
        (name === 'renderUserMessage'
          ? rawRenderInput(node.arguments[0])
          : raw(node.arguments[0])) &&
        !(
          name !== 'userMessageValue' &&
          name !== 'renderUserMessage' &&
          ts.isPropertyAccessExpression(unwrap(node.arguments[0])) &&
          /^(?:actorLabel|ownerLabel)$/u.test(unwrap(node.arguments[0]).name.text)
        )
      )
        report(node.arguments[0], 'diagnostic-as-display-data');
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      /^(?:textContent|innerText|innerHTML)$/u.test(node.left.name.text) &&
      raw(node.right)
    )
      report(node.right, 'dom-display-diagnostic');
    if (
      ts.isPropertyAssignment(node) &&
      /^(?:error|errorMessage|failureReason|message|detail|description|label|title|tooltip|summary|text)$/u.test(
        text(node.name)
      ) &&
      raw(node.initializer) &&
      !diagnosticContext(node)
    ) {
      let output = filename.endsWith('.tsx');
      for (let parent = node.parent; parent && !ts.isStatement(parent); parent = parent.parent) {
        if (
          ts.isCallExpression(parent) &&
          /(?:NextResponse|Response)\.json$|\.Toast\.Show$/u.test(callee(parent))
        )
          output = true;
      }
      if (output) report(node.initializer, 'forwarded-diagnostic');
    }
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ((ts.isNewExpression(node) &&
        /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError)$/u.test(
          text(node.expression)
        )) ||
        node.expression.kind === ts.SyntaxKind.SuperKeyword)
    ) {
      const value = node.arguments?.[0];
      let catalogConstructor = false;
      if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isClassDeclaration(parent)) {
            catalogConstructor =
              parent.heritageClauses?.some((clause) =>
                clause.types.some((type) => text(type.expression) === 'UserMessageError')
              ) ?? false;
            break;
          }
        }
      }
      const publicOrigin =
        /apps\/desktop\/src\/(?:hosted\/errors|services\/sidecar-session)\.ts$/u.test(filename);
      const legacyPublicCopy =
        /hosted browser runtime|VITE_API_URL is not set|tests: use vi\.stubEnv/u.test(
          literalCopy(value)
        );
      if (
        value &&
        ((publicOrigin && internalCopy(literalCopy(value))) || legacyPublicCopy) &&
        !diagnosticContext(node) &&
        !catalogConstructor
      )
        report(value, 'internal-error-copy');
    }
    if (
      ts.isAsExpression(node) &&
      /^(?:UserMessage|UserMessageInput|UserMessagePayload|UserEntityLabel|UserMessageValue|UserVisibleText)$/u.test(
        text(node.type)
      )
    )
      report(node, 'forged-public-text');
  });
  return findings.sort((a, b) => a.start - b.start);
}

module.exports = { inspectUserMessages, FIX, INTERNAL_TEXT };
