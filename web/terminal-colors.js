const renderers = new WeakMap()
const rgb = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16))

export function updateTerminalColors (renderer, original, theme) {
  let state = renderers.get(renderer)
  if (!state) {
    state = { foreground: new Map(), background: new Map() }
    renderers.set(renderer, state)
    // Ghostty 0.4 exposes resolved RGB cells, not live palette updates or color provenance.
    for (const method of ['renderCellBackground', 'renderCellText']) {
      const render = renderer[method]
      renderer[method] = function (cell, ...position) {
        const foreground = state.foreground.get([cell.fg_r, cell.fg_g, cell.fg_b].join(','))
        const background = state.background.get([cell.bg_r, cell.bg_g, cell.bg_b].join(','))
        const value = foreground || background ? { ...cell } : cell
        if (foreground) [value.fg_r, value.fg_g, value.fg_b] = foreground
        if (background) [value.bg_r, value.bg_g, value.bg_b] = background
        return render.call(this, value, ...position)
      }
    }
  }
  for (const [channel, role] of [['foreground', 'foreground'], ['background', 'background']]) {
    state[channel].clear()
    for (const key of Object.keys(original).filter(key => /^(?:bright)?(?:Black|Red|Green|Yellow|Blue|Magenta|Cyan|White)$/i.test(key))) {
      state[channel].set(rgb(original[key]).join(','), rgb(theme[key]))
    }
    state[channel].set(rgb(original[role]).join(','), rgb(theme[role]))
  }
}
