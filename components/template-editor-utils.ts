export interface TextInsertion {
  value: string;
  cursor: number;
}

export function insertTextAtSelection(
  value: string,
  insertion: string,
  selectionStart: number,
  selectionEnd: number,
): TextInsertion {
  const start = Math.max(0, Math.min(value.length, selectionStart));
  const end = Math.max(0, Math.min(value.length, selectionEnd));
  const from = Math.min(start, end);
  const to = Math.max(start, end);

  return {
    value: `${value.slice(0, from)}${insertion}${value.slice(to)}`,
    cursor: from + insertion.length,
  };
}
