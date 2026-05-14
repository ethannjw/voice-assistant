export type MessageSegment = { kind: "text" | "code"; value: string };

export function parseMessageSegments(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const codeFence = /```[\w-]*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeFence.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        kind: "text",
        value: text.slice(lastIndex, match.index).replace(/^\n+|\n+$/g, "")
      });
    }
    segments.push({ kind: "code", value: match[1].replace(/\n+$/, "") });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex).replace(/^\n+/, "");
    if (tail) {
      segments.push({ kind: "text", value: tail });
    }
  }
  if (!segments.length) {
    segments.push({ kind: "text", value: text });
  }
  return segments;
}
