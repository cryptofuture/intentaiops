import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runInteractiveProcess } from '../src/process-runner.js'
import { TerminalUi } from '../src/terminal-ui.js'

const mode = process.argv[2]

if (mode === 'controller') await runController()
else if (mode === 'capture') await runCapture()
else {
  test('interactive process receives punctuation, Unicode, terminal keys, and pasted text through a PTY', async t => {
    const script = await findScriptBinary()
    if (!script) return t.skip('util-linux script is required for PTY integration coverage')

    const child = spawn(script, [
      '-qefc',
      `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} controller`,
      '/dev/null'
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let menuSubmitted = false
    let payloadSent = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.includes('MENU_READY') && !menuSubmitted) {
        menuSubmitted = true
        child.stdin.write('\r')
      }
      if (output.includes('SHELL_READY') && !payloadSent) {
        payloadSent = true
        child.stdin.write(testPayload())
      }
    })
    child.stderr.on('data', chunk => { output += chunk })

    const [code] = await once(child, 'close')
    assert.equal(code, 0, output)
    const match = output.match(/CAPTURE:([A-Za-z0-9+/=]+)/)
    assert.ok(match, output)
    assert.deepEqual(Buffer.from(match[1], 'base64'), testPayload().subarray(0, -1))
    assert.match(output, /UI_RESUMED:false:true/)
  })
}

async function runController () {
  const ui = new TerminalUi()
  process.stdout.write('MENU_READY\n')
  await ui.choose('Shell', [{ label: 'Open', value: 'open' }])
  process.stdout.write('SHELL_STARTING\n')
  await ui.withTerminalSuspended(() => runInteractiveProcess(process.execPath, [fileURLToPath(import.meta.url), 'capture']))
  process.stdout.write(`UI_RESUMED:${process.stdin.isRaw}:${process.stdin.isPaused()}\n`)
  ui.dispose()
}

async function runCapture () {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdout.write('SHELL_READY\n')
  const chunks = []
  for await (const chunk of process.stdin) {
    const boundary = chunk.indexOf(4)
    if (boundary === -1) {
      chunks.push(chunk)
      continue
    }
    chunks.push(chunk.subarray(0, boundary))
    process.stdout.write(`CAPTURE:${Buffer.concat(chunks).toString('base64')}\n`)
    return
  }
}

function testPayload () {
  return Buffer.from("!@#$%^&*()[]{};:\"'`~\\|/?\nZażółć 世界\n\u001b[A\u001b[B\u001b[C\u001b[D\tpasted text\nsecond line\u0003\u0004")
}

async function findScriptBinary () {
  const child = spawn('sh', ['-c', 'command -v script'], { stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  const [code] = await once(child, 'close')
  return code === 0 ? output.trim() : null
}

function shellQuote (value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
