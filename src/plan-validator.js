import { buildSafeDiagnosticCommand, isDeploymentPhase, validateDiagnostic } from './deployment-phases.js'
import { classifyFailure } from './failure-signature.js'

const RISK = new Set(['read', 'change', 'destructive'])

/**
 * Validate an untrusted command plan and return the checked public shape.
 *
 * @param {unknown} plan
 * @param {import('./public-api-contracts.js').ExecutionPolicy} [policy]
 * @param {{ requireRevert?: boolean }} [options]
 * @returns {import('./public-api-contracts.js').CommandPlan}
 */
export function validateCommandPlan (plan, policy = {}, { requireRevert = true } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('plan must be an object')
  }
  const candidate = /** @type {Record<string, any>} */ (plan)
  if (typeof candidate.summary !== 'string' || !candidate.summary.trim() || !Array.isArray(candidate.commands) || !Array.isArray(candidate.revertCommands)) {
    throw new TypeError('plan requires a summary and commands array')
  }
  if (typeof candidate.changeOverview !== 'string' || !candidate.changeOverview.trim()) {
    throw new TypeError('plan requires a change overview')
  }
  const absolutePath = /^(?:\/[^\r\n]*|[A-Za-z]:[\\/][^\r\n]*)$/
  if (!Array.isArray(candidate.modifiedFiles) || candidate.modifiedFiles.length > 64 || candidate.modifiedFiles.some(file => typeof file !== 'string' || !absolutePath.test(file) || /^\/[A-Za-z]:[\\/]/.test(file))) {
    throw new TypeError('plan modified files must be absolute paths')
  }
  if (new Set(candidate.modifiedFiles).size !== candidate.modifiedFiles.length) throw new Error('plan contains duplicate modified files')

  const maxCommands = policy.maxCommands ?? 20
  const maxTimeoutMs = policy.maxTimeoutMs ?? 300000
  const maxJobTimeoutMs = policy.maxJobTimeoutMs ?? 60 * 60 * 1000
  const deniedPatterns = (policy.deniedPatterns ?? []).map(pattern => new RegExp(pattern, 'u'))
  if (candidate.commands.length > maxCommands || candidate.revertCommands.length > maxCommands) {
    throw new Error('plan contains too many commands')
  }
  validateCommandItems(candidate.commands, { policy, maxTimeoutMs, maxJobTimeoutMs, deniedPatterns, graph: 'commands' })
  validateCommandItems(candidate.revertCommands, { policy, maxTimeoutMs, maxJobTimeoutMs, deniedPatterns, graph: 'revertCommands' })
  if (requireRevert && candidate.commands.some(item => item.risk !== 'read') && candidate.revertCommands.length === 0) {
    throw new Error('a changing plan requires revert commands')
  }

  return /** @type {import('./public-api-contracts.js').CommandPlan} */ (candidate)
}

