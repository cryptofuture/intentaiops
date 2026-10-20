import { Ghostty } from 'ghostty-web'
import wasmUrl from 'ghostty-web/ghostty-vt.wasm?url'
import { tokens } from './themes/index.js'
import { updateTerminalColors } from './terminal-colors.js'

let loading
export function loadTerminal () {
  loading ??= fetch(wasmUrl).then(async response => {
    if (!response.ok) throw new Error('Could not load the bundled terminal engine')
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), { env: { log: () => {} } })
    return new Ghostty(instance)
  }).catch(error => { loading = undefined; throw error })
  return loading
}

const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']
export function terminalTheme (palette) {
  const colors = tokens(palette)
  return { foreground: palette.text, background: palette.canvas, cursor: palette.accent, selectionBackground: palette.accent + '4d', ...Object.fromEntries(names.map((name, i) => [name, colors['ansi-' + i]])) }
}

export function applyTerminalTheme (term, palette) {
  const colors = tokens(palette)
  const theme = terminalTheme(palette)
  const selection = term.getSelectionPosition()
  if (term.options.fontFamily !== colors.mono_font) term.options.fontFamily = colors.mono_font
  updateTerminalColors(term.renderer, term.options.theme, theme)
  term.renderer.setTheme(theme)
  if (selection) term.select(selection.start.x, selection.start.y, (selection.end.y - selection.start.y) * term.cols + selection.end.x - selection.start.x + 1)
  term.renderer.render(term.wasmTerm, true, term.getViewportY(), term)
}
