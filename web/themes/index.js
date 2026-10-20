import palettes from './palettes.js'

export { palettes }
export const defaults = { mode: 'system', light: 'dawn', dark: 'dusk' }
export function appearance (value = {}) {
  const choice = (id, dark) => palettes.find(p => p.id === id && p.dark === dark)?.id ?? (dark ? 'dusk' : 'dawn')
  return { mode: ['system', 'light', 'dark'].includes(value.mode) ? value.mode : 'system', light: choice(value.light, false), dark: choice(value.dark, true) }
}
export function resolveTheme (preferences, systemDark) {
  const p = appearance(preferences)
  return palettes.find(theme => theme.id === p[(p.mode === 'system' ? systemDark : p.mode === 'dark') ? 'dark' : 'light'])
}
export function selectTheme (preferences, id, systemDark) {
  const p = appearance(preferences)
  const next = palettes.find(p => p.id === id)
  if (!next) throw new Error('Unknown theme')
  const current = resolveTheme(p, systemDark)
  return { ...p, [next.dark ? 'dark' : 'light']: id, mode: current.dark === next.dark ? p.mode : next.dark ? 'dark' : 'light' }
}
const rgb = hex => hex.slice(1).match(/../g).map(v => parseInt(v, 16))
const hex = values => '#' + values.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
export function shiftLightness (color, by) {
  const [r, g, b] = rgb(color).map(v => v / 255)
  const high = Math.max(r, g, b); const low = Math.min(r, g, b); const delta = high - low
  const l = (high + low) / 2
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1))
  const h = delta === 0 ? 0 : ((high === r ? (g - b) / delta + (g < b ? 6 : 0) : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4) / 6)
  const light = Math.max(0, Math.min(1, l + by))
  const a = s * Math.min(light, 1 - light)
  const channel = n => { const k = (n + h * 12) % 12; return (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255 }
  return hex([channel(0), channel(8), channel(4)])
}
const ansiDark = ['2c313a', 'e06c75', '98c379', 'e5c07b', '61afef', 'c678dd', '56b6c2', 'abb2bf', '5c6370', 'ff7b86', 'b5e890', 'ffd68a', '7cc4ff', 'de99f0', '74d0dc', 'e6e6e6']
const ansiLight = ['24292f', 'cf222e', '116329', '4d2d00', '0969da', '8250df', '1b7c83', '6e7781', '57606a', 'a40e26', '1a7f37', '633c01', '218bff', 'a475f9', '3192aa', '8c959f']
export function tokens (p) {
  const alpha = (color, opacity) => `rgb(${rgb(color).join(' ')} / ${opacity})`
  const brightness = rgb(p.accent).reduce((v, c, i) => v + c / 255 * [0.2126, 0.7152, 0.0722][i], 0)
  const result = { ...p, border_focused: p.accent, text_accent: p.accent2, accent_text: brightness > 0.55 ? hex(rgb(p.canvas).map(v => v * 0.6)) : '#ffffff' }
  result.approval_text = p.text
  result.approval_surface = p.surface
  for (const [role, color, opacity] of [['element', p.text, p.dark ? 0.05 : 0.035], ['element_hover', p.text, p.dark ? 0.09 : 0.065], ['element_selected', p.accent, p.dark ? 0.18 : 0.13], ['ghost_hover', p.text, p.dark ? 0.06 : 0.05], ['selection', p.accent, 0.3], ['scrim', '#000000', p.dark ? 0.55 : 0.22], ['track', p.text, p.dark ? 0.1 : 0.08]]) result[role] = alpha(color, opacity)
  const canvas = rgb(p.canvas).map(v => v / 255)
  const dark = (Math.max(...canvas) + Math.min(...canvas)) / 2 < 0.5
  const ansi = (dark ? ansiDark : ansiLight).map(v => '#' + v)
  for (const [i, role] of [[1, 'error'], [2, 'success'], [3, 'warning'], [4, 'info']]) { ansi[i] = p[role]; ansi[i + 8] = shiftLightness(p[role], dark ? 0.08 : -0.06) }
  ansi.forEach((value, i) => { result[`ansi-${i}`] = value })
  result.ui_font = p.system_fonts ? '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' : 'Geist, sans-serif'
  result.mono_font = p.system_fonts ? 'ui-monospace, Menlo, Consolas, monospace' : '"Geist Mono", monospace'
  return result
}
export function applyTheme (p) {
  for (const [key, value] of Object.entries(tokens(p))) if (typeof value === 'string') document.documentElement.style.setProperty('--' + key, value)
  document.documentElement.style.colorScheme = p.dark ? 'dark' : 'light'
  document.documentElement.dataset.theme = p.id
}
