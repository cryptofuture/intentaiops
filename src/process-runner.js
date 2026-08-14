import { spawn } from 'node:child_process'

export async function runProcess (command, args, options = {}) {
  const {
    input,
    timeoutMs = 30000,
    maxOutputBytes = 1024 * 1024,
    spawnImpl = spawn,
    cwd,
    env,
    onStdout,
    onStderr
  } = options

  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1000).unref()
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      onStdout?.(chunk.toString('utf8'))
      if (stdoutBytes >= maxOutputBytes) return
      const remaining = maxOutputBytes - stdoutBytes
      const kept = chunk.subarray(0, remaining)
      stdout.push(kept)
      stdoutBytes += kept.length
    })
    child.stderr.on('data', chunk => {
      onStderr?.(chunk.toString('utf8'))
      if (stderrBytes >= maxOutputBytes) return
      const remaining = maxOutputBytes - stderrBytes
      const kept = chunk.subarray(0, remaining)
      stderr.push(kept)
      stderrBytes += kept.length
    })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdoutTruncated: stdoutBytes >= maxOutputBytes,
        stderrTruncated: stderrBytes >= maxOutputBytes
      })
    })

    if (input === undefined) {
      child.stdin.end()
    } else {
      child.stdin.end(input)
    }
  })
}

export async function runInteractiveProcess (command, args, options = {}) {
  const { cwd, spawnImpl = spawn } = options
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      shell: false,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}
