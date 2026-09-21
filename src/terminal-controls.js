export const DEFAULT_TERMINAL_CONTROLS = Object.freeze({
  wrapNavigation: true,
  vimKeys: false,
  numberShortcuts: true,
  colorMode: 'auto',
  shortcutHints: true
})

export function normalizeTerminalControls (value = {}) {
  const controls = { ...DEFAULT_TERMINAL_CONTROLS, ...value }
  for (const key of ['wrapNavigation', 'vimKeys', 'numberShortcuts', 'shortcutHints']) {
    if (typeof controls[key] !== 'boolean') throw new TypeError(`invalid terminal control: ${key}`)
  }
  if (!['auto', 'color', 'monochrome'].includes(controls.colorMode)) throw new TypeError('invalid terminal control: colorMode')
  return controls
}
