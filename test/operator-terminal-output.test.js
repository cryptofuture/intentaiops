import test from 'node:test'
import assert from 'node:assert/strict'
import { terminalOutputFilter } from '../web/terminal-output.js'

test('terminal output blocks clipboard and hyperlinks across every chunk boundary', () => {
  for (const sequence of ['\x1b]52;c;secret\x07', '\x1b]8;;https://example.com\x1b\\', '\x9d52;c;secret\x9c']) {
    for (let i = 0; i <= sequence.length; i++) {
      const filter = terminalOutputFilter()
      assert.equal(filter.write('before' + sequence.slice(0, i)) + filter.write(sequence.slice(i) + 'after'), 'beforeafter')
    }
  }
})

test('terminal output preserves VT rendering and bounds incomplete control sequences', () => {
  const filter = terminalOutputFilter()
  assert.equal(filter.write('\x1b[31mhello\x1b[0m\r\n'), '\x1b[31mhello\x1b[0m\r\n')
  assert.equal(filter.write('\x1b]0;' + 'x'.repeat(20000)), '')
  assert.equal(filter.write('\x07safe'), 'safe')
  filter.write('\x1b]52;')
  filter.reset()
  assert.equal(filter.write('new output'), 'new output')
  assert.equal(filter.write('\x1b\x1b]52;c;secret\x07safe'), '\x1bsafe')
})
