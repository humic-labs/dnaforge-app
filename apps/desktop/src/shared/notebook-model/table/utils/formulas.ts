import type { Cell, CellPosition, CellRange, SelectionRange } from '../../../table-document-types';
import { readSavedFormulaResult } from '../../../source-formula-result';
import {
  boundedTableObservationCount,
  type TableCalculationObservation,
} from '../../../table-notebook-observation';
import { SUPPORTED_TABLE_FORMULAS, type SupportedTableFormula } from '../../../table-formulas';

function columnLetterToIndex(letter: string): number {
  let result = 0;
  for (let i = 0; i < letter.length; i++) {
    result = result * 26 + (letter.charCodeAt(i) - 64);
  }
  return result - 1;
}

export function columnIndexToLetter(index: number): string {
  let result = '';
  let n = index + 1;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = ref.match(/^\$?([A-Z]+)\$?(\d+)$/i);
  if (!match) return null;
  return {
    row: parseInt(match[2], 10) - 1,
    col: columnLetterToIndex(match[1].toUpperCase()),
  };
}

function buildCellRef(
  row: number,
  col: number,
  colAbsolute: boolean,
  rowAbsolute: boolean
): string {
  const colPart = (colAbsolute ? '$' : '') + columnIndexToLetter(col);
  const rowPart = (rowAbsolute ? '$' : '') + (row + 1);
  return colPart + rowPart;
}

function parseRange(range: string): CellRange | null {
  const parts = range.split(':');
  if (parts.length !== 2) return null;

  const start = parseCellRef(parts[0].trim());
  const end = parseCellRef(parts[1].trim());

  if (!start || !end) return null;

  return {
    startCol: Math.min(start.col, end.col),
    startRow: Math.min(start.row, end.row),
    endCol: Math.max(start.col, end.col),
    endRow: Math.max(start.row, end.row),
  };
}

type FormulaValue = string | number;
type FormulaOutcome = FormulaValue | FormulaEvaluationError;
type RangeProgress = { row: number; col: number; values: number[] };
type FormulaContext = {
  cells: Cell[][];
  depth: number;
  resolveCell: (row: number, col: number) => FormulaValue;
  ranges: Map<string, RangeProgress>;
  spend: (amount: number) => void;
};

class PendingFormulaCell {
  constructor(
    readonly row: number,
    readonly col: number
  ) {}
}

class FormulaEvaluationError {
  constructor(readonly value: string) {}
}

const FORMULA_ERRORS = new Set([
  '#REF',
  '#REF!',
  '#ERROR',
  '#EMPTY',
  '#DIV/0!',
  '#VALUE!',
  '#NUM!',
  '#NAME?',
]);
const MAX_FORMULA_NESTING = 128;
const MAX_FORMULA_RANGE_CELLS = 1_000_000;
const MAX_FORMULA_REVISION_WORK = 2_000_000;
const MAX_FORMULA_TEXT_LENGTH = 1_000_000;

function checkedValue(value: FormulaOutcome): FormulaValue {
  if (value instanceof FormulaEvaluationError) throw value;
  return value;
}

function formulaErrorResult(error: unknown): FormulaEvaluationError {
  if (error instanceof PendingFormulaCell) throw error;
  return error instanceof FormulaEvaluationError ? error : new FormulaEvaluationError('#ERROR');
}

function failFormula(value: string): never {
  throw new FormulaEvaluationError(value);
}

function getValuesFromRange(ctx: FormulaContext, range: CellRange): number[] {
  const key = `${range.startRow}:${range.startCol}:${range.endRow}:${range.endCol}`;
  let progress = ctx.ranges.get(key);
  if (!progress) {
    if (
      !Object.values(range).every(Number.isSafeInteger) ||
      range.startRow < 0 ||
      range.startCol < 0 ||
      range.endRow >= ctx.cells.length
    )
      failFormula('#REF');
    const height = range.endRow - range.startRow + 1;
    if (height * (range.endCol - range.startCol + 1) > MAX_FORMULA_RANGE_CELLS)
      failFormula('#ERROR');
    ctx.spend(height);
    for (let row = range.startRow; row <= range.endRow; row++) {
      if (range.endCol >= ctx.cells[row].length) failFormula('#REF');
    }
    progress = { row: range.startRow, col: range.startCol, values: [] };
    ctx.ranges.set(key, progress);
  }
  while (progress.row <= range.endRow) {
    ctx.spend(1);
    const val = ctx.resolveCell(progress.row, progress.col);
    const num = typeof val === 'number' ? val : parseFloat(val);
    if (!isNaN(num)) progress.values.push(num);
    progress.col++;
    if (progress.col > range.endCol) {
      progress.col = range.startCol;
      progress.row++;
    }
  }
  return progress.values;
}

