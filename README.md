# Exiled Exchange 2 — GeForce NOW Edition

Fork of [Exiled Exchange 2](https://github.com/Kvan7/Exiled-Exchange-2) with **OCR-based price checking for GeForce NOW users**.

PoE2 on GeForce NOW doesn't allow clipboard access (Ctrl+C copies to the remote machine, not your local one). This fork replaces clipboard reading with Apple Vision Framework OCR — screenshot the tooltip, recognize text, price check.

## What's different from upstream

- **OCR price checking** via Apple Vision Framework (macOS only) — no clipboard needed
- **Auto-detect GFN**: set Window Title to "NVIDIA GeForce NOW" in settings, the app handles the rest
- **All default hotkeys work** — uIOhook captures keys globally, overlay shows over GFN window
- **Fuzzy OCR correction** — dictionary from game data (stats.ndjson + client_strings.js), handles typos
- **Full item support** — armour, weapons (DPS calc), flasks, charms, tablets, gems, jewellery

## How it works

1. Press hotkey (Ctrl+D by default) while hovering an item in GFN
2. App takes a screenshot, runs Apple Vision OCR on the tooltip area
3. Reconstructs clipboard-compatible text from OCR output
4. Sends to the same price check pipeline as normal Ctrl+C

## Setup (macOS)

1. Clone and build (see Development below)
2. Set Window Title to `NVIDIA GeForce NOW` in EE2 settings
3. Grant Accessibility and Screen Recording permissions to Electron
4. Run GFN in **windowed mode** (not fullscreen — overlay can't show over fullscreen Spaces)
5. Hotkeys: **Alt+D** = price check, **Shift+Space** = toggle overlay, **Esc** = close overlay

## Limitations

- **macOS only** — uses Apple Vision Framework for OCR
- **OCR is not perfect** — damage ranges, small text, and merged observations can cause errors
- **GFN windowed mode required** — overlay window can't display over fullscreen macOS Spaces
- **No tablet price check in simple mode** — use Alt+D for advanced tooltip

## Development

See [DEVELOPING.md](./DEVELOPING.md) and [CLAUDE.md](./CLAUDE.md) for architecture details.

```bash
# Terminal 1
cd renderer && npm install && npm run make-index-files && npm run dev

# Terminal 2
cd main && npm install && npm run dev
```

## Acknowledgments

- [Exiled Exchange 2](https://github.com/Kvan7/Exiled-Exchange-2) — upstream project
- [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade) — original project
- [libuiohook](https://github.com/kwhat/libuiohook)
- [Apple Vision Framework](https://developer.apple.com/documentation/vision) — OCR engine
