export type DiffOperation = "unchanged" | "added" | "removed";

export interface DiffChunk {
  readonly operation: DiffOperation;
  readonly lines: readonly string[];
}

const maximumLinesPerSide = 2_000;

function elementAt<Value>(values: readonly Value[], index: number): Value {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`Internal diff index ${index} is outside the collection`);
  }
  return value;
}

function matrixValue(matrix: readonly (readonly number[])[], row: number, column: number): number {
  return elementAt(elementAt(matrix, row), column);
}

function splitPreservingLegalText(text: string): readonly string[] {
  return text.split("\n");
}

export function diffLegalText(beforeText: string, afterText: string): readonly DiffChunk[] {
  const before = splitPreservingLegalText(beforeText);
  const after = splitPreservingLegalText(afterText);

  if (before.length > maximumLinesPerSide || after.length > maximumLinesPerSide) {
    throw new RangeError(`Diff input exceeds ${maximumLinesPerSide} lines per side`);
  }

  const lengths = Array.from({ length: before.length + 1 }, () =>
    Array.from({ length: after.length + 1 }, () => 0),
  );

  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const row = elementAt(lengths, beforeIndex);
      row[afterIndex] =
        elementAt(before, beforeIndex) === elementAt(after, afterIndex)
          ? matrixValue(lengths, beforeIndex + 1, afterIndex + 1) + 1
          : Math.max(
              matrixValue(lengths, beforeIndex + 1, afterIndex),
              matrixValue(lengths, beforeIndex, afterIndex + 1),
            );
    }
  }

  const operations: Array<{ operation: DiffOperation; line: string }> = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < before.length && afterIndex < after.length) {
    if (elementAt(before, beforeIndex) === elementAt(after, afterIndex)) {
      operations.push({ operation: "unchanged", line: elementAt(before, beforeIndex) });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      matrixValue(lengths, beforeIndex + 1, afterIndex) >=
      matrixValue(lengths, beforeIndex, afterIndex + 1)
    ) {
      operations.push({ operation: "removed", line: elementAt(before, beforeIndex) });
      beforeIndex += 1;
    } else {
      operations.push({ operation: "added", line: elementAt(after, afterIndex) });
      afterIndex += 1;
    }
  }

  while (beforeIndex < before.length) {
    operations.push({ operation: "removed", line: elementAt(before, beforeIndex) });
    beforeIndex += 1;
  }

  while (afterIndex < after.length) {
    operations.push({ operation: "added", line: elementAt(after, afterIndex) });
    afterIndex += 1;
  }

  const chunks: Array<{ operation: DiffOperation; lines: string[] }> = [];
  for (const operation of operations) {
    const previous = chunks.at(-1);
    if (previous?.operation === operation.operation) {
      previous.lines.push(operation.line);
    } else {
      chunks.push({ operation: operation.operation, lines: [operation.line] });
    }
  }

  return chunks;
}
