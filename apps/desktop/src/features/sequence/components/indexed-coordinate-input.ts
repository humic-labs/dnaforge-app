export function formatIndexedCoordinateInput(value: string): string {
  if (/[^\d,_\s]/.test(value)) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 3) return digits;

  const firstGroupLength = digits.length % 3 || 3;
  const groups = [digits.slice(0, firstGroupLength)];
  for (let index = firstGroupLength; index < digits.length; index += 3) {
    groups.push(digits.slice(index, index + 3));
  }
  return groups.join(',');
}

export function formatIndexedCoordinateInputEdit(
  value: string,
  selectionStart: number | null
): { value: string; selectionStart: number } {
  const rawSelectionStart = selectionStart ?? value.length;
  if (/[^\d,_\s]/.test(value)) {
    return { value, selectionStart: rawSelectionStart };
  }
  const digitsBeforeSelection = value.slice(0, rawSelectionStart).replace(/\D/g, '').length;
  const formattedValue = formatIndexedCoordinateInput(value);

  if (digitsBeforeSelection === 0) {
    return { value: formattedValue, selectionStart: 0 };
  }

  let seenDigits = 0;
  let formattedSelectionStart = formattedValue.length;
  for (let index = 0; index < formattedValue.length; index += 1) {
    if (/\d/.test(formattedValue[index] ?? '')) seenDigits += 1;
    if (seenDigits === digitsBeforeSelection) {
      formattedSelectionStart = index + 1;
      break;
    }
  }

  return { value: formattedValue, selectionStart: formattedSelectionStart };
}

export function parseIndexedCoordinateInput(value: string): number | null {
  if (!/^[\d,_\s]+$/.test(value)) return null;
  const digits = value.replace(/[,_\s]/g, '');
  if (!digits) return null;
  const coordinate = Number(digits);
  return Number.isSafeInteger(coordinate) && coordinate >= 1 ? coordinate : null;
}
