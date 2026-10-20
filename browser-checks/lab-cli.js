import { spawn } from 'node:child_process'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { redactDiagnosticText } from '../src/error-details.js'

export async function launchLabCli ({ actions = false } = {}) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const child = spawn('script', ['-qefc', `${quote(process.execPath)} ${quote(path.resolve('bin/intentaiops.js'))} --web ${actions ? '--console-actions ' : ''}--no-debug --data-root ${quote(path.resolve(process.env.INTENT_WEB_DATA_ROOT))}`, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.stdin.write('\u0003')
    await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGTERM'), 45000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
  }
  try {
    const url = await new Promise((resolve, reject) => {
      let buffer = ''; let sent = false
      child.stderr.on('data', chunk => { buffer = (buffer + chunk.toString()).slice(-16384) })
      const timer = setTimeout(() => reject(new Error('Lab CLI startup timed out; check vault and foreground-session ownership')), 100000)
      const fail = () => {
        clearTimeout(timer)
        const safe = stripVTControlCharacters(buffer.replaceAll(process.env.VAULT_TEST, '[vault]'))
        const error = safe.split(/[\r\n]/u).findLast(line => /error|failed|locked|busy/iu.test(line)) ?? 'check vault and foreground-session ownership'
        reject(new Error('Lab CLI did not start: ' + redactDiagnosticText(error).slice(0, 600)))
      }
      child.once('error', fail); child.once('exit', fail)
      child.stdout.on('data', chunk => {
        buffer = (buffer + chunk.toString()).slice(-16384)
        if (!sent && buffer.includes('Vault passphrase:')) { sent = true; child.stdin.write(process.env.VAULT_TEST + '\r') }
        const found = /http:\/\/127\.0\.0\.1:\d+\/workspace\/[a-f0-9]+\/#([a-f0-9]{64})/u.exec(buffer)
        if (found) { clearTimeout(timer); resolve(found[0]) }
      })
    })
    return { url, close }
  } catch (error) { await close(); throw error }
}
