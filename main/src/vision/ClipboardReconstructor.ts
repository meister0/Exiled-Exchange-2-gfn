/**
 * Reconstructs PoE2 clipboard format from OCR text.
 *
 * OCR text (with advanced mod descriptions) contains structured markers:
 *   "{CLASS}: ITEM LEVEL {N}"
 *   "REQUIRES: LEVEL {N}, ..."
 *   "PREFIX ..." / "SUFFIX ..." / "IMPLICIT ..."
 *   stat lines like "EVASION RATING: 44"
 *
 * Output: clipboard format that parseClipboard() expects:
 *   "Item Class: Belts\nRarity: Rare\nName\nBase Type\n--------\n..."
 */

import { matchStatLine, fuzzyFixWords } from "./StatMatcher";

// Singular OCR class → clipboard "Item Class" value
const CLASS_MAP: Record<string, string> = {
  AMULET: "Amulets",
  RING: "Rings",
  BELT: "Belts",
  QUIVER: "Quivers",
  GLOVES: "Gloves",
  HELMET: "Helmets",
  BOOTS: "Boots",
  "BODY ARMOUR": "Body Armours",
  SHIELD: "Shields",
  FOCUS: "Foci",
  BOW: "Bows",
  CROSSBOW: "Crossbows",
  WAND: "Wands",
  SCEPTRE: "Sceptres",
  STAFF: "Staves",
  "TWO HAND MACE": "Two Hand Maces",
  "ONE HAND MACE": "One Hand Maces",
  "TWO HAND SWORD": "Two Hand Swords",
  "ONE HAND SWORD": "One Hand Swords",
  FLAIL: "Flails",
  SPEAR: "Spears",
  QUARTERSTAFF: "Quarterstaves",
  DAGGER: "Daggers",
  CLAW: "Claws",
  TRAP: "Traps",
  FLASK: "Flasks",
  JEWEL: "Jewels",
  CHARM: "Charms",
};

// Regex patterns for OCR line classification
const ITEM_LEVEL_RE = /^(.+?):\s*ITEM LEVEL\s*(\d+)/i;
const REQUIRES_RE = /^REQUIRES:\s*(.+)/i;
const STAT_LINE_RE =
  /^(?:EVASION RATING|ARMOUR|ENERGY SHIELD|WARD|SPIRIT|QUALITY|PHYSICAL DAMAGE|ELEMENTAL DAMAGE|FIRE DAMAGE|COLD DAMAGE|LIGHTNING DAMAGE|CHAOS DAMAGE|CRITICAL HIT CHANCE|ATTACKS PER SECOND|RELOAD TIME|BLOCK CHANCE):\s*.+/i;
// PREFIX_RE/SUFFIX_RE/IMPLICIT_RE now searched as embedded patterns in parseOcrLines
const HAS_CHARM_SLOTS_RE = /^HAS\s+\d+.*CHARM SLOTS?/i;
const CORRUPTED_RE = /^CORRUPTED$/i;
const MIRRORED_RE = /^MIRRORED$/i;

// Noise patterns — map mods, UI labels, game info. NOT item mods.
const NOISE_RE =
  /^(MONSTERS|AREA CONTAINS|RARE MONSTERS|CONTAINS \d+|IN \d+% OF MAXIMUM|PLAYERS? (HAVE|DEAL|GAIN|ARE)|MORE THAN \d+ MONSTERS|MONSTER LEVEL|SHORT ALLOCATION|JAPAN REALM|FATE OF THE|INVENTORY|COSMETICS|\d+ GOLD|BOUND \w+|WOODLAND|HIDEOUT|TOWN|\d+ FPS)/i;

// Map mods pattern (more specific)
const MAP_MOD_RE =
  /\b(INCREASED .*(RARITY|NUMBER|WAYSTONES|EXPEDITION|EXPLOSIVE|MONSTER)|ADDITIONAL PACKS OF|FLAMMABILITY MAGNITUDE|FREEZE BUILDUP|SHOCK CHANCE|ADDITIONAL MODIFIER|ITEMS FOUND IN THIS AREA|FOUND IN AREA)\b/i;

