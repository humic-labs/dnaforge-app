const ts = require('typescript');

function collectStaticModuleSpecifiers(source, filename = 'bundle.js') {
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  if (parsed.parseDiagnostics.length > 0) {
    throw new Error(
      `Cannot inspect ${filename}: ${ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, ' ')}`
    );
  }
  return [
    ...new Set(
      parsed.statements
        .filter(
          (statement) => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        )
        .map((statement) => statement.moduleSpecifier)
        .filter((specifier) => specifier && ts.isStringLiteralLike(specifier))
        .map((specifier) => specifier.text)
    ),
  ];
}

module.exports = { collectStaticModuleSpecifiers };
