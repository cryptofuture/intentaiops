export function ansiSegments (input) {
  const value = String(input ?? '').slice(0, 65536)
  const segments = []
  let text = ''; let foreground; let background; let bold = false
  const flush = () => { if (text) { segments.push({ text, foreground, background, bold }); text = '' } }
  const color = index => {
    if (index < 16) return `var(--ansi-${index})`
    if (index >= 232) { const gray = 8 + (index - 232) * 10; return `rgb(${gray} ${gray} ${gray})` }
    const level = v => v ? 55 + v * 40 : 0
    const n = index - 16
    return `rgb(${level(Math.floor(n / 36))} ${level(Math.floor(n / 6) % 6)} ${level(n % 6)})`
  }
  for (let i = 0; i < value.length && segments.length < 4096; i++) {
    const code = value.charCodeAt(i)
    if (code === 27) {
      flush()
      if (value[i + 1] === '[') {
        let end = i + 2
        while (end < value.length && !/[A-Za-z~]/u.test(value[end])) end++
        if (value[end] === 'm') {
          const args = value.slice(i + 2, end).split(';').map(v => Number(v || 0))
          if (args.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
            for (let a = 0; a < args.length; a++) {
              const n = args[a]
              if (n === 0) { foreground = background = undefined; bold = false }
              if (n === 1) bold = true
              if (n === 22) bold = false
              if (n === 39) foreground = undefined
              if (n === 49) background = undefined
              if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) foreground = color(n >= 90 ? n - 82 : n - 30)
              if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) background = color(n >= 100 ? n - 92 : n - 40)
              if ((n === 38 || n === 48) && args[a + 1] === 5 && args[a + 2] !== undefined) { const c = color(args[a + 2]); if (n === 38) foreground = c; else background = c; a += 2 }
              if ((n === 38 || n === 48) && args[a + 1] === 2 && args.slice(a + 2, a + 5).length === 3) { const c = `rgb(${args.slice(a + 2, a + 5).join(' ')})`; if (n === 38) foreground = c; else background = c; a += 4 }
            }
          }
        }
        i = end
      } else if (value[i + 1] === ']') {
        i += 2
        while (i < value.length && value.charCodeAt(i) !== 7 && !(value.charCodeAt(i) === 27 && value[i + 1] === '\\')) i++
        if (value.charCodeAt(i) === 27) i++
      } else i++
    } else if ((code >= 32 && (code < 127 || code > 159)) || code === 10 || code === 9) text += value[i]
  }
  flush()
  return segments
}
