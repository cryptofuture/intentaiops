import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'
import { runProcess } from '../src/process-runner.js'

const args = process.argv.slice(2)
const hosts = []
let repetitions = 5
let allowed = false
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--allow-ssh') allowed = true
  else if (args[index] === '--host') hosts.push(args[++index])
  else if (args[index] === '--repetitions') repetitions = Number(args[++index])
  else throw new Error(`unknown benchmark option: ${args[index]}`)
}
if (!allowed || !hosts.length || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error('Usage: node scripts/benchmark-ssh.js --allow-ssh --host ssh://DISPOSABLE-HOST [--host ssh://SECOND-HOST] [--repetitions 5]')

const runner = (binary, args, options) => runProcess(binary, path.basename(binary) === 'ssh-add' ? args : ['-o', 'BatchMode=yes', ...args.map(argument => argument === 'StrictHostKeyChecking=ask' ? 'StrictHostKeyChecking=yes' : argument)], options)
const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-ssh-benchmark-'))
const file = path.join(directory, 'small.txt')
await writeFile(file, 'Intent AI Ops read-only SSH benchmark\n')
const output = { version: 1, repetitions, hostCount: hosts.length, client: { platform: process.platform, node: process.version }, measurements: [] }

try {
  for (const mode of ['disabled', 'session', 'pooled', 'pooled-compression']) {
    const ssh = new SystemSsh({ runner, interactiveRunner: runner, terminalCheck: () => true, transport: { multiplexing: mode !== 'disabled', compression: mode === 'pooled-compression' } })
    const open = host => mode.startsWith('pooled') ? ssh.acquireSession(host, { authentication: 'key' }) : ssh.openInteractiveSession(host, { authentication: 'key' })
    try {
      for (const workload of ['one-command', 'ten-sequential', 'fifty-sequential', 'ten-concurrent', 'small-scp', 'netdata-read-only', 'multi-host']) {
        const samples = []
        const latencies = []
        const establishment = []
        let unavailable
        for (let repetition = 0; repetition < repetitions; repetition++) {
          const started = performance.now()
          const selected = workload === 'multi-host' ? hosts : [hosts[0]]
          try {
            await Promise.all(selected.map(async host => {
              const connecting = performance.now()
              const lease = await open(host)
              establishment.push(performance.now() - connecting)
              try {
                const command = async () => {
                  const now = performance.now()
                  await lease.ssh.execute(host, 'true')
                  latencies.push(performance.now() - now)
                }
                if (workload === 'ten-concurrent') await Promise.all(Array.from({ length: 10 }, command))
                else if (workload === 'small-scp') {
                  const created = await lease.ssh.execute(host, 'mktemp -d /tmp/webminai.XXXXXX')
                  const remote = created.stdout.trim()
                  if (!/^\/tmp\/webminai\.[A-Za-z0-9]+$/u.test(remote)) throw new Error('benchmark requires a POSIX disposable SSH host')
                  try {
                    const now = performance.now()
                    await lease.ssh.copy(host, file, `${remote}/small.txt`)
                    latencies.push(performance.now() - now)
                  } finally { await lease.ssh.execute(host, `rm -f -- '${remote}/small.txt' && rmdir -- '${remote}'`) }
                } else if (workload === 'netdata-read-only') {
                  const now = performance.now()
                  const netdata = new NetdataClient({ ssh: lease.ssh, connectionUrl: host })
                  await netdata.health()
                  await netdata.inventory()
                  latencies.push(performance.now() - now)
                } else {
                  const count = workload === 'ten-sequential' ? 10 : workload === 'fifty-sequential' ? 50 : 1
                  for (let index = 0; index < count; index++) await command()
                }
              } finally { await lease.close() }
            }))
            samples.push(performance.now() - started)
          } catch (error) {
            if (workload !== 'netdata-read-only') throw error
            unavailable = 'Netdata health/inventory unavailable on the selected host'
            break
          }
        }
        output.measurements.push({ mode, workload, ...(unavailable ? { skipped: unavailable } : { elapsedMs: summarize(samples), latencyMs: summarize(latencies), establishmentMs: summarize(establishment) }) })
      }
      if (ssh.sessions) output.measurements.push({ mode, diagnostics: ssh.sessions.diagnostics() })
    } finally { await ssh.closeSessions() }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
} finally { await rm(directory, { recursive: true, force: true }) }

function summarize (values) {
  const sorted = [...values].sort((a, b) => a - b)
  return { total: values.reduce((sum, value) => sum + value, 0), median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)], samples: values.length }
}