function validateCommandItems (commands, { policy, maxTimeoutMs, maxJobTimeoutMs, deniedPatterns, graph }) {
  const ids = new Set()
  for (const item of commands) {
    if (!item || typeof item !== 'object') throw new TypeError('invalid command plan item')
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(item.id)) {
      throw new TypeError('command id is invalid')
    }
    if (ids.has(item.id)) throw new Error(`duplicate command id: ${item.id}`)
    ids.add(item.id)
    if (typeof item.command !== 'string' || item.command.length === 0 || item.command.length > 32768) {
      throw new TypeError(`command ${item.id} is empty or too long`)
    }
    if (item.command.includes('\0')) throw new TypeError(`command ${item.id} contains a NUL byte`)
    const invokesSudo = /(^|[^A-Za-z0-9_])sudo([^A-Za-z0-9_]|$)/u.test(item.command)
    if (invokesSudo) throw new Error(`command ${item.id} includes sudo but Stage 2 already executes as root`)
    if (/webminai(?::|%3a)command/iu.test(item.command)) {
      throw new Error(`command ${item.id} recursively invokes the Intent AI Ops command function`)
    }
    if (/\/api\/v3\/(?:charts|alarms)(?:[/?'"\s]|$)/iu.test(item.command)) {
      throw new Error(`command ${item.id} uses an invalid Netdata API v3 endpoint`)
    }
    if (/\/api\/v3\/function\//iu.test(item.command)) {
      throw new Error(`command ${item.id} uses a path segment instead of the Netdata function query parameter`)
    }
    if (removesStage2Prerequisite(item.command)) {
      throw new Error(`command ${item.id} removes a Intent AI Ops Stage 2 prerequisite; curl, Netdata, OpenSSH, and Intent AI Ops runtime files must survive application tasks and reverts`)
    }
    if (item.requiresSudo === true && policy.executionIdentity !== 'root') {
      throw new Error(`command ${item.id} requires root but policy forbids it`)
    }
    if (!RISK.has(item.risk)) throw new TypeError(`command ${item.id} has an invalid risk`)
    if (item.executionMode !== undefined && item.executionMode !== 'job') {
      throw new TypeError(`command ${item.id} has an invalid execution mode`)
    }
    if (item.phase !== undefined && item.phase !== null && !isDeploymentPhase(item.phase)) throw new TypeError(`command ${item.id} has an invalid deployment phase`)
    validateCommandSource(item.source, item.id)
    try {
      validateDiagnostic(item.diagnostic)
    } catch (error) {
      const kind = typeof item.diagnostic?.kind === 'string' ? item.diagnostic.kind : 'safe'
      const target = typeof item.diagnostic?.target === 'string' ? JSON.stringify(item.diagnostic.target) : 'undefined'
      throw new TypeError(`command ${item.id} has invalid ${kind} diagnostic target ${target}: ${error.message}`, { cause: error })
    }
    const timeoutLimit = item.executionMode === 'job' ? maxJobTimeoutMs : maxTimeoutMs
    if (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1000 || item.timeoutMs > timeoutLimit) {
      throw new TypeError(`command ${item.id} has an invalid timeout`)
    }
    validateRetry(item)
    for (const denied of deniedPatterns) {
      if (denied.test(item.command)) throw new Error(`command ${item.id} matches a denied pattern`)
    }
  }

  const precedingIds = new Set()
  for (const item of commands) {
    const dependencies = item.dependsOn ?? []
    if (!Array.isArray(dependencies)) {
      throw new Error(`${graph} item ${item.id} has an unknown or non-preceding dependency; dependencies may reference only earlier IDs in ${graph}`)
    }
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`command ${item.id} has duplicate dependencies`)
    }
    if (dependencies.some(id => !precedingIds.has(id))) {
      throw new Error(`${graph} item ${item.id} has an unknown or non-preceding dependency; dependencies may reference only earlier IDs in ${graph}`)
    }
    precedingIds.add(item.id)
  }
}

function validateCommandSource (source, commandId) {
  if (source === undefined) return
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError(`command ${commandId} has invalid provenance`)
  if (!['verified-foundation', 'verified-application', 'ai-planned'].includes(source.type)) throw new TypeError(`command ${commandId} has invalid provenance type`)
  if (source.type === 'ai-planned') {
    if (Object.keys(source).some(key => key !== 'type')) throw new TypeError(`command ${commandId} has invalid AI provenance`)
    return
  }
  if (typeof source.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(source.id) || !Number.isInteger(source.version) || source.version < 1) throw new TypeError(`command ${commandId} has invalid verified provenance`)
}

function removesStage2Prerequisite (command) {
  const protectedPackage = '(?:curl|netdata(?:-[A-Za-z0-9_.+-]+)?|openssh(?:-[A-Za-z0-9_.+-]+)?|openssh-server)'
  const packageRemovalPatterns = [
    new RegExp(`\\b(?:apt|apt-get)\\b[^\\n;]*(?:remove|purge|autoremove)\\b[^\\n;]*\\b${protectedPackage}\\b`, 'iu'),
    new RegExp(`\\b(?:dnf|yum)\\b[^\\n;]*\\bremove\\b[^\\n;]*\\b${protectedPackage}\\b`, 'iu'),
    new RegExp(`\\bzypper\\b[^\\n;]*\\b(?:remove|rm)\\b[^\\n;]*\\b${protectedPackage}\\b`, 'iu'),
    new RegExp(`\\bapk\\b[^\\n;]*\\bdel\\b[^\\n;]*\\b${protectedPackage}\\b`, 'iu'),
    new RegExp(`\\bpacman\\b[^\\n;]*\\s-R[A-Za-z]*\\b[^\\n;]*\\b${protectedPackage}\\b`, 'iu')
  ]
  const unsafePackageRemoval = command.split(/[;\n]/u).some(segment => {
    if (!packageRemovalPatterns.some(pattern => pattern.test(segment))) return false
    return !/\bgrep\b[^;\n]*(?:\s-[A-Za-z]*v[A-Za-z]*\b|--invert-match\b)/iu.test(segment)
  })
  return unsafePackageRemoval || /(?:rm|unlink|find\b[^\n;]*-delete)[^\n;]*(?:\/usr\/local\/libexec\/webminai-stage2|\/var\/(?:lib|db)\/webminai\/action\.key|webminai\.plugin)/iu.test(command)
}

