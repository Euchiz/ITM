// Lightweight, round-trippable markdown parser/serializer for itinerary docs.
//
// Supported block types:
//   - h1 / h2 / h3              "# ", "## ", "### "
//   - paragraph                 (one or more consecutive non-empty, non-table lines)
//   - table                     standard pipe tables with header + separator + rows
//   - blockquote                "> ..." (rendered as callout in print mode)
//
// The model is a flat list of blocks: [{type, ...payload}, ...]
// Inline syntax is preserved as raw text (no inline parsing) so round-trip
// is lossless for the editor's purposes.

const SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const ROW_RE = /^\s*\|.*\|\s*$/;

export function parseMarkdown(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines between blocks.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Headings.
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ type: "h" + h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    // Tables: a row line followed by a separator line.
    if (ROW_RE.test(line) && i + 1 < lines.length && SEP_RE.test(lines[i + 1])) {
      const headers = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && ROW_RE.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      // Normalize row widths to header width.
      const w = headers.length;
      for (const r of rows) {
        while (r.length < w) r.push("");
        if (r.length > w) r.length = w;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Blockquote: collect consecutive "> " lines.
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", text: buf.join("\n") });
      continue;
    }

    // Paragraph: consume lines until we hit a blank, heading, table, or quote.
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !(ROW_RE.test(lines[i]) && i + 1 < lines.length && SEP_RE.test(lines[i + 1]))
    ) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) blocks.push({ type: "paragraph", text: buf.join("\n") });
  }

  return blocks;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // Split on unescaped pipes. We don't escape pipes elsewhere, so this is fine
  // unless a cell literally contains "\|". Handle that edge case.
  const cells = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  // Cells often contain HTML <br> for line breaks; we keep them literal.
  return cells;
}

export function serializeMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case "h1": out.push("# " + b.text); break;
      case "h2": out.push("## " + b.text); break;
      case "h3": out.push("### " + b.text); break;
      case "paragraph": out.push(b.text); break;
      case "blockquote":
        out.push(b.text.split("\n").map((l) => "> " + l).join("\n"));
        break;
      case "table": {
        const escape = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
        const headers = b.headers.map(escape);
        out.push("| " + headers.join(" | ") + " |");
        out.push("|" + headers.map(() => "---").join("|") + "|");
        for (const row of b.rows) {
          out.push("| " + row.map(escape).join(" | ") + " |");
        }
        break;
      }
    }
    out.push(""); // blank line between blocks
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// Inline render: minimal markdown-ish formatting for paragraphs and table cells.
// We accept a subset because itineraries occasionally use bold/italic/links and
// literal <br>. Everything else is escaped.
export function renderInline(text) {
  if (text == null) return "";
  // 1. Pull out literal <br> tags.
  const parts = String(text).split(/(<br\s*\/?>)/i);
  return parts.map((part) => {
    if (/^<br/i.test(part)) return "<br>";
    return inlineFormat(escapeHtml(part));
  }).join("");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineFormat(s) {
  // Markdown links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) =>
    `<a href="${u}">${t}</a>`);
  // Bold: **x**  /  __x__
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
  // Italic: *x*  /  _x_  (avoid matching ** which we already replaced)
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, "$1<em>$2</em>");
  // Code: `x`
  s = s.replace(/`([^`\n]+?)`/g, "<code>$1</code>");
  // Newlines -> <br>
  s = s.replace(/\n/g, "<br>");
  return s;
}
