import type { ReactNode } from "react";

function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={key} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={key}
          className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[0.9em] text-signal-400"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

function isTableSeparator(line: string): boolean {
  return /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
}

/**
 * 生成レポート用の最小 Markdown レンダラ。
 * 外部 HTML を挿入しないため、ログ由来の文字列でも XSS にならない。
 */
export function MarkdownPreview({ markdown }: { markdown: string }) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !(lines[index] ?? "").trim().startsWith("```")
      ) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre
          key={`code-${key++}`}
          className="scrollbar-thin overflow-x-auto rounded-lg border border-ink-700/70 bg-ink-950/70 p-3 font-mono text-xs leading-relaxed text-mist-400"
        >
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      const className =
        level === 1
          ? "text-lg font-semibold tracking-tight text-white"
          : level === 2
            ? "mt-5 border-b border-ink-700/60 pb-1 text-sm font-semibold text-white"
            : "mt-4 text-xs font-semibold text-mist-400";
      blocks.push(
        <div key={`heading-${key++}`} className={className}>
          {inline(text, `h-${key}`)}
        </div>,
      );
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul
          key={`ul-${key++}`}
          className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-mist-200"
        >
          {items.map((item, itemIndex) => (
            <li key={`li-${key}-${itemIndex}`}>
              {inline(item, `li-${key}-${itemIndex}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (line.trim().startsWith("|")) {
      const rows: string[] = [];
      while (
        index < lines.length &&
        (lines[index] ?? "").trim().startsWith("|")
      ) {
        rows.push((lines[index] ?? "").trim());
        index += 1;
      }
      const cells = (row: string): string[] =>
        row
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim());
      const visibleRows = rows.filter((row) => !isTableSeparator(row));
      const [header, ...body] = visibleRows;
      if (header) {
        blocks.push(
          <div
            key={`table-${key++}`}
            className="scrollbar-thin overflow-x-auto rounded-lg border border-ink-700/70"
          >
            <table className="w-full border-collapse text-left text-xs">
              <thead className="bg-ink-950/60 text-xs text-mist-400">
                <tr>
                  {cells(header).map((cell, cellIndex) => (
                    <th
                      key={`th-${key}-${cellIndex}`}
                      scope="col"
                      className="border-b border-ink-700/70 px-3 py-2 font-medium"
                    >
                      {inline(cell, `th-${key}-${cellIndex}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/40 text-mist-200">
                {body.map((row, rowIndex) => (
                  <tr key={`tr-${key}-${rowIndex}`}>
                    {cells(row).map((cell, cellIndex) => (
                      <td
                        key={`td-${key}-${rowIndex}-${cellIndex}`}
                        className="px-3 py-2 align-top"
                      >
                        {inline(cell, `td-${key}-${rowIndex}-${cellIndex}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      }
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (!next.trim()) break;
      if (/^(#{1,4})\s+/.test(next)) break;
      if (/^\s*[-*]\s+/.test(next)) break;
      if (next.trim().startsWith("|")) break;
      if (next.trim().startsWith("```")) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push(
      <p key={`p-${key++}`} className="text-xs leading-relaxed text-mist-200">
        {inline(paragraph.join(" "), `p-${key}`)}
      </p>,
    );
  }

  return <div className="space-y-3">{blocks}</div>;
}
