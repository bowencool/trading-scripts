type ColorName = "cyan" | "green" | "red" | "yellow";

type ColorStream = {
  isTTY?: boolean;
};

const ANSI_CODES: Record<ColorName, number> = {
  cyan: 36,
  green: 32,
  red: 31,
  yellow: 33,
};

export function supportsColor(stream: ColorStream = process.stdout): boolean {
  return stream.isTTY === true;
}

export function colorize(
  value: string | number,
  color: ColorName,
  stream: ColorStream = process.stdout,
): string {
  const text = String(value);
  if (!supportsColor(stream)) return text;

  return `\x1b[${ANSI_CODES[color]}m${text}\x1b[0m`;
}

export const colors = {
  cyan: (value: string | number, stream?: ColorStream) => colorize(value, "cyan", stream),
  green: (value: string | number, stream?: ColorStream) => colorize(value, "green", stream),
  red: (value: string | number, stream?: ColorStream) => colorize(value, "red", stream),
  yellow: (value: string | number, stream?: ColorStream) => colorize(value, "yellow", stream),
};