interface ParsedOcrItem {
  itemClass: string | null;
  itemLevel: number | null;
  name: string | null;
  baseType: string | null;
  requirements: string | null;
  stats: string[];
  implicitMods: string[];
  explicitMods: string[];
  corrupted: boolean;
  mirrored: boolean;
}

/**
 * Strip tier ranges and clean common OCR errors in mod/stat text.
 * "+85(85-99) TỌ MAXIMUM LIFE" → "+85 TO MAXIMUM LIFE"
 */
function stripTierRanges(text: string): string {
  return text
    .replace(/(\d+)\(\d+-\d+\)/g, "$1")                 // strip tier ranges
    .replace(/(\d+[\d.]*)\([\d.]+[-–][\d.]+\)/g, "$1")  // also handle decimal ranges
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")    // strip diacritics (TỌ→TO)
    .replace(/^[$#@!]+/, "")                              // strip leading junk chars
    .replace(/[!€]+$/g, "")                               // strip trailing junk
    .trim();
}

/**
 * Convert OCR UPPERCASE text to Title Case for names
 */
function toTitleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());
}

/**
 * Clean OCR noise from a name string.
 * Removes punctuation noise, single-char junk words, and trims.
 */
function cleanName(text: string): string {
  return text
    .replace(/[^A-Za-z0-9\s'-]/g, "") // remove OCR junk chars
    .replace(/\b[a-zA-Z]\b/g, "")     // remove single-letter words (noise)
    .replace(/\s{2,}/g, " ")           // collapse whitespace
    .trim();
}

/**
 * Try to extract an item mod from a merged map+item line.
 * AVF merges text at the same Y height, e.g.:
 *   "4 CONTAINS 7 ADDITIONAL PACKS OF MONSTERS ADDS 13(11-13) TO 18(18-21) COLD DAMAGE"
 *   "MONSTERS DEAL 16% OF DAMAGE AS EXTRA CADDS 1(1-2) TO 43(41-47) LIGHTNING DAMAGE"
 *   "100% INCREASED EXPEDITION EXPLOSIVE PLACEMINFKAN LEECH 7.18(7-7.9)% OF PHYSICAL..."
 * Returns the extracted item mod portion, or null.
 */
function extractEmbeddedMod(line: string): string | null {
  // Pattern: "...ADDS X(range) TO Y(range) {DAMAGE_TYPE} DAMAGE..."
  const addsMatch = line.match(
    /ADDS\s+\d+[\d.()\-]*\s+TO\s+\d+[\d.()\-]*\s+\w+[\s,.]*(DAMAGE\b[^.]*)/i,
  );
  if (addsMatch) {
    // Clean: remove stray commas/periods, fix "COLD, DAMAGE" → "COLD DAMAGE"
    return addsMatch[0]
      .replace(/,\s*DAMAGE/i, " Damage")
      .replace(/[.,]+$/, "")
      .trim();
  }

  // Pattern: "...LEECH X% OF {TYPE} ATTACK DAMAGE AS {RESOURCE}"
  const leechMatch = line.match(
    /LEECH\s+[\d.%()\-]+\s+OF\s+\w+\s+ATTACK\s+DAMAGE\s+AS\s+\w+/i,
  );
  if (leechMatch) return leechMatch[0].trim();

  // Pattern: "...GAIN X {RESOURCE} PER ENEMY HIT..."
  const gainMatch = line.match(
    /GAIN\s+\d+[\d.()\-]*\s+\w+\s+PER\s+ENEMY\s+HIT\b[^.]*/i,
  );
  if (gainMatch) return gainMatch[0].trim();

  // Pattern: "...X% REDUCED/INCREASED {EFFECT} DURATION..."
  const durationMatch = line.match(
    /\d+[\d.%()\-]*\s+(REDUCED|INCREASED)\s+\w+\s+DURATION\b[^.]*/i,
  );
  if (durationMatch) return durationMatch[0].replace(/[.,]+$/, "").trim();

  // Pattern: "...X% INCREASED/REDUCED {STAT}..." (standalone % mod embedded in noise)
  if (NOISE_RE.test(line) || MAP_MOD_RE.test(line)) {
    const pctMatch = line.match(
      /\d+[\d.%()\-]*\s+(REDUCED|INCREASED)\s+(?!EXPEDITION|RARITY|NUMBER|WAYSTONES|MONSTER)\w[\w\s]*?(RATE|SPEED|DURATION|DAMAGE|RESISTANCE)\b/i,
    );
    if (pctMatch) return pctMatch[0].replace(/[.,]+$/, "").trim();
  }

  // Pattern: embedded "+X(range) TO MAXIMUM/FIRE/COLD/LIGHTNING..."
  // Only when line also contains map mod noise
  if (NOISE_RE.test(line) || MAP_MOD_RE.test(line)) {
    const modMatch = line.match(
      /[+-]\d+[\d.()\-]*\s+TO\s+(MAXIMUM|FIRE|COLD|LIGHTNING|CHAOS|STRENGTH|DEXTERITY|INTELLIGENCE)\b[^.]*/i,
    );
    if (modMatch) return modMatch[0].trim();
  }

  return null;
}

/**
 * Check if a line is game UI / map noise that should never be used as item name/mod.
 * Handles truncated words (AVF cuts edges) and diacritics.
 */
function isNoiseLine(line: string): boolean {
  const normalized = line.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (NOISE_RE.test(normalized) || MAP_MOD_RE.test(normalized)) return true;
  if (STAT_LINE_RE.test(line)) return true;
  // UI labels (may be truncated by AVF crop: "NVENTORY", "OSMETICS")
  if (/\b(N?VENTORY|OSMETICS?|COSMETICS?|INSPECT)\b/i.test(normalized)) return true;
  // Game info (may have diacritics or partial text)
  if (/\b(SHORT ALLOC|JAPAN|REALM|MONSTER LEVEL|WOODLAND|HIDEOUT|TOWN)\b/i.test(normalized)) return true;
  if (/\d+\s*GOL[DP]?/i.test(normalized)) return true; // "34 GOLD", "34 GOLPonster" (merged)
  if (/^\*?Monster\s*$/i.test(normalized)) return true; // standalone "Monster" from map overlay
  if (/^\d+\s*(FPS|FBS|г8S)?\s*$/i.test(line)) return true; // FPS counter
  if (/^(MORE THAN \d+|FATE OF|\*?LEAGUE\s*$)/i.test(normalized)) return true;
  // "Fate of the Vaal League" split across lines by AVF
  if (/\b(VAAL LEAGUE|VAAL|LEAGUE)\s*$/i.test(normalized) && line.length < 20) return true;
  return false;
}

// Set of known class names (uppercase) for simple format detection
const CLASS_NAMES = new Set(Object.keys(CLASS_MAP));

/**
 * Parse simple tooltip format (no Alt held, no advanced mod descriptions).
 * Structure: Name / BaseType / ClassName / Stats / Requirements / Mods
 */
function parseSimpleFormat(lines: string[]): ParsedOcrItem {
  const result: ParsedOcrItem = {
    itemClass: null,
    itemLevel: null,
    name: null,
    baseType: null,
    requirements: null,
    stats: [],
    implicitMods: [],
    explicitMods: [],
    corrupted: false,
    mirrored: false,
  };

  // Find class name line. In simple format it's a standalone line like "Boots".
  // But OCR may merge it with adjacent text, so also look for class name
  // at the START of a line or as a near-exact match.
  let classIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const upper = trimmed.toUpperCase();

    // Exact match
    if (CLASS_NAMES.has(upper)) {
      result.itemClass = CLASS_MAP[upper]!;
      classIdx = i;
      break;
    }

    // Class name anywhere in the line as a whole word
    // e.g., "a ' _ _. BELT" or "BOOTS INVENTORY"
    for (const cls of CLASS_NAMES) {
      const re = new RegExp(`\\b${cls}\\b`);
      if (re.test(upper)) {
        result.itemClass = CLASS_MAP[cls]!;
        classIdx = i;
        break;
      }
    }
    if (classIdx !== -1) break;
  }

  // Fallback: find anchor via REQUIRES line and work backwards
  if (classIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (REQUIRES_RE.test(lines[i])) {
        result.requirements = lines[i].match(REQUIRES_RE)![1].trim();
        // Work backwards to find stats, then class, then name/baseType
        // Stats are between class and requirements
        for (let j = i - 1; j >= 0; j--) {
          if (STAT_LINE_RE.test(lines[j])) {
            result.stats.unshift(lines[j].trim());
            continue;
          }
          // First non-stat line above stats could be class or name
          const upper = lines[j].trim().toUpperCase();
          for (const cls of CLASS_NAMES) {
            const re = new RegExp(`\\b${cls}\\b`);
            if (re.test(upper)) {
              result.itemClass = CLASS_MAP[cls]!;
              classIdx = j;
              break;
            }
          }
          if (classIdx !== -1) break;
        }
        break;
      }
    }
  }

  if (classIdx === -1) {
    console.log("[GFN] Simple format: no class name found in OCR lines");
    return result;
  }

  // Name and base type: the 2 lines before the class line
  const priorLines: string[] = [];
  for (let i = classIdx - 1; i >= Math.max(0, classIdx - 8); i--) {
    const line = lines[i].trim();
    if (line.length < 3) continue;
    if (/^[^A-Za-z]*$/.test(line)) continue;
    if (isNoiseLine(line)) continue;
    priorLines.unshift(line);
    if (priorLines.length >= 2) break;
  }

  if (priorLines.length >= 2) {
    result.name = toTitleCase(cleanName(priorLines[0]));
    result.baseType = toTitleCase(cleanName(priorLines[1]));
  } else if (priorLines.length === 1) {
    result.baseType = toTitleCase(cleanName(priorLines[0]));
    result.name = result.baseType;
  }

  // Parse lines after class name
  for (let i = classIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length < 3) continue;

    const reqMatch = line.match(REQUIRES_RE);
    if (reqMatch) {
      result.requirements = reqMatch[1].trim();
      continue;
    }

    if (STAT_LINE_RE.test(line)) {
      result.stats.push(line);
      continue;
    }

    if (CORRUPTED_RE.test(line)) { result.corrupted = true; continue; }
    if (MIRRORED_RE.test(line)) { result.mirrored = true; continue; }

    // In simple format, mods have no PREFIX/SUFFIX marker.
    // They look like: "+72 to maximum Life", "20% increased Movement Speed"
    if (/^[+-]?\d/.test(line) || /\d+%?\s+(increased|reduced|to)\s/i.test(line)) {
      result.explicitMods.push(line);
      continue;
    }

    // Skip map mods and noise
    if (NOISE_RE.test(line) || MAP_MOD_RE.test(line)) continue;
  }

  return result;
}

