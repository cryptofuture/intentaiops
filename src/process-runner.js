import { spawn } from 'node:child_process'

export async function runProcess (command, args, options = {}) {
  const {
    input,
    timeoutMs = 30000,
    maxOutputBytes = 1024 * 1024,
    spawnImpl = spawn,
    cwd,
    env,
    signal,
    onStdout,
    onStderr
  } = options

  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      ...(signal ? { signal } : {}),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    let killTimeout

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimeout = setTimeout(() => child.kill('SIGKILL'), 1000)
      killTimeout.unref()
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
      clearTimeout(killTimeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killTimeout)
      resolve({
        code,
        signal,
        ...(timedOut ? { timedOut: true, terminationRequested: 'timeout' } : {}),
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
  const { cwd, env, signal, spawnImpl = spawn } = options
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      ...(signal ? { signal } : {}),
      shell: false,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}
