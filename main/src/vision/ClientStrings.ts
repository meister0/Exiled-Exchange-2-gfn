/**
 * Loads renderer client_strings.js and provides exact string lookups.
 * This is the source of truth for clipboard format — the renderer parser
 * uses these exact strings for startsWith() matching.
 */

import fs from "fs";
import path from "path";
import { addDictionaryWords } from "./StatMatcher";

let strings: Record<string, string> = {};

// Map OCR uppercase stat labels → client_strings key
const STAT_KEY_MAP: Record<string, string> = {
  "QUALITY": "QUALITY",
  "PHYSICAL DAMAGE": "PHYSICAL_DAMAGE",
  "ELEMENTAL DAMAGE": "ELEMENTAL_DAMAGE",
  "FIRE DAMAGE": "FIRE_DAMAGE",
  "COLD DAMAGE": "COLD_DAMAGE",
  "LIGHTNING DAMAGE": "LIGHTNING_DAMAGE",
  "CHAOS DAMAGE": "CHAOS_DAMAGE",
  "ATTACKS PER SECOND": "ATTACK_SPEED",
  "CRITICAL HIT CHANCE": "CRIT_CHANCE",
  "BLOCK CHANCE": "BLOCK_CHANCE",
  "RELOAD TIME": "RELOAD_SPEED",
  "ARMOUR": "ARMOUR",
  "EVASION RATING": "EVASION",
  "ENERGY SHIELD": "ENERGY_SHIELD",
  "WARD": "WARD",
  "SPIRIT": "BASE_SPIRIT",
};

/**
 * Load client_strings.js from renderer data directory.
 * Called once at startup from Shortcuts.create() alongside loadStatMatchers().
 */
export function loadClientStrings(dataDir: string): void {
  try {
    const filePath = path.join(dataDir, "client_strings.js");
    const content = fs.readFileSync(filePath, "utf8");

    // Parse "export default { ... }" as JS object.
    // Find the object after "export default"
    const exportIdx = content.indexOf("export default");
    if (exportIdx === -1) {
      console.log("[GFN] No 'export default' in client_strings.js");
      return;
    }
    const afterExport = content.slice(exportIdx + "export default".length);
    const objStart = afterExport.indexOf("{");
    const objEnd = afterExport.lastIndexOf("}");
    if (objStart === -1 || objEnd === -1) return;
    const objStr = afterExport.slice(objStart, objEnd + 1);
    strings = new Function(`return ${objStr}`)() as Record<string, string>;

    // Feed all string values into fuzzy dictionary
    const words: string[] = [];
    for (const val of Object.values(strings)) {
      if (typeof val === "string") {
        for (const w of val.split(/[\s:,;.()]+/)) {
          if (w.length >= 3) words.push(w);
        }
      }
    }
    addDictionaryWords(words);

    console.log(`[GFN] Loaded ${Object.keys(strings).length} client strings, ${words.length} words added to dictionary`);
  } catch (e) {
    console.log("[GFN] Failed to load client_strings:", e);
  }
}

/**
 * Get exact stat label from client_strings for an OCR uppercase label.
 * Returns the label without trailing ": " (we add it in the caller).
 *
 * "ATTACKS PER SECOND" → "Attacks per Second"
 * "BLOCK CHANCE" → "Block chance"
 */
export function getClientString(ocrLabel: string): string | null {
  const key = STAT_KEY_MAP[ocrLabel];
  if (!key) return null;
  const value = strings[key];
  if (!value || typeof value !== "string") return null;
  // client_strings values end with ": " — strip it
  return value.endsWith(": ") ? value.slice(0, -2) : value;
}
