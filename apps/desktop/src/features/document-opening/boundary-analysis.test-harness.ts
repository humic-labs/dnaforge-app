import ts from 'typescript';

const entrypoints =
  /^(?:openSequenceFile|openSequenceDocument|openManagedSequenceDocument|openSequencePackage|openStructureFile)(?:Result)?$/;

export function needsDocumentOpeningAst(source: string): boolean {
  return (
    source.includes('openSequenceFile') ||
    source.includes('openStructureFile') ||
    source.includes('\\')
  );
}

export function documentOpeningViolations(
  path: string,
  name: string,
  source: string,
  forceOriginalAst = false
): string[] {
  const violations: string[] = [];
  if (forceOriginalAst || needsDocumentOpeningAst(source)) {
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const coordinator = name === 'features/document-opening/open-document.ts';
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const module = node.moduleSpecifier.text;
        if (/openSequenceFile$|openStructureFile$/.test(module) && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const binding of bindings.elements) {
              if (
                !binding.isTypeOnly &&
                entrypoints.test((binding.propertyName ?? binding.name).text) &&
                !coordinator
              )
                violations.push(`${name}: bypasses coordinator`);
            }
          }
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const module = node.arguments[0];
        if (
          module &&
          ts.isStringLiteral(module) &&
          /openSequenceFile$|openStructureFile$/.test(module.text) &&
          !coordinator
        ) {
          const statement = node.parent.parent.parent.getText(ast);
          if (
            !(
              name === 'main.tsx' &&
              /holdNextStructureOpenBeforeCommitForTest|getStructureOpenCancellationDiagnosticsForTest/.test(
                statement
              )
            )
          )
            violations.push(`${name}: lazy bypasses coordinator`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  if (
    /features\/(?:sequence\/openSequenceFile|structure-files\/openStructureFile|page\/open-workspace-document|design\/open-design-document|primers\/open-primer-document|lims\/open-entity-artifact)\.ts$/.test(
      name
    )
  ) {
    if (/\.(?:openTab|openInFocusedPanel|openWithSmartPlacement)\s*\(/.test(source))
      violations.push(`${name}: bypasses presenter`);
  }
  if (
    name === 'App.tsx' &&
    /\b(?:parseEntityArtifact|reconcileEntityFile|withWorkspaceArtifactOpen|upsertPageFromArtifact|upsertDesignFromArtifact)\b/.test(
      source
    )
  )
    violations.push('App.tsx: document preparation returned to the shell');
  return violations;
}
