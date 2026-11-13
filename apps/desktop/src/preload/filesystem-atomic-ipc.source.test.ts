// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';

const preloadSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
const declarationSource = readFileSync(resolve(__dirname, 'index.d.ts'), 'utf8');
const contractSource = readFileSync(resolve(__dirname, '../shared/ipc/fs.contract.ts'), 'utf8');

function hasRequiredFsContractClient(source: string): boolean {
  const tree = ts.createSourceFile('index.d.ts', source, ts.ScriptTarget.Latest, true);
  const api = tree.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'ElectronAPI'
  );
  const field = api?.members.find(
    (node): node is ts.PropertySignature =>
      ts.isPropertySignature(node) && ts.isIdentifier(node.name) && node.name.text === 'fs'
  );
  if (!field?.type || field.questionToken) return false;
  const parts = ts.isIntersectionTypeNode(field.type) ? field.type.types : [field.type];
  if (parts.some((part) => part.kind === ts.SyntaxKind.AnyKeyword)) return false;
  return (
    parts.filter((part) => {
      if (
        !ts.isTypeReferenceNode(part) ||
        !ts.isIdentifier(part.typeName) ||
        part.typeName.text !== 'ClientOf' ||
        part.typeArguments?.length !== 1
      )
        return false;
      const argument = part.typeArguments[0];
      return (
        ts.isTypeQueryNode(argument) &&
        ts.isIdentifier(argument.exprName) &&
        argument.exprName.text === 'fsContract'
      );
    }).length === 1
  );
}

describe('atomic text-file preload bridge', () => {
  it('exposes one typed invoke without composing renderer-side temp operations', () => {
    expect(contractSource).toContain(
      'writeTextFileAtomic: invoke<[input: TextFileAtomicWriteInput], void>()'
    );
    expect(preloadSource).toContain('...createClient(fsContract)');
    expect(preloadSource).not.toContain('writeTextFileAtomic:');
  });

  it('publishes the same typed method in ElectronAPI', () => {
    expect(hasRequiredFsContractClient(declarationSource)).toBe(true);
  });
});