function getCellByRef(ctx: FormulaContext, ref: string): string | number | null {
  const cellRef = parseCellRef(ref);
  if (!cellRef) return null;

  return ctx.resolveCell(cellRef.row, cellRef.col);
}

function indexOfMatchingClose(text: string): number {
  let depth = 1;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === stringChar) inString = false;
    } else if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function parseArguments(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];

    if (inString) {
      current += char;
      if (char === stringChar) {
        inString = false;
      }
    } else if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      current += char;
    } else if (char === '(') {
      depth++;
      current += char;
    } else if (char === ')') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

function evalArg(arg: string, ctx: FormulaContext): string | number {
  arg = arg.trim();
  ctx.spend(arg.length + 1);

  if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
    return arg.slice(1, -1);
  }

  const num = parseFloat(arg);
  if (!isNaN(num) && arg === String(num)) {
    return num;
  }

  if (arg.includes('(')) {
    return checkedValue(evaluateFormulaInContext('=' + arg, { ...ctx, depth: ctx.depth + 1 }));
  }

  const cellVal = getCellByRef(ctx, arg);
  if (cellVal !== null) {
    return cellVal;
  }

  const range = parseRange(arg);
  if (range) {
    const values = getValuesFromRange(ctx, range);
    return values[0] ?? 0;
  }

  return arg;
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : parseFloat(value);
}

function toText(value: string | number): string {
  return typeof value === 'string' ? value : String(value);
}

function evalArithmetic(expr: string, ctx: FormulaContext): number | string | null {
  if (!/[+\-*/]/.test(expr)) {
    return null;
  }

  const tokens = tokenizeArithmetic(expr);
  if (tokens.length === 0) return null;

  try {
    const result = parseExpression(tokens, ctx);
    if (typeof result === 'number' && !isNaN(result)) {
      return roundResult(result);
    }
    return result;
  } catch (error) {
    throw formulaErrorResult(error);
  }
}

