import fs from "fs";
import path from "path";

interface MatcherEntry {
  regex: RegExp;
  template: string;
  numSlots: number;
  /** true if this stat only has implicit trade IDs (no explicit) */
  implicitOnly: boolean;
}

export interface StatMatchResult {
  text: string;
  implicitOnly: boolean;
}

let entries: MatcherEntry[] | null = null;

/** Dictionary of known words from stat matchers (lowercase → canonical) */
let wordDict: Map<string, string> | null = null;

/**
 * Load stats.ndjson matchers and build regex lookup table + word dictionary.
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
  wordDict = new Map();

  for (const line of lines) {
    const d = JSON.parse(line);
    // Check if stat is implicit-only (has implicit trade ID but no explicit)
    const tradeIds = d.trade?.ids || {};
    const implicitOnly = Boolean(tradeIds.implicit?.length) &&
      !tradeIds.explicit?.length && !tradeIds.pseudo?.length;

    for (const m of d.matchers || []) {
      if (!m.string) continue;
      const template = m.string.trim();

      // Collect words for fuzzy dictionary
      for (const word of template.split(/[\s#%+\-.,;:()]+/)) {
        if (word.length >= 3) {
          wordDict.set(word.toLowerCase(), word);
        }
      }

      const numSlots = (template.match(/#/g) || []).length;
      const escaped = template
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/#/g, "([+-]?\\d+[\\d.]*)");

      try {
        const regex = new RegExp("^" + escaped + "$", "i");
        entries.push({ regex, template, numSlots, implicitOnly });
      } catch {
        // skip invalid regex
      }
    }
  }

  // Remaining words are added from client_strings.js via addDictionaryWords()
  // at startup (covers stat labels, tooltip structure, flask/charm terms, etc.)

  console.log(
    `[GFN] Loaded ${entries.length} stat matchers, ${wordDict.size} dictionary words`,
  );
}

/**
 * Add words to the fuzzy dictionary from external sources.
 * Used to add client_strings labels, base type names, etc.
 */
export function addDictionaryWords(words: string[]): void {
  if (!wordDict) wordDict = new Map();
  for (const w of words) {
    if (w.length >= 3) wordDict.set(w.toLowerCase(), w);
  }
}

/**
 * Try to match an OCR mod line against known stat patterns.
 * Returns the canonical form (proper casing) or null if no match.
 *
 * Example: "+137 TO MAXIMUM LIFE" → "+137 to Maximum Life"
 */
export function matchStatLine(ocrLine: string): StatMatchResult | null {
  if (!entries) return null;

  const trimmed = ocrLine.trim();
  if (!trimmed) return null;

  function tryMatch(text: string): StatMatchResult | null {
    for (const entry of entries) {
      const match = text.match(entry.regex);
      if (match) {
        let result = entry.template;
        for (let i = 1; i <= entry.numSlots; i++) {
          result = result.replace("#", match[i]);
        }
        return { text: result, implicitOnly: entry.implicitOnly };
      }
    }
    return null;
  }

  // Try exact, then fuzzy
  const exact = tryMatch(trimmed);
  if (exact) return exact;

  const fixed = fuzzyFixWords(trimmed);
  if (fixed !== trimmed) {
    const fuzzyResult = tryMatch(fixed);
    if (fuzzyResult) return fuzzyResult;
  }

  return null;
}

/**
 * Fix OCR typos by matching each word against the known dictionary.
 * Uses Levenshtein distance — if a word is within 2 edits of a known word,
 * replace it with the canonical form.
 *
 * "STRENCTH" → "Strength", "LGNIT" → "Ignite", "AITACKS" → "Attacks"
 */
export function fuzzyFixWords(text: string): string {
  if (!wordDict) return text;

  return text.replace(/[A-Za-z]{3,}/g, (word) => {
    const lower = word.toLowerCase();

    // Exact match — use canonical casing
    const exact = wordDict!.get(lower);
    if (exact) {
      return word === word.toUpperCase() ? exact.toUpperCase() : exact;
    }

    // Fuzzy match only for 4+ char words (3-char words have too many false positives)
    if (word.length < 4) return word;

    let bestWord: string | null = null;
    let bestDist = 3; // max allowed distance

    for (const [dictLower, dictCanon] of wordDict!) {
      // Quick length filter — edit distance can't be less than length difference
      if (Math.abs(dictLower.length - lower.length) >= bestDist) continue;

      const dist = levenshtein(lower, dictLower);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = dictCanon;
        if (dist === 1) break; // good enough
      }
    }

    if (bestWord) {
      return word === word.toUpperCase() ? bestWord.toUpperCase() : bestWord;
    }

    return word;
  });
}

/**
 * Levenshtein edit distance (optimized for short strings).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Early exit if length difference is too large
  if (Math.abs(a.length - b.length) > 2) return 3;

  const matrix: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) matrix[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    matrix[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const curr = matrix[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j] = Math.min(matrix[j] + 1, matrix[j - 1] + 1, prev + cost);
      prev = curr;
    }
  }

  return matrix[b.length];
}
