import assert from 'node:assert/strict'
import test from 'node:test'
import { ansiSegments } from '../web/ansi.js'

test('output parses only SGR styling and strips OSC, clipboard, cursor and erase controls', () => {
  const esc = String.fromCharCode(27)
  const value = `plain${esc}[31mred${esc}[0m${esc}]52;c;clipboard-secret${String.fromCharCode(7)}safe${esc}[2J${esc}[Hend`
  const segments = ansiSegments(value)
  assert.equal(segments.map(s => s.text).join(''), 'plainredsafeend')
  assert.equal(segments.find(s => s.text === 'red').foreground, 'var(--ansi-1)')
  assert.equal(ansiSegments(`${esc}[91mbright`)[0].foreground, 'var(--ansi-9)')
  assert.equal(ansiSegments(`${esc}[38;5;232mgray`)[0].foreground, 'rgb(8 8 8)')
  assert.equal(ansiSegments(`${esc}[38;2;1;2;3mRGB`)[0].foreground, 'rgb(1 2 3)')
  assert.equal(ansiSegments(`${esc}]8;;https://attacker.invalid${esc}\\link${esc}]8;;${esc}\\`)[0].text, 'link')
  assert.equal(ansiSegments('x'.repeat(70000)).map(s => s.text).join('').length, 65536)
  assert.equal(ansiSegments('<script>alert(1)</script>')[0].text, '<script>alert(1)</script>')
})