function tokenizeArithmetic(expr: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;

  while (i < expr.length) {
    const char = expr[i];

    if (char === ' ') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      i++;
      continue;
    }

    if ('+-*/()'.includes(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }

      if (char === '-' && (tokens.length === 0 || /^[+\-*/(]$/.test(tokens[tokens.length - 1]))) {
        current = '-';
      } else {
        tokens.push(char);
      }
      i++;
      continue;
    }

    current += char;
    i++;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function parseExpression(
  tokens: string[],
  ctx: FormulaContext,
  pos: { index: number; depth?: number } = { index: 0 }
): number | string {
  let left = parseTerm(tokens, ctx, pos);
  if (typeof left === 'string') return left;

  while (pos.index < tokens.length) {
    const op = tokens[pos.index];
    if (op !== '+' && op !== '-') break;
    pos.index++;
    const right = parseTerm(tokens, ctx, pos);
    if (typeof right === 'string') return right;
    left = op === '+' ? left + right : left - right;
  }

  return left;
}

function parseTerm(
  tokens: string[],
  ctx: FormulaContext,
  pos: { index: number; depth?: number }
): number | string {
  let left = parseFactor(tokens, ctx, pos);
  if (typeof left === 'string') return left;

  while (pos.index < tokens.length) {
    const op = tokens[pos.index];
    if (op !== '*' && op !== '/') break;
    pos.index++;
    const right = parseFactor(tokens, ctx, pos);
    if (typeof right === 'string') return right;
    if (op === '/') {
      if (right === 0) failFormula('#DIV/0!');
      left = left / right;
    } else {
      left = left * right;
    }
  }

  return left;
}

function parseFactor(
  tokens: string[],
  ctx: FormulaContext,
  pos: { index: number; depth?: number }
): number | string {
  const token = tokens[pos.index];

  if (token === '(') {
    pos.depth = (pos.depth ?? 0) + 1;
    if (pos.depth > MAX_FORMULA_NESTING) failFormula('#ERROR');
    pos.index++;
    const result = parseExpression(tokens, ctx, pos);
    pos.depth--;
    if (tokens[pos.index] === ')') {
      pos.index++;
    }
    return result;
  }

  pos.index++;

  const num = parseFloat(token);
  if (!isNaN(num)) {
    return num;
  }

  const cellVal = getCellByRef(ctx, token);
  if (cellVal !== null) {
    if (typeof cellVal === 'number') return cellVal;
    const parsed = parseFloat(String(cellVal));
    if (!isNaN(parsed)) return parsed;
    return failFormula('#VALUE!');
  }

  return failFormula('#VALUE!');
}

function evalComparison(expr: string, ctx: FormulaContext): boolean {
  const operators = ['>=', '<=', '<>', '!=', '=', '>', '<'];

  for (const op of operators) {
    const idx = expr.indexOf(op);
    if (idx === -1) continue;

    const left = evalArg(expr.slice(0, idx), ctx);
    const right = evalArg(expr.slice(idx + op.length), ctx);

    const leftNum = toNumber(left);
    const rightNum = toNumber(right);
    const useNumeric = !isNaN(leftNum) && !isNaN(rightNum);
    const a: number | string = useNumeric ? leftNum : String(left);
    const b: number | string = useNumeric ? rightNum : String(right);

    switch (op) {
      case '>=':
        return a >= b;
      case '<=':
        return a <= b;
      case '<>':
      case '!=':
        return a !== b;
      case '=':
        return a === b;
      case '>':
        return a > b;
      case '<':
        return a < b;
    }
  }

  const val = evalArg(expr, ctx);
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') return val !== '' && val.toUpperCase() !== 'FALSE';
  return Boolean(val);
}

type FormulaFn = (args: string[], ctx: FormulaContext) => FormulaOutcome | boolean;

const argValue = (ctx: FormulaContext, arg: string) => evalArg(arg, ctx);
const argNumber = (ctx: FormulaContext, arg: string) => toNumber(argValue(ctx, arg));
const argText = (ctx: FormulaContext, arg: string) => toText(argValue(ctx, arg));
const argCondition = (ctx: FormulaContext, arg: string) => evalComparison(arg, ctx);

function branchValue(ctx: FormulaContext, arg: string): FormulaOutcome {
  try {
    return argValue(ctx, arg);
  } catch (error) {
    return formulaErrorResult(error);
  }
}

const aggregateFn =
  (reduce: (values: number[]) => number): FormulaFn =>
  (args, ctx) =>
    reduce(getAggregateValues(args, ctx));

const textFn =
  (transform: (value: string) => string | number): FormulaFn =>
  (args, ctx) =>
    args.length < 1 ? failFormula('#VALUE!') : transform(argText(ctx, args[0]));

const sliceFn =
  (take: (value: string, count: number) => string): FormulaFn =>
  (args, ctx) => {
    if (args.length < 1) return failFormula('#VALUE!');
    const value = argText(ctx, args[0]);
    const count = args.length > 1 ? argNumber(ctx, args[1]) : 1;
    return isNaN(count) ? failFormula('#VALUE!') : take(value, count);
  };

const mean = (values: number[]) =>
  values.length === 0 ? 0 : roundResult(values.reduce((a, b) => a + b, 0) / values.length);

const joinArgs: FormulaFn = (args, ctx) => {
  let length = 0;
  const parts = args.map((arg) => {
    const value = argText(ctx, arg);
    length += value.length;
    if (length > MAX_FORMULA_TEXT_LENGTH) failFormula('#ERROR');
    return value;
  });
  return parts.join('');
};

const FORMULA_FUNCTIONS = {
  SUM: aggregateFn((values) => values.reduce((a, b) => a + b, 0)),
  AVG: aggregateFn(mean),

  AVERAGE: aggregateFn(mean),
  COUNT: aggregateFn((values) => values.length),
  MIN: aggregateFn((values) => (values.length === 0 ? 0 : values.reduce((a, b) => Math.min(a, b)))),
  MAX: aggregateFn((values) => (values.length === 0 ? 0 : values.reduce((a, b) => Math.max(a, b)))),
  MEDIAN: aggregateFn((values) => {
    const sorted = values.sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? roundResult((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
  }),
  PRODUCT: aggregateFn((values) => (values.length === 0 ? 0 : values.reduce((a, b) => a * b, 1))),

  ROUND: (args, ctx) => {
    if (args.length < 1) return failFormula('#VALUE!');
    const value = argNumber(ctx, args[0]);
    const decimals = args.length > 1 ? argNumber(ctx, args[1]) : 0;
    if (isNaN(value) || isNaN(decimals)) return failFormula('#VALUE!');
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  },
  ABS: (args, ctx) => {
    if (args.length < 1) return failFormula('#VALUE!');
    const value = argNumber(ctx, args[0]);
    return isNaN(value) ? failFormula('#VALUE!') : Math.abs(value);
  },

  SQRT: (args, ctx) => {
    if (args.length < 1) return failFormula('#VALUE!');
    const value = argNumber(ctx, args[0]);
    return isNaN(value) || value < 0 ? failFormula('#NUM!') : roundResult(Math.sqrt(value));
  },
  POWER: (args, ctx) => {
    if (args.length < 2) return failFormula('#VALUE!');
    const base = argNumber(ctx, args[0]);
    const exp = argNumber(ctx, args[1]);
    return isNaN(base) || isNaN(exp) ? failFormula('#VALUE!') : roundResult(Math.pow(base, exp));
  },

  LEN: textFn((value) => value.length),
  TRIM: textFn((value) => value.trim().replace(/\s+/g, ' ')),
  UPPER: textFn((value) => value.toUpperCase()),
  LOWER: textFn((value) => value.toLowerCase()),
  LEFT: sliceFn((value, count) => value.substring(0, count)),
  RIGHT: sliceFn((value, count) => value.substring(value.length - count)),
  MID: (args, ctx) => {
    if (args.length < 3) return failFormula('#VALUE!');
    const value = argText(ctx, args[0]);
    const start = argNumber(ctx, args[1]);
    const count = argNumber(ctx, args[2]);
    if (isNaN(start) || isNaN(count)) return failFormula('#VALUE!');
    return value.substring(start - 1, start - 1 + count);
  },
  CONCAT: joinArgs,
  CONCATENATE: joinArgs,
  SUBSTITUTE: (args, ctx) => {
    if (args.length < 3) return failFormula('#VALUE!');
    const value = argText(ctx, args[0]);
    const oldText = argText(ctx, args[1]);
    const newText = argText(ctx, args[2]);
    if (args.length <= 3) {
      let matches = 0;
      if (oldText === '') matches = Math.max(0, value.length - 1);
      else
        for (
          let at = value.indexOf(oldText);
          at !== -1;
          at = value.indexOf(oldText, at + oldText.length)
        ) {
          matches++;
        }
      const length = value.length + matches * (newText.length - oldText.length);
      if (length > MAX_FORMULA_TEXT_LENGTH) failFormula('#ERROR');
      return value.split(oldText).join(newText);
    }

    const instance = argNumber(ctx, args[3]);
    if (isNaN(instance)) return failFormula('#VALUE!');
    let count = 0;
    return value.replace(new RegExp(escapeRegex(oldText), 'g'), (match) => {
      count++;
      if (count !== instance) return match;
      if (value.length - match.length + newText.length > MAX_FORMULA_TEXT_LENGTH)
        failFormula('#ERROR');
      return newText;
    });
  },

  IF: (args, ctx) => {
    if (args.length < 2) return failFormula('#VALUE!');
    const condition = argCondition(ctx, args[0]);
    const trueVal = branchValue(ctx, args[1]);
    const falseVal = args.length > 2 ? branchValue(ctx, args[2]) : false;
    return condition ? trueVal : falseVal;
  },
  AND: (args, ctx) => args.every((arg) => argCondition(ctx, arg)),
  OR: (args, ctx) => args.some((arg) => argCondition(ctx, arg)),
  NOT: (args, ctx) => (args.length < 1 ? failFormula('#VALUE!') : !argCondition(ctx, args[0])),
  ISBLANK: (args, ctx) => {
    if (args.length < 1) return failFormula('#VALUE!');
    const value = argValue(ctx, args[0]);
    return value === '' || value === 0;
  },
  ISNUMBER: (args, ctx) => {
    if (args.length < 1) return failFormula('#VALUE!');
    const value = argValue(ctx, args[0]);
    return typeof value === 'number' || !isNaN(parseFloat(String(value)));
  },
  IFERROR: (args, ctx) => {
    if (args.length < 2) return failFormula('#VALUE!');
    const value = branchValue(ctx, args[0]);
    return value instanceof FormulaEvaluationError ||
      (typeof value === 'string' && value.startsWith('#'))
      ? argValue(ctx, args[1])
      : value;
  },
} satisfies Record<SupportedTableFormula, FormulaFn>;

function getAggregateValues(args: string[], ctx: FormulaContext): number[] {
  const values: number[] = [];

  for (const arg of args) {
    const trimmed = arg.trim();

    const range = parseRange(trimmed);
    if (range) {
      for (const value of getValuesFromRange(ctx, range)) {
        ctx.spend(1);
        values.push(value);
      }
      continue;
    }

    const val = evalArg(trimmed, ctx);
    const num = toNumber(val);
    if (!isNaN(num)) {
      values.push(num);
    }
  }

  return values;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function roundResult(num: number): number {
  if (!Number.isFinite(num)) return num;
  return Math.round(num * 1000000) / 1000000;
}

export function isFormula(value: string): boolean {
  return value.trim().startsWith('=');
}

function formulaRevision(cells: Cell[][]) {
  const memo = new Map<string, FormulaOutcome>();
  const active = new Set<string>();
  const activePath: string[] = [];
  const cyclic = new Set<string>();
  let remainingWork = MAX_FORMULA_REVISION_WORK;
  const spend = (amount: number) => {
    remainingWork -= amount;
    if (remainingWork < 0) failFormula('#ERROR');
  };
  const keyOf = (row: number, col: number) => `${row}:${col}`;
  const resolvedValue = (outcome: FormulaOutcome): FormulaValue => {
    const value = checkedValue(outcome);
    spend(typeof value === 'string' && value.length > 64 ? value.length : 1);
    return value;
  };
  const read = (row: number, col: number): FormulaValue => {
    if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col) || row < 0 || col < 0)
      return failFormula('#REF');
    const cell = cells[row]?.[col];
    if (!cell) return failFormula('#REF');
    const key = keyOf(row, col);
    if (active.has(key)) {
      for (const member of activePath.slice(activePath.indexOf(key))) cyclic.add(member);
      return failFormula('#REF');
    }
    const saved = readSavedFormulaResult(cell);
    if (saved) return resolvedValue(saved.value ?? '');
    if (!isFormula(cell.value)) return resolvedValue(cell.value);
    if (memo.has(key)) return resolvedValue(memo.get(key)!);
    throw new PendingFormulaCell(row, col);
  };

  const evaluate = (formula: string, row: number, col: number): FormulaValue => {
    const stack = [{ formula, row, col, ranges: new Map<string, RangeProgress>() }];
    active.add(keyOf(row, col));
    activePath.push(keyOf(row, col));
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      try {
        const evaluated = evaluateFormulaInContext(frame.formula, {
          cells,
          depth: 0,
          resolveCell: read,
          ranges: frame.ranges,
          spend,
        });
        const value = cyclic.has(keyOf(frame.row, frame.col))
          ? new FormulaEvaluationError('#REF')
          : evaluated;
        memo.set(keyOf(frame.row, frame.col), value);
        active.delete(keyOf(frame.row, frame.col));
        activePath.pop();
        stack.pop();
        if (stack.length === 0)
          return value instanceof FormulaEvaluationError ? value.value : value;
      } catch (error) {
        if (!(error instanceof PendingFormulaCell)) throw error;
        active.add(keyOf(error.row, error.col));
        activePath.push(keyOf(error.row, error.col));
        stack.push({
          formula: cells[error.row][error.col].value,
          row: error.row,
          col: error.col,
          ranges: new Map<string, RangeProgress>(),
        });
      }
    }
    return '#ERROR';
  };

  return {
    evaluate,
    outcome(row: number, col: number): FormulaOutcome {
      try {
        return read(row, col);
      } catch (error) {
        if (error instanceof FormulaEvaluationError) return error;
        if (!(error instanceof PendingFormulaCell)) throw error;
        evaluate(cells[row][col].value, row, col);
        return memo.get(keyOf(row, col)) ?? new FormulaEvaluationError('#ERROR');
      }
    },
    resolve(row: number, col: number): FormulaValue {
      try {
        return read(row, col);
      } catch (error) {
        if (error instanceof FormulaEvaluationError) return error.value;
        if (!(error instanceof PendingFormulaCell)) throw error;
        return evaluate(cells[row][col].value, row, col);
      }
    },
  };
}

export function evaluateFormula(
  formula: string,
  cells: Cell[][],
  currentRow: number,
  currentCol: number
): string | number {
  return formulaRevision(cells).evaluate(formula, currentRow, currentCol);
}

function evaluateFormulaInContext(formula: string, ctx: FormulaContext): FormulaOutcome {
  if (ctx.depth > MAX_FORMULA_NESTING) return new FormulaEvaluationError('#ERROR');
  try {
    ctx.spend(formula.length + 1);
    const result = evaluateFormulaExpression(formula, ctx);
    if (typeof result === 'string' && result.length > MAX_FORMULA_TEXT_LENGTH)
      failFormula('#ERROR');
    return result;
  } catch (error) {
    return formulaErrorResult(error);
  }
}

function evaluateFormulaExpression(formula: string, ctx: FormulaContext): FormulaOutcome {
  const trimmed = formula.trim().substring(1);
  if (FORMULA_ERRORS.has(trimmed)) return new FormulaEvaluationError(trimmed);

  if (!trimmed || trimmed.trim() === '') {
    return new FormulaEvaluationError('#EMPTY');
  }

  const funcMatch = trimmed.match(/^([A-Z_]+)\((.*)$/i);

  if (funcMatch) {
    const funcName = funcMatch[1].toUpperCase();
    const rest = funcMatch[2];

    const argsEnd = indexOfMatchingClose(rest);
    const argsStr = argsEnd === -1 ? '' : rest.substring(0, argsEnd);
    const fn = isSupportedTableFormula(funcName) ? FORMULA_FUNCTIONS[funcName] : undefined;

    if (fn) {
      const args = parseArguments(argsStr);
      try {
        const result = fn(args, ctx);

        if (typeof result === 'boolean') {
          return result ? 'TRUE' : 'FALSE';
        }
        return result;
      } catch (error) {
        return formulaErrorResult(error);
      }
    }
    return new FormulaEvaluationError('#NAME?');
  }

  const cellRef = parseCellRef(trimmed);
  if (cellRef) {
    const val = getCellByRef(ctx, trimmed);
    return val ?? new FormulaEvaluationError('#REF');
  }

  const arithmeticResult = evalArithmetic(trimmed, ctx);
  if (arithmeticResult !== null) {
    return arithmeticResult;
  }

  try {
    const result = evalComparison(trimmed, ctx);
    return result ? 'TRUE' : 'FALSE';
  } catch (error) {
    return formulaErrorResult(error);
  }
}

export function evaluateAllFormulas(cells: Cell[][]): Cell[][] {
  return evaluateTableRevision(cells).cells;
}

export function evaluateTableRevision(cells: Cell[][]): {
  cells: Cell[][];
  calculation: TableCalculationObservation;
} {
  const revision = formulaRevision(cells);
  let evaluatedCount = 0,
    errorCount = 0,
    savedCount = 0,
    staleCount = 0,
    unavailableCount = 0;
  const result = cells.map((row, rowIndex) =>
    row.map((cell, colIndex) => {
      const saved = readSavedFormulaResult(cell);
      if (saved) {
        if (saved.value === null) unavailableCount += 1;
        else {
          savedCount += 1;
          if (saved.stale) staleCount += 1;
        }
      }
      if (isFormula(cell.value) && !saved) {
        const outcome = revision.outcome(rowIndex, colIndex);
        evaluatedCount += 1;
        if (outcome instanceof FormulaEvaluationError) errorCount += 1;
        const computed = outcome instanceof FormulaEvaluationError ? outcome.value : outcome;
        return { ...cell, type: 'formula' as const, computed };
      }
      return cell;
    })
  );
  return {
    cells: result,
    calculation: {
      result:
        errorCount > 0
          ? savedCount > 0 || unavailableCount > 0
            ? 'mixed_failed'
            : 'failed'
          : unavailableCount > 0
            ? 'unavailable'
            : evaluatedCount === 0
              ? savedCount === 0
                ? 'none'
                : staleCount === 0
                  ? 'saved'
                  : 'saved_stale'
              : savedCount === 0
                ? errorCount === 0
                  ? 'evaluated'
                  : 'failed'
                : errorCount === 0
                  ? 'mixed'
                  : 'mixed_failed',
      evaluatedCount: boundedTableObservationCount(evaluatedCount),
      errorCount: boundedTableObservationCount(errorCount),
      savedCount: boundedTableObservationCount(savedCount),
      staleCount: boundedTableObservationCount(staleCount),
      unavailableCount: boundedTableObservationCount(unavailableCount),
    },
  };
}

export function getSupportedFormulas(): string[] {
  return [...SUPPORTED_TABLE_FORMULAS].sort();
}

function isSupportedTableFormula(value: string): value is SupportedTableFormula {
  return (SUPPORTED_TABLE_FORMULAS as readonly string[]).includes(value);
}

export interface FormulaOption {
  name: SupportedTableFormula;
  syntax: string;
  description: string;
  example: string;
}

export const FORMULA_OPTIONS: FormulaOption[] = [
  {
    name: 'SUM',
    syntax: 'SUM(range)',
    description: 'Add all numbers in a range',
    example: '=SUM(A1:A10)',
  },
  {
    name: 'AVG',
    syntax: 'AVG(range)',
    description: 'Calculate average of numbers',
    example: '=AVG(B1:B5)',
  },
  {
    name: 'COUNT',
    syntax: 'COUNT(range)',
    description: 'Count cells with numbers',
    example: '=COUNT(A1:C3)',
  },
  {
    name: 'MIN',
    syntax: 'MIN(range)',
    description: 'Find smallest value',
    example: '=MIN(A1:A10)',
  },
  { name: 'MAX', syntax: 'MAX(range)', description: 'Find largest value', example: '=MAX(A1:A10)' },
  {
    name: 'MEDIAN',
    syntax: 'MEDIAN(range)',
    description: 'Find middle value',
    example: '=MEDIAN(A1:A10)',
  },
  {
    name: 'PRODUCT',
    syntax: 'PRODUCT(range)',
    description: 'Multiply all numbers',
    example: '=PRODUCT(A1:A5)',
  },

  {
    name: 'ROUND',
    syntax: 'ROUND(value, decimals)',
    description: 'Round to decimal places',
    example: '=ROUND(A1, 2)',
  },
  { name: 'ABS', syntax: 'ABS(value)', description: 'Absolute value', example: '=ABS(A1)' },
  { name: 'SQRT', syntax: 'SQRT(value)', description: 'Square root', example: '=SQRT(A1)' },
  {
    name: 'POWER',
    syntax: 'POWER(base, exp)',
    description: 'Raise to power',
    example: '=POWER(2, 8)',
  },

  { name: 'LEN', syntax: 'LEN(text)', description: 'Length of text', example: '=LEN(A1)' },
  { name: 'TRIM', syntax: 'TRIM(text)', description: 'Remove extra spaces', example: '=TRIM(A1)' },
  {
    name: 'UPPER',
    syntax: 'UPPER(text)',
    description: 'Convert to uppercase',
    example: '=UPPER(A1)',
  },
  {
    name: 'LOWER',
    syntax: 'LOWER(text)',
    description: 'Convert to lowercase',
    example: '=LOWER(A1)',
  },
  {
    name: 'LEFT',
    syntax: 'LEFT(text, count)',
    description: 'First N characters',
    example: '=LEFT(A1, 3)',
  },
  {
    name: 'RIGHT',
    syntax: 'RIGHT(text, count)',
    description: 'Last N characters',
    example: '=RIGHT(A1, 3)',
  },
  {
    name: 'MID',
    syntax: 'MID(text, start, count)',
    description: 'Extract substring',
    example: '=MID(A1, 2, 3)',
  },
  {
    name: 'CONCAT',
    syntax: 'CONCAT(a, b, ...)',
    description: 'Join text values',
    example: '=CONCAT(A1, " ", B1)',
  },
  {
    name: 'SUBSTITUTE',
    syntax: 'SUBSTITUTE(text, old, new)',
    description: 'Replace text',
    example: '=SUBSTITUTE(A1, "old", "new")',
  },

  {
    name: 'IF',
    syntax: 'IF(cond, true, false)',
    description: 'Conditional value',
    example: '=IF(A1>100, "High", "Low")',
  },
  {
    name: 'AND',
    syntax: 'AND(cond1, cond2, ...)',
    description: 'All conditions true',
    example: '=AND(A1>0, A1<100)',
  },
  {
    name: 'OR',
    syntax: 'OR(cond1, cond2, ...)',
    description: 'Any condition true',
    example: '=OR(A1="Yes", A1="Y")',
  },
  {
    name: 'NOT',
    syntax: 'NOT(condition)',
    description: 'Negate condition',
    example: '=NOT(A1>100)',
  },
  {
    name: 'ISBLANK',
    syntax: 'ISBLANK(cell)',
    description: 'Check if empty',
    example: '=ISBLANK(A1)',
  },
  {
    name: 'ISNUMBER',
    syntax: 'ISNUMBER(cell)',
    description: 'Check if number',
    example: '=ISNUMBER(A1)',
  },
  {
    name: 'IFERROR',
    syntax: 'IFERROR(value, fallback)',
    description: 'Handle errors',
    example: '=IFERROR(A1/B1, 0)',
  },
];

export function filterFormulaOptions(searchTerm: string): FormulaOption[] {
  if (!searchTerm) return FORMULA_OPTIONS;
  const upper = searchTerm.toUpperCase();
  return FORMULA_OPTIONS.filter((opt) => opt.name.startsWith(upper));
}

export function closeUnclosedFormula(value: string): string {
  if (!value.startsWith('=')) return value;

  let open = 0;
  let close = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (inString) {
      if (c === stringChar) inString = false;
    } else if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
    } else if (c === '(') {
      open++;
    } else if (c === ')') {
      close++;
    }
  }

  if (inString) return value;

  return open - close === 1 ? value + ')' : value;
}

export function insertCellReferenceAtCursor(
  value: string,
  cursorPosition: number,
  referenceText: string
): { newValue: string; newCursorPosition: number } {
  const beforeCursor = value.slice(0, cursorPosition);
  const afterCursor = value.slice(cursorPosition);

  const rangeMatch = beforeCursor.match(/:([A-Z]+)(\d+)$/i);
  if (rangeMatch) {
    const insertPos = cursorPosition - rangeMatch[0].length + 1;
    const newValue = value.slice(0, insertPos) + referenceText + afterCursor;
    return { newValue, newCursorPosition: insertPos + referenceText.length };
  }

  const refMatch = beforeCursor.match(/(\$?)([A-Z]+)(\$?)(\d+)$/i);
  if (refMatch) {
    const insertPos = cursorPosition - refMatch[0].length;
    const newValue = value.slice(0, insertPos) + referenceText + afterCursor;
    return { newValue, newCursorPosition: insertPos + referenceText.length };
  }

  const lastChar = beforeCursor.slice(-1);
  const needsSeparator = !!lastChar && !/[(,:+\-*/=]/.test(lastChar);
  const separator = needsSeparator ? ',' : '';
  const newValue = beforeCursor + separator + referenceText + afterCursor;
  return {
    newValue,
    newCursorPosition: cursorPosition + separator.length + referenceText.length,
  };
}

export function buildFormulaReferenceText(
  anchor: CellPosition,
  selection: SelectionRange | null
): string {
  const isRange =
    selection !== null &&
    (selection.startRow !== selection.endRow || selection.startCol !== selection.endCol);

  if (isRange && selection) {
    const startRef = columnIndexToLetter(selection.startCol) + (selection.startRow + 1);
    const endRef = columnIndexToLetter(selection.endCol) + (selection.endRow + 1);
    return `${startRef}:${endRef}`;
  }
  return columnIndexToLetter(anchor.col) + (anchor.row + 1);
}

export function adjustFormula(
  formula: string,
  rowDelta: number,
  colDelta: number,
  maxRow: number,
  maxCol: number
): string {
  if (!isFormula(formula)) return formula;

  const cellRefRegex = /(\$?)([A-Z]+)(\$?)(\d+)/gi;

  let hasError = false;

  const rewrite = (part: string) =>
    part.replace(
      cellRefRegex,
      (match, colDollar, colLetters, rowDollar, rowNum, offset: number) => {
        const before = part[offset - 1] ?? '';
        const after = part[offset + match.length] ?? '';
        if (
          /[A-Z0-9_.$]/i.test(before) ||
          /[A-Z0-9_.$]/i.test(after) ||
          part
            .slice(offset + match.length)
            .trimStart()
            .startsWith('(')
        )
          return match;
        const colAbsolute = colDollar === '$';
        const rowAbsolute = rowDollar === '$';

        let col = columnLetterToIndex(colLetters.toUpperCase());
        let row = parseInt(rowNum, 10) - 1;

        if (!colAbsolute) {
          col += colDelta;
        }
        if (!rowAbsolute) {
          row += rowDelta;
        }

        if (col < 0 || col > maxCol || row < 0 || row > maxRow) {
          hasError = true;
          return '#REF!';
        }

        return buildCellRef(row, col, colAbsolute, rowAbsolute);
      }
    );

  let adjusted = '';
  let start = 0;
  let quote = '';
  for (let index = 0; index < formula.length; index++) {
    const char = formula[index];
    if (quote) {
      if (char === quote) {
        if (formula[index + 1] === quote) {
          index++;
          continue;
        }
        adjusted += formula.slice(start, index + 1);
        start = index + 1;
        quote = '';
      }
    } else if (char === '"' || char === "'") {
      adjusted += rewrite(formula.slice(start, index));
      start = index;
      quote = char;
    }
  }
  adjusted += quote ? formula.slice(start) : rewrite(formula.slice(start));

  if (hasError) {
    return '=#REF!';
  }

  return adjusted;
}

export function fillFormula(
  sourceFormula: string,
  sourceRow: number,
  sourceCol: number,
  targetRow: number,
  targetCol: number,
  maxRow: number,
  maxCol: number
): string {
  return adjustFormula(sourceFormula, targetRow - sourceRow, targetCol - sourceCol, maxRow, maxCol);
}