/**
 * Parse OCR lines into structured item data.
 * Strategy: find the "ITEM LEVEL" anchor, work backwards for name/base type,
 * forward for mods.
 */
function parseOcrLines(lines: string[]): ParsedOcrItem {
  const result: ParsedOcrItem = {
    itemClass: null,
    itemLevel: null,
    name: null,
    baseType: null,
    requirements: null,
    stats: [],
    implicitMods: [],
    explicitMods: [],
    corrupted: false,
    mirrored: false,
  };

  // Find the "CLASS: ITEM LEVEL N" anchor line
  let anchorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(ITEM_LEVEL_RE);
    if (match) {
      // The captured group may contain OCR noise before the class name.
      // Search for a known class name within it.
      const rawClass = match[1].trim().toUpperCase();
      let foundClass = false;
      for (const cls of CLASS_NAMES) {
        if (new RegExp(`\\b${cls}\\b`).test(rawClass)) {
          result.itemClass = CLASS_MAP[cls]!;
          foundClass = true;
          break;
        }
      }
      if (!foundClass) {
        // Fallback: use last word (most likely the class name)
        const words = rawClass.split(/\s+/);
        const lastWord = words[words.length - 1];
        result.itemClass = CLASS_MAP[lastWord] || toTitleCase(lastWord);
      }
      result.itemLevel = parseInt(match[2], 10);
      anchorIdx = i;
      break;
    }
  }

  if (anchorIdx === -1) {
    // Fallback: simple tooltip format (no Alt held).
    // Class appears as standalone line: "Boots", "Ring", "Belt", etc.
    // Format: Name / BaseType / Class / stats / requirements / mods
    return parseSimpleFormat(lines);
  }

  // Work backwards from anchor to find name and base type
  // The 2 lines before the anchor are typically: Name, BaseType
  // But there might be junk from the game background before that
  // Look for the last 2 "clean" lines before anchor
  const priorLines: string[] = [];
  for (let i = anchorIdx - 1; i >= Math.max(0, anchorIdx - 8); i--) {
    const line = lines[i].trim();
    if (line.length < 3) continue;
    if (/^[^A-Za-z]*$/.test(line)) continue;
    if (isNoiseLine(line)) continue;
    if (/^\d+%?\s+(INCREASED|REDUCED|MORE|LESS)\s/i.test(line)) continue;
    priorLines.unshift(line);
    if (priorLines.length >= 2) break;
  }

  if (priorLines.length >= 2) {
    result.name = toTitleCase(cleanName(priorLines[0]));
    result.baseType = toTitleCase(cleanName(priorLines[1]));
  } else if (priorLines.length === 1) {
    result.baseType = toTitleCase(cleanName(priorLines[0]));
    result.name = result.baseType; // Normal/Currency items have same name
  }

  // Work forwards from anchor to find requirements, stats, and mods
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.length < 3) continue;

    // OCR (especially AVF) often merges map mods and item mods on one line, e.g.:
    // "150% INCREASED EXPEDITION RADIUS PREFIX +85(85-99) TO MAXIMUM LIFE"
    // "4 CONTAINS 7 ADDITIONAL PACKS... ADDS 13(11-13) TO 18(18-21) COLD DAMAGE"
    // "MONSTERS DEAL 16% OF DAMAGE... LEECH 7.18% OF PHYSICAL ATTACK DAMAGE AS LIFE"

    // Extract PREFIX/SUFFIX/IMPLICIT from anywhere in the line first
    const embeddedPrefix = line.match(/\bPREFIX\s+(.+)/i);
    const embeddedSuffix = line.match(/\bSUFFIX\s+(.+)/i);
    const embeddedImplicit = line.match(/\bIMPLICIT\s+(.+)/i);
    if (embeddedPrefix) {
      result.explicitMods.push(stripTierRanges(embeddedPrefix[1].trim()));
      continue;
    }
    if (embeddedSuffix) {
      result.explicitMods.push(stripTierRanges(embeddedSuffix[1].trim()));
      continue;
    }
    if (embeddedImplicit) {
      result.implicitMods.push(stripTierRanges(embeddedImplicit[1].trim()));
      continue;
    }

    // Try to extract item mod from merged map+item lines.
    // AVF merges text at same Y height, so map mod on left + item mod on right
    // become one string. Look for known item mod patterns embedded in noise.
    const extractedMod = extractEmbeddedMod(line);
    if (extractedMod) {
      result.explicitMods.push(stripTierRanges(extractedMod));
      continue;
    }

    // Filter out map/area mods and UI noise
    if (NOISE_RE.test(line) || MAP_MOD_RE.test(line)) continue;

    const reqMatch = line.match(REQUIRES_RE);
    if (reqMatch) {
      result.requirements = reqMatch[1].trim();
      continue;
    }

    if (STAT_LINE_RE.test(line)) {
      result.stats.push(stripTierRanges(line));
      continue;
    }

    if (HAS_CHARM_SLOTS_RE.test(line)) {
      result.implicitMods.push(stripTierRanges(line));
      continue;
    }

    if (CORRUPTED_RE.test(line)) {
      result.corrupted = true;
      continue;
    }

    if (MIRRORED_RE.test(line)) {
      result.mirrored = true;
      continue;
    }

    // Lines that look like mods (start with +/- or contain % INCREASED/REDUCED)
    // but without PREFIX/SUFFIX marker — could be continuation or unlabeled mod
    if (/^[+-]?\d/.test(line) || /\d+%?\s+(INCREASED|REDUCED|TO)\s/i.test(line)) {
      result.explicitMods.push(stripTierRanges(line));
      continue;
    }

    // "GAIN X resource PER ENEMY HIT" / "ADDS X TO Y damage" as standalone lines
    if (/^(GAIN|ADDS)\s+\d/i.test(line)) {
      result.explicitMods.push(stripTierRanges(line));
      continue;
    }

    // Skip tier markers (T1-T10, standalone)
    if (/^T\d{1,2}$/i.test(line)) continue;

    // Skip map mods and other noise
    if (/^(MONSTERS|AREA|RARE MONSTERS|CONTAINS)\s/i.test(line)) continue;
    if (/^(INVENTORY|COSMETICS|INSPECT)\s*$/i.test(line)) continue;
  }

  return result;
}

