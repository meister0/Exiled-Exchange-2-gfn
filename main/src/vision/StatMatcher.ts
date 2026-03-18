import fs from "fs";
import path from "path";

interface MatcherEntry {
  /** Regex to match OCR text (case-insensitive, # → number groups) */
  regex: RegExp;
  /** Canonical form from stats.ndjson (e.g. "# to Maximum Life") */
  template: string;
  /** Number of # placeholders */
  numSlots: number;
}

let entries: MatcherEntry[] | null = null;

/**
 * Load stats.ndjson matchers and build regex lookup table.
 * Called once at startup.
 */
export function loadStatMatchers(dataDir: string): void {
  const filePath = path.join(dataDir, "stats.ndjson");
  if (!fs.existsSync(filePath)) {
    console.log("[GFN] stats.ndjson not found, stat matching disabled");
    return;
  }

  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
  entries = [];

  for (const line of lines) {
    const d = JSON.parse(line);
    for (const m of d.matchers || []) {
      if (!m.string || !m.string.includes("#")) continue;

      const template = m.string.trim();
      const numSlots = (template.match(/#/g) || []).length;

      // Build regex: escape special chars, replace # with number capture group
      const escaped = template
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/#/g, "([+-]?\\d+[\\d.]*)");

      // Match full line, case-insensitive
      try {
        const regex = new RegExp("^" + escaped + "$", "i");
        entries.push({ regex, template, numSlots });
      } catch {
        // skip invalid regex
      }
    }
  }

  console.log(`[GFN] Loaded ${entries.length} stat matchers`);
}

/**
 * Try to match an OCR mod line against known stat patterns.
 * Returns the canonical form (proper casing) or null if no match.
 *
 * Example: "+137 TO MAXIMUM LIFE" → "+137 to Maximum Life"
 */
export function matchStatLine(ocrLine: string): string | null {
  if (!entries) return null;

  const trimmed = ocrLine.trim();
  if (!trimmed) return null;

  for (const entry of entries) {
    const match = trimmed.match(entry.regex);
    if (match) {
      // Reconstruct: replace # placeholders with captured numbers
      let result = entry.template;
      for (let i = 1; i <= entry.numSlots; i++) {
        result = result.replace("#", match[i]);
      }
      return result;
    }
  }

  return null;
}
