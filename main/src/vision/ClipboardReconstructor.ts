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

import { matchStatLine, fuzzyFixWords, addDictionaryWords } from "./StatMatcher";
import { loadClientStrings, getClientString } from "./ClientStrings";

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
  // Gems — parser expects exact "Uncut X Gems" class names
  "UNCUT SKILL GEM": "Uncut Skill Gems",
  "UNCUT SUPPORT GEM": "Uncut Support Gems",
  "UNCUT SPIRIT GEM": "Uncut Spirit Gems",
  TABLET: "Tablet",
  "PRECURSOR TABLET": "Tablet",
  WAYSTONE: "Waystones",
};

// Regex patterns for OCR line classification
const ITEM_LEVEL_RE = /^(.+?):\s*ITEM LEVEL\s*(\d+)/i;
const REQUIRES_RE = /^REQUIRES:\s*(.+)/i;
const STAT_LINE_RE =
  /^(?:EVASION RATING|ARMOUR|ENERGY SHIELD|WARD|SPIRIT|QUALITY|PHYSICAL DAMAGE|ELEMENTAL DAMAGE|FIRE DAMAGE|COLD DAMAGE|LIGHTNING DAMAGE|CHAOS DAMAGE|CRITICAL HIT CHANCE|ATTACKS PER SECOND|RELOAD TIME|BLOCK CHANCE):\s*.+/i;
