export function terminalOutputFilter () {
  let pending = ''
  let state = 'text'
  let oversized = false
  return {
    reset () { pending = ''; state = 'text'; oversized = false },
    write (text) {
      let output = ''
      for (const char of text) {
        if (state === 'text') {
          if (char === '\x1b') { pending = char; state = 'escape' } else if (char === '\x9d') { pending = char; state = 'osc' } else output += char
        } else if (state === 'escape') {
          if (char === ']') { pending += char; state = 'osc' } else if (char === '\x1b') { output += pending; pending = char } else if (char === '\x9d') { output += pending; pending = char; state = 'osc' } else { output += pending + char; pending = ''; state = 'text' }
        } else {
          const ended = char === '\x07' || char === '\x9c' || (state === 'oscEscape' && char === '\\')
          if (!oversized) pending += char
          if (pending.length > 16384) { pending = ''; oversized = true }
          if (ended) {
            const body = pending.slice(pending.startsWith('\x1b]') ? 2 : 1)
            if (!oversized && !body.startsWith('8;') && !body.startsWith('52;')) output += pending
            pending = ''; oversized = false; state = 'text'
          } else state = char === '\x1b' ? 'oscEscape' : 'osc'
        }
      }
      return output
    }
  }
}
