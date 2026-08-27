export type TruncatedText = {
  text: string;
  truncated: boolean;
  omittedBytes: number;
};

function utf8Head(buffer: Buffer, budget: number): Buffer {
  let end = Math.min(buffer.length, Math.max(0, budget));
  while (end > 0 && end < buffer.length && (buffer[end] ?? 0) >> 6 === 0b10) {
    end -= 1;
  }
  return buffer.subarray(0, end);
}

function utf8Tail(buffer: Buffer, budget: number): Buffer {
  let start = Math.max(0, buffer.length - Math.max(0, budget));
  while (start < buffer.length && (buffer[start] ?? 0) >> 6 === 0b10) {
    start += 1;
  }
  return buffer.subarray(start);
}

export function truncateUtf8(text: string, maxBytes: number): TruncatedText {
  const source = Buffer.from(text, "utf8");
  if (source.length <= maxBytes) {
    return { text, truncated: false, omittedBytes: 0 };
  }
  const largestMarker = `\n... [${source.length} bytes omitted] ...\n`;
  const available = maxBytes - Buffer.byteLength(largestMarker);
  if (available <= 0) {
    const fallback = utf8Head(Buffer.from("[output truncated]", "utf8"), maxBytes);
    return {
      text: fallback.toString("utf8"),
      truncated: true,
      omittedBytes: source.length,
    };
  }

  const head = utf8Head(source, Math.ceil(available / 2));
  const tail = utf8Tail(source, Math.floor(available / 2));
  const omittedBytes = source.length - head.length - tail.length;
  const marker = Buffer.from(`\n... [${omittedBytes} bytes omitted] ...\n`, "utf8");
  return {
    text: Buffer.concat([head, marker, tail]).toString("utf8"),
    truncated: true,
    omittedBytes,
  };
}

/** Returns the longest UTF-8-safe prefix of `text` that fits in `maxBytes`. */
export function takeUtf8Prefix(text: string, maxBytes: number): string {
  const source = Buffer.from(text, "utf8");
  return utf8Head(source, maxBytes).toString("utf8");
}