// PREFIX_RE/SUFFIX_RE/IMPLICIT_RE now searched as embedded patterns in parseOcrLines
const HAS_CHARM_SLOTS_RE = /^HAS\s+\d+.*CHARM SLOTS?/i;
// Parser expects "Charm Slots: N" — extract N from "HAS N(range) CHARM SLOTS"
function formatCharmSlots(line: string): string {
  const match = line.match(/HAS\s+(\d+)/i);
  return match ? `Charm Slots: ${match[1]}` : line;
}
// Flask-specific stat patterns (not in stats.ndjson)
const FLASK_STAT_RE =
  /^(RECOVERS|CONSUMES|CURRENTLY HAS|RIGHT CLICK|WHILE IN BELT|REFILL AT|\d+ USES REMAINING)/i;
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
  flaskStats: string[];  // "Recovers X Life...", "Currently has N Charges"
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
    .replace(/^\$(\d)/, "+$1")                            // OCR reads + as $: "$14%" → "+14%"
    .replace(/([A-Za-z])[.,]\s+([A-Za-z])/g, "$1 $2")   // OCR stray punctuation: "COLD. DAMAGE" → "COLD DAMAGE"
    .replace(/(\d+)\(\d+-\d+\)/g, "$1")                  // strip tier ranges
    .replace(/(\d+[\d.]*)\([\d.]+[-–][\d.]+\)/g, "$1")   // also handle decimal ranges
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")     // strip diacritics (TỌ→TO)
    .replace(/^[$#@!]+/, "")                               // strip leading junk chars
    .replace(/[!€]+$/g, "")                                // strip trailing junk
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
  if (/\b(SHORT ALLOC|JAPAN|REALM|MONSTER LEVEL|WOODLAND|HIDEOUT|TOWN|DREADNOUGHT)\b/i.test(normalized)) return true;
  // Allocation modes: "Free for All", "Free tor All" (OCR), "Short Allocation"
  if (/\bFREE\s+(FOR|TOR)\s+ALL\b/i.test(normalized)) return true;
  if (/\d+\s*GOL[DP]?/i.test(normalized)) return true; // "34 GOLD", "34 GOLPonster" (merged)
  if (/^\*?Monster\s*$/i.test(normalized)) return true; // standalone "Monster" from map overlay
  if (/^\d+\s*(FPS|FBS|г8S)?\s*$/i.test(line)) return true; // FPS counter
  if (/^(MORE THAN \d+|FATE OF|\*?LEAGUE\s*$)/i.test(normalized)) return true;
  // "Fate of the Vaal League" split across lines by AVF
  if (/\b(VAAL LEAGUE|VAAL|LEAGUE)\s*$/i.test(normalized) && line.length < 20) return true;
  return false;
}

/**
 * Clean noise prefix from mod after PREFIX/SUFFIX/IMPLICIT marker,
 * then normalize via fuzzy dictionary + stats.ndjson.
 * "Reali+8(7-10)% TO ALL..." → "+8% to all Elemental Resistances"
 */
function normalizeMarkerMod(raw: string): string {
  let trimmed = raw.trim();
  // Strip alphabetic noise prefix before the first number or +/-
  if (!/^[+-\d]/.test(trimmed)) {
    trimmed = trimmed.replace(/^[A-Za-z\s]*?([+-]?\d)/, "$1");
  }
  const stripped = stripTierRanges(trimmed);
  const fixed = fuzzyFixWords(stripped);
  return matchStatLine(fixed) ?? fixed;
}

/**
 * Format flask stat to match parser expectations.
 * "RECOVERS 920 LIFE OVER 3 SECONDS" → "Recovers 920 Life over 3 Seconds"
 */
function formatFlaskStat(s: string): string {
  // Use sentence-case: capitalize first word, lowercase rest except proper nouns
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Set of known class names (uppercase) for simple format detection
const CLASS_NAMES = new Set(Object.keys(CLASS_MAP));

// Feed CLASS_MAP words into fuzzy dictionary (class names aren't in stats.ndjson or client_strings)
{
  const classWords: string[] = [];
  for (const key of Object.keys(CLASS_MAP)) {
    for (const w of key.split(/\s+/)) {
      if (w.length >= 3) classWords.push(w.charAt(0) + w.slice(1).toLowerCase());
    }
  }
  for (const val of Object.values(CLASS_MAP)) {
    for (const w of val.split(/\s+/)) {
      if (w.length >= 3) classWords.push(w);
    }
  }
  addDictionaryWords(classWords);
}

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
    flaskStats: [],
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
    if (line.length < 5) continue;
    if (/^[^A-Za-z]*$/.test(line)) continue;
    if (/[=<>{}|]/.test(line)) continue;
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

  // Parse lines after class name — WHITELIST approach
  // Apply fuzzy correction to every line before classification.
  for (let i = classIdx + 1; i < lines.length; i++) {
    const line = fuzzyFixWords(lines[i].trim());
    if (line.length < 3) continue;

    const reqMatch = line.match(REQUIRES_RE);
    if (reqMatch) {
      result.requirements = reqMatch[1].trim();
      continue;
    }

    if (STAT_LINE_RE.test(line)) {
      result.stats.push(stripTierRanges(line));
      continue;
    }

    if (CORRUPTED_RE.test(line)) { result.corrupted = true; continue; }
    if (MIRRORED_RE.test(line)) { result.mirrored = true; continue; }
    if (HAS_CHARM_SLOTS_RE.test(line)) {
      result.implicitMods.push(formatCharmSlots(line));
      continue;
    }

    // Flask/charm stats — separate section for parser compatibility
    if (FLASK_STAT_RE.test(line)) {
      result.flaskStats.push(stripTierRanges(line));
      continue;
    }

    // Mods: validate via stats.ndjson whitelist
    // Line is already fuzzy-fixed. Try full, then strip leading noise.
    const stripped = stripTierRanges(line);
    let matched = matchStatLine(stripped);
    if (!matched) {
      const cleanedLine = stripped.replace(/^[A-Za-z\s]*?([+-]?\d)/, "$1");
      if (cleanedLine !== stripped) {
        matched = matchStatLine(cleanedLine);
      }
    }
    if (matched) {
      result.explicitMods.push(matched);
      continue;
    }

    // Everything else ignored (whitelist: unknown = noise)
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
    flaskStats: [],
    implicitMods: [],
    explicitMods: [],
    corrupted: false,
    mirrored: false,
  };

  // Find the "CLASS: ITEM LEVEL N" anchor line
  // Apply fuzzy to fix OCR errors in class/level text
  let anchorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = fuzzyFixWords(lines[i]).match(ITEM_LEVEL_RE);
    if (match) {
      // The captured group may contain OCR noise before the class name.
      // Normalize diacritics (OCR: "FLAŞK" → "FLASK")
      const rawClass = match[1].trim().toUpperCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
    // Check for Uncut Gems: "UNCUT SKILL GEM (LEVEL 15)"
    for (const line of lines) {
      const gemMatch = line.match(/^(UNCUT\s+(?:SKILL|SUPPORT|SPIRIT)\s+GEM)\s*\(LEVEL?\s*(\d+)\)/i);
      if (gemMatch) {
        const gemType = gemMatch[1].toUpperCase().replace(/\s+/g, " ");
        result.itemClass = CLASS_MAP[gemType] || "Uncut Skill Gems";
        result.baseType = toTitleCase(gemMatch[1]) + ` (Level ${gemMatch[2]})`;
        result.name = result.baseType;
        return result;
      }
    }

    // Fallback: simple tooltip format (no Alt held).
    return parseSimpleFormat(lines);
  }

  // Work backwards from anchor to find name and base type
  // The 2 lines before the anchor are typically: Name, BaseType
  // But there might be junk from the game background before that
  // Look for the last 2 "clean" lines before anchor
  const priorLines: string[] = [];
  for (let i = anchorIdx - 1; i >= Math.max(0, anchorIdx - 8); i--) {
    const line = lines[i].trim();
    if (line.length < 5) continue; // reject short fragments ("Fre", "= TOT")
    if (/^[^A-Za-z]*$/.test(line)) continue;
    if (/[=<>{}|]/.test(line)) continue; // reject OCR junk with special chars
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

  // Work forwards from anchor: WHITELIST approach.
  // Apply fuzzy word correction to every line before classification.
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    const line = fuzzyFixWords(lines[i].trim());
    if (line.length < 3) continue;

    // 1. Requirements
    const reqMatch = line.match(REQUIRES_RE);
    if (reqMatch) {
      result.requirements = reqMatch[1].trim();
      continue;
    }

    // 2. Stats (Armour, Evasion Rating, Quality, etc.)
    if (STAT_LINE_RE.test(line)) {
      result.stats.push(stripTierRanges(line));
      continue;
    }

    // 3. Corrupted / Mirrored
    if (CORRUPTED_RE.test(line)) { result.corrupted = true; continue; }
    if (MIRRORED_RE.test(line)) { result.mirrored = true; continue; }

    // 4. Charm slots implicit
    if (HAS_CHARM_SLOTS_RE.test(line)) {
      result.implicitMods.push(formatCharmSlots(line));
      continue;
    }

    // 5. Flask/charm stats → separate array for proper section formatting
    if (FLASK_STAT_RE.test(line)) {
      result.flaskStats.push(stripTierRanges(line));
      continue;
    }

    // 6. Tier markers (T1-T10) — skip silently
    if (/^T\d{1,2}$/i.test(line)) continue;

    // 6. PREFIX/SUFFIX/IMPLICIT markers → extract the mod text after.
    // OCR may merge noise before the marker: "Japan Re IMPLICIT +8% TO ALL..."
    // Strip any non-mod prefix: find first +/- or digit after marker.
    const embeddedPrefix = line.match(/\bPREFIX\s+(.+)/i);
    const embeddedSuffix = line.match(/\bSUFFIX\s+(.+)/i);
    const embeddedImplicit = line.match(/\bIMPLICIT\s+(.+)/i);
    if (embeddedPrefix) {
      const mod = normalizeMarkerMod(embeddedPrefix[1]);
      if (mod) { result.explicitMods.push(mod); continue; }
    }
    if (embeddedSuffix) {
      const mod = normalizeMarkerMod(embeddedSuffix[1]);
      if (mod) { result.explicitMods.push(mod); continue; }
    }
    if (embeddedImplicit) {
      const mod = normalizeMarkerMod(embeddedImplicit[1]);
      if (mod) { result.implicitMods.push(mod); continue; }
      continue;
    }

    // 7. Mod lines — WHITELIST via stats.ndjson matching.
    // 7. Mod lines — WHITELIST via stats.ndjson matching.
    // Line is already fuzzy-fixed. Try full, then strip leading noise.
    const stripped = stripTierRanges(line);
    let matched = matchStatLine(stripped);
    if (!matched) {
      // Strip leading alphabetic noise before first number or +/-
      const cleanedLine = stripped.replace(/^[A-Za-z\s]*?([+-]?\d)/, "$1");
      if (cleanedLine !== stripped) {
        matched = matchStatLine(cleanedLine);
      }
    }
    if (matched) {
      result.explicitMods.push(matched);
      continue;
    }

    // 8. Embedded mod extraction (AVF merges map mods + item mods on one line)
    const extractedMod = extractEmbeddedMod(line);
    if (extractedMod) {
      const eMod = stripTierRanges(extractedMod);
      const eFixed = fuzzyFixWords(eMod);
      const eMatched = matchStatLine(eFixed);
      result.explicitMods.push(eMatched ?? eMod);
      continue;
    }

    // Everything else is ignored (whitelist approach: unknown = noise)
  }

  return result;
}

/**
 * Determine rarity from parsed data.
 */
function detectRarity(parsed: ParsedOcrItem): string {
  // Uncut gems are always Currency rarity
  if (parsed.itemClass?.startsWith("Uncut ")) return "Currency";

  const totalMods = parsed.explicitMods.length + parsed.implicitMods.length;
  if (totalMods === 0) return "Normal";
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

  // Mods are already normalized in parseOcrLines/parseSimpleFormat via
  // fuzzyFixWords + matchStatLine whitelist.

  const rarity = detectRarity(parsed);
  const sections: string[] = [];

  // Section 1: Header
  const header = [`Item Class: ${parsed.itemClass}`, `Rarity: ${rarity}`];
  if (parsed.name && parsed.name !== parsed.baseType) {
    header.push(parsed.name);
  }
  header.push(parsed.baseType);
  sections.push(header.join("\n"));

  // Section 2: Stats — use EXACT labels from renderer client_strings
  // Parser does startsWith() match, so casing must be exact.
  if (parsed.stats.length > 0) {
    sections.push(
      parsed.stats
        .map((s) => {
          const colonIdx = s.indexOf(":");
          if (colonIdx === -1) return s.trim();
          const label = s.slice(0, colonIdx).trim().toUpperCase();
          const value = s.slice(colonIdx + 1).trim();
          const exact = getClientString(label);
          return (exact ?? toTitleCase(label.toLowerCase())) + ": " + value;
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

  // Section 5: Flask stats — parser expects exact format:
  // - "Recovers X Life over Y Seconds" etc. in one section
  // - "Currently has N Charges" in its OWN section (parser regex: /^Currently has \d+ Charges$/)
  if (parsed.flaskStats.length > 0) {
    const chargesLine = parsed.flaskStats.find((s) => /^CURRENTLY HAS/i.test(s));
    const otherFlask = parsed.flaskStats.filter((s) =>
      !/^CURRENTLY HAS|^RIGHT CLICK|^WHILE IN BELT|^REFILL AT/i.test(s),
    );
    if (otherFlask.length > 0) {
      sections.push(
        otherFlask.map((s) => formatFlaskStat(s)).join("\n"),
      );
    }
    if (chargesLine) {
      // Parser expects EXACT: "Currently has N Charges" (case-sensitive regex)
      const n = chargesLine.match(/\d+/)?.[0] ?? "0";
      sections.push(`Currently has ${n} Charges`);
    }
  }

  // Section 6: Implicit mods
  if (parsed.implicitMods.length > 0) {
    sections.push(parsed.implicitMods.join("\n"));
  }

  // Section 7: Explicit mods
  if (parsed.explicitMods.length > 0) {
    sections.push(parsed.explicitMods.join("\n"));
  }

  // Section 8: Corrupted/Mirrored
  if (parsed.corrupted) {
    sections.push("Corrupted");
  }
  if (parsed.mirrored) {
    sections.push("Mirrored");
  }

  const result = sections.join("\n--------\n");

  // Validate: simulate what renderer parser expects
  const vLines = result.split("\n");
  const issues: string[] = [];
  if (!vLines[0]?.startsWith("Item Class: ")) issues.push("missing 'Item Class: ' prefix");
  if (!vLines[1]?.startsWith("Rarity: ")) issues.push("missing 'Rarity: ' prefix");
  if (!vLines[2] || vLines[2].length < 3) issues.push("missing item name");
  if (result.indexOf("--------") === -1) issues.push("no section separators");
  if (issues.length > 0) {
    console.log(`[GFN] ⚠ Clipboard validation issues: ${issues.join(", ")}`);
  }

  console.log(`[GFN] Reconstructed clipboard (${result.length} chars):\n${result}`);
  return result;
}