export async function executeApprovedPlan ({
  plan,
  policy,
  netdata,
  approve,
  onResult = _entry => {},
  requireRevert = true
}) {
  validateCommandPlan(plan, policy, { requireRevert })
  const results = []
  const statuses = new Map()

  for (const item of plan.commands) {
    if ((item.dependsOn ?? []).some(id => statuses.get(id) !== 'completed')) {
      const entry = { id: item.id, status: 'blocked' }
      results.push(entry)
      await onResult(entry)
      statuses.set(item.id, 'blocked')
      continue
    }

    const accepted = await approve(item)
    if (!accepted) {
      const entry = { id: item.id, status: 'rejected' }
      results.push(entry)
      await onResult(entry)
      statuses.set(item.id, 'rejected')
      continue
    }

    const startedAt = Date.now()
    const execution = await runCommandWithRetry(item, netdata)
    const { rawResult, executionError, attempts } = execution
    const result = redactSensitiveResult(item.command, rawResult)
    const status = rawResult.exitCode === 0 ? 'completed' : 'failed'
    const entry = /** @type {any} */ ({ id: item.id, phase: item.phase ?? null, status, durationMs: Date.now() - startedAt, result, ...(attempts > 1 ? { attempts } : {}) })
    if (status === 'failed') {
      entry.failure = classifyFailure({ item, result, error: executionError })
      if (item.diagnostic) entry.diagnostic = await runSafeDiagnostic(netdata, item.diagnostic)
    }
    results.push(entry)
    await onResult(entry)
    statuses.set(item.id, status)
    if (rawResult.exitCode !== 0) break
  }

  return results
}

function validateRetry (item) {
  if (item.retry === undefined) return
  const { attempts, intervalMs, exitCodes } = item.retry ?? {}
  if (!Number.isInteger(attempts) || attempts < 2 || attempts > 120) throw new TypeError(`command ${item.id} has invalid retry attempts`)
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 10000) throw new TypeError(`command ${item.id} has an invalid retry interval`)
  if (!Array.isArray(exitCodes) || exitCodes.length === 0 || exitCodes.length > 8 || exitCodes.some(code => !Number.isInteger(code) || code < 1 || code > 255) || new Set(exitCodes).size !== exitCodes.length) {
    throw new TypeError(`command ${item.id} has invalid retry exit codes`)
  }
  if ((attempts - 1) * intervalMs > 15 * 60 * 1000) throw new TypeError(`command ${item.id} has an excessive retry window`)
}

async function runCommandWithRetry (item, netdata) {
  const retry = item.retry ?? { attempts: 1, intervalMs: 0, exitCodes: [] }
  let rawResult
  let executionError
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    executionError = undefined
    try {
      const execute = item.executionMode === 'job' ? netdata.runJob?.bind(netdata) : netdata.runCommand?.bind(netdata)
      if (!execute) throw new Error(`Netdata client does not support ${item.executionMode === 'job' ? 'job' : 'command'} execution`)
      rawResult = await execute(item.command, {
        timeoutSeconds: Math.ceil(item.timeoutMs / 1000)
      })
    } catch (error) {
      executionError = error
      rawResult = { exitCode: null, stdout: '', stderr: String(error?.message ?? error) }
    }
    const retryable = retry.exitCodes.includes(rawResult.exitCode)
    if (!retryable || attempt === retry.attempts) return { rawResult, executionError, attempts: attempt }
    if (retry.intervalMs > 0) await new Promise(resolve => setTimeout(resolve, retry.intervalMs))
  }
}

async function runSafeDiagnostic (netdata, diagnostic) {
  const command = buildSafeDiagnosticCommand(diagnostic)
  try {
    const result = await netdata.runCommand(command, { timeoutSeconds: 15 })
    return {
      kind: diagnostic.kind,
      target: diagnostic.target,
      result: {
        exitCode: result.exitCode,
        stdout: String(result.stdout ?? '').slice(0, 4096),
        stderr: String(result.stderr ?? '').slice(0, 4096)
      }
    }
  } catch (error) {
    return { kind: diagnostic.kind, target: diagnostic.target, error: String(error?.message ?? error).slice(0, 500) }
  }
}

function redactSensitiveResult (command, result) {
  if (!isSensitiveCommand(command)) return result
  return {
    ...result,
    stdout: result.stdout ? '[redacted sensitive output]' : result.stdout,
    stderr: result.stderr ? '[redacted sensitive output]' : result.stderr
  }
}

function isSensitiveCommand (command) {
  return /\/root\/[A-Za-z0-9_.-]+_credentials(?:\/|\b)|C:\\ProgramData\\WebminAI\\credentials(?:\\|\b)|RandomNumberGenerator|openssl\s+rand|\/dev\/(?:u?random)\b|\b(?:docker\s+compose|docker-compose)\b/iu.test(command)
}
