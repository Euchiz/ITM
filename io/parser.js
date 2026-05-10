// Parse user-pasted text into a trip JSON payload.
//
// Strategy (guideline §17.3):
//   1. Try JSON.parse directly.
//   2. If that fails, extract a ```trip-json fenced block and parse that.
//   3. If that fails too, fall back to the first {…} balanced block in
//      the text (covers folks who paste raw JSON inside other prose).

export function parseImportText(input) {
  const text = String(input || "").trim();
  if (!text) return { ok: false, error: "Paste some text to import." };

  // 1. Direct JSON.parse
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {}

  // 2. ```trip-json fenced block (also accept generic ```json)
  const fence = extractFence(text, ["trip-json", "json"]);
  if (fence) {
    try {
      return { ok: true, data: JSON.parse(fence) };
    } catch (e) {
      return { ok: false, error: "Found a trip-json block but couldn't parse it: " + e.message };
    }
  }

  // 3. First balanced {…} block
  const balanced = extractBalanced(text);
  if (balanced) {
    try {
      return { ok: true, data: JSON.parse(balanced) };
    } catch {}
  }

  return { ok: false, error: "Could not find valid JSON in the pasted text." };
}

function extractFence(text, langs) {
  for (const lang of langs) {
    const re = new RegExp("```\\s*" + lang + "\\s*\\n([\\s\\S]*?)```", "i");
    const m = re.exec(text);
    if (m) return m[1].trim();
  }
  return null;
}

function extractBalanced(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
