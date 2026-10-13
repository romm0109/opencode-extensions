// Preset template data copied from the MIT-licensed pi-starship package.
import { BRACKETED_SEGMENTS_PRESET } from "./starship-presets/bracketed-segments.ts"
import { CATPPUCCIN_POWERLINE_PRESET } from "./starship-presets/catppuccin-powerline.ts"
import { GRUVBOX_RAINBOW_PRESET } from "./starship-presets/gruvbox-rainbow.ts"
import { JETPACK_PRESET } from "./starship-presets/jetpack.ts"
import { MINIMAL_PRESET } from "./starship-presets/minimal.ts"
import { NERD_FONT_SYMBOLS_PRESET } from "./starship-presets/nerd-font-symbols.ts"
import { NO_EMPTY_ICONS_PRESET } from "./starship-presets/no-empty-icons.ts"
import { NO_NERD_FONT_PRESET } from "./starship-presets/no-nerd-font.ts"
import { NO_RUNTIME_VERSIONS_PRESET } from "./starship-presets/no-runtime-versions.ts"
import { PASTEL_POWERLINE_PRESET } from "./starship-presets/pastel-powerline.ts"
import { PLAIN_TEXT_SYMBOLS_PRESET } from "./starship-presets/plain-text-symbols.ts"
import { PURE_PRESET } from "./starship-presets/pure-preset.ts"
import { TOKYO_NIGHT_PRESET } from "./starship-presets/tokyo-night.ts"

export const STARSHIP_PRESETS = {
  minimal: MINIMAL_PRESET,
  "bracketed-segments": BRACKETED_SEGMENTS_PRESET,
  "catppuccin-powerline": CATPPUCCIN_POWERLINE_PRESET,
  "gruvbox-rainbow": GRUVBOX_RAINBOW_PRESET,
  jetpack: JETPACK_PRESET,
  "nerd-font-symbols": NERD_FONT_SYMBOLS_PRESET,
  "no-empty-icons": NO_EMPTY_ICONS_PRESET,
  "no-nerd-font": NO_NERD_FONT_PRESET,
  "no-runtime-versions": NO_RUNTIME_VERSIONS_PRESET,
  "pastel-powerline": PASTEL_POWERLINE_PRESET,
  "plain-text-symbols": PLAIN_TEXT_SYMBOLS_PRESET,
  "pure-preset": PURE_PRESET,
  "tokyo-night": TOKYO_NIGHT_PRESET,
} as const

export type StarshipPresetID = keyof typeof STARSHIP_PRESETS
