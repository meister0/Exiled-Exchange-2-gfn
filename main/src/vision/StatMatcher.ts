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
    for (const m of d.matchers || []) {
      if (!m.string) continue;
      const template = m.string.trim();

      // Collect words for fuzzy dictionary
      for (const word of template.split(/[\s#%+\-.,;:()]+/)) {
        if (word.length >= 3) {
          wordDict.set(word.toLowerCase(), word);
        }
      }

      if (!template.includes("#")) continue;

      const numSlots = (template.match(/#/g) || []).length;
      const escaped = template
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/#/g, "([+-]?\\d+[\\d.]*)");

      try {
        const regex = new RegExp("^" + escaped + "$", "i");
        entries.push({ regex, template, numSlots });
      } catch {
        // skip invalid regex
      }
    }
  }

  // Add common PoE2 words not in matchers
  for (const w of [
    "Ignite", "Freeze", "Shock", "Chill", "Poison", "Bleed",
    "Attacks", "Spells", "Skills", "Damage", "Duration",
    "Strength", "Dexterity", "Intelligence", "Spirit",
    "Evasion", "Armour", "Shield", "Energy", "Ward",
    "Physical", "Lightning", "Resistance", "Maximum",
    "Accuracy", "Rating", "Critical", "Chance",
  ]) {
    wordDict.set(w.toLowerCase(), w);
  }

  console.log(
    `[GFN] Loaded ${entries.length} stat matchers, ${wordDict.size} dictionary words`,
  );
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

  // First try exact regex match
  for (const entry of entries) {
    const match = trimmed.match(entry.regex);
    if (match) {
      let result = entry.template;
      for (let i = 1; i <= entry.numSlots; i++) {
        result = result.replace("#", match[i]);
      }
      return result;
    }
  }

  // If no exact match, fix OCR words via fuzzy dictionary and retry
  const fixed = fuzzyFixWords(trimmed);
  if (fixed !== trimmed) {
    for (const entry of entries) {
      const match = fixed.match(entry.regex);
      if (match) {
        let result = entry.template;
        for (let i = 1; i <= entry.numSlots; i++) {
          result = result.replace("#", match[i]);
        }
        return result;
      }
    }
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
      // Preserve original casing if all-upper
      return word === word.toUpperCase() ? exact.toUpperCase() : exact;
    }

    // Fuzzy match — find closest word within edit distance 2
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