/**
 * Determine rarity from parsed data.
 */
function detectRarity(parsed: ParsedOcrItem): string {
  const totalMods = parsed.explicitMods.length + parsed.implicitMods.length;
  if (totalMods === 0) return "Normal";
  // 3+ explicit mods is almost certainly Rare
  // Even 2 prefix+suffix is Rare (magic has max 1 prefix + 1 suffix)
  if (parsed.explicitMods.length >= 2) return "Rare";
  return "Magic";
}

/**
 * Build clipboard format string from parsed OCR data.
 */
export function reconstructClipboard(ocrText: string): string | null {
  const lines = ocrText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const parsed = parseOcrLines(lines);

  if (!parsed.itemClass) {
    console.log("[GFN] Reconstruct failed: no item class found");
    return null;
  }

  // If name/baseType missing (e.g. OCR didn't capture top of tooltip),
  // use item class as fallback — price check can still work on mods
  if (!parsed.baseType) {
    parsed.baseType = parsed.itemClass;
    console.log(`[GFN] No base type found, using item class: ${parsed.itemClass}`);
  }

  // Normalize mods: fix OCR typos via dictionary, then match against stats.ndjson.
  // "STRENCTH" → "STRENGTH", "+137 TO MAXIMUM LIFE" → "+137 to Maximum Life"
  parsed.explicitMods = parsed.explicitMods.map((mod) => {
    const fixed = fuzzyFixWords(mod);
    return matchStatLine(fixed) ?? fixed;
  });
  parsed.implicitMods = parsed.implicitMods.map((mod) => {
    const fixed = fuzzyFixWords(mod);
    return matchStatLine(fixed) ?? fixed;
  });

  const rarity = detectRarity(parsed);
  const sections: string[] = [];

  // Section 1: Header
  const header = [`Item Class: ${parsed.itemClass}`, `Rarity: ${rarity}`];
  if (parsed.name && parsed.name !== parsed.baseType) {
    header.push(parsed.name);
  }
  header.push(parsed.baseType);
  sections.push(header.join("\n"));

  // Section 2: Stats — convert "EVASION RATING: 44" → "Evasion Rating: 44"
  if (parsed.stats.length > 0) {
    sections.push(
      parsed.stats
        .map((s) => {
          const [label, ...rest] = s.split(":");
          return toTitleCase(label.trim()) + ":" + rest.join(":");
        })
        .join("\n"),
    );
  }

  // Section 3: Requirements — "LEVEL 48, 32 DEX, 32 INT" → "Level 48, 32 Dex, 32 Int"
  if (parsed.requirements) {
    const req = parsed.requirements
      .replace(/\bLEVEL\b/gi, "Level")
      .replace(/\bSTR\b/gi, "Str")
      .replace(/\bDEX\b/gi, "Dex")
      .replace(/\bINT\b/gi, "Int");
    sections.push(`Requires: ${req}`);
  }

  // Section 4: Item Level
  if (parsed.itemLevel) {
    sections.push(`Item Level: ${parsed.itemLevel}`);
  }

  // Section 5: Implicit mods
  if (parsed.implicitMods.length > 0) {
    sections.push(parsed.implicitMods.join("\n"));
  }

  // Section 6: Explicit mods
  if (parsed.explicitMods.length > 0) {
    sections.push(parsed.explicitMods.join("\n"));
  }

  // Section 7: Corrupted/Mirrored
  if (parsed.corrupted) {
    sections.push("Corrupted");
  }
  if (parsed.mirrored) {
    sections.push("Mirrored");
  }

  const result = sections.join("\n--------\n");
  console.log(`[GFN] Reconstructed clipboard (${result.length} chars):\n${result}`);
  return result;
}
