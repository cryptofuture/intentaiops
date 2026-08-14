const FAILURE_CODES = new Set([
  'PACKAGE_NOT_FOUND',
  'PACKAGE_MANAGER_FAILED',
  'ARTIFACT_DOWNLOAD_FAILED',
  'CHECKSUM_MISMATCH',
  'SERVICE_NOT_READY',
  'DATABASE_NOT_READY',
  'APP_HTTP_500',
  'APP_HTTP_UNREACHABLE',
  'PERMISSION_DENIED',
  'PORT_CONFLICT',
  'TIMEOUT',
  'BASELINE_DRIFT',
  'FIRMWARE_VIRTUALIZATION_DISABLED',
  'UNSUPPORTED_WINDOWS_VERSION',
  'INSUFFICIENT_MEMORY',
  'SLAT_UNAVAILABLE',
  'WSL_RUNTIME_UNAVAILABLE',
  'REBOOT_REQUIRED',
  'DOCKER_SERVICE_NOT_READY',
  'WINDOWS_INTERACTIVE_USER_REQUIRED',
  'COMMAND_FAILED'
])

export function classifyFailure ({ item, result, error }) {
  const text = [error?.message, result?.stderr, result?.stdout].filter(Boolean).join('\n').slice(0, 8192)
  const lower = text.toLowerCase()
  let code = 'COMMAND_FAILED'
  if (/firmware_virtualization_disabled/u.test(lower)) code = 'FIRMWARE_VIRTUALIZATION_DISABLED'
  else if (/unsupported_windows_version/u.test(lower)) code = 'UNSUPPORTED_WINDOWS_VERSION'
  else if (/insufficient_memory/u.test(lower)) code = 'INSUFFICIENT_MEMORY'
  else if (/slat_unavailable/u.test(lower)) code = 'SLAT_UNAVAILABLE'
  else if (/wsl_runtime_unavailable/u.test(lower)) code = 'WSL_RUNTIME_UNAVAILABLE'
  else if (/webminai_reboot_required|reboot_required/u.test(lower)) code = 'REBOOT_REQUIRED'
  else if (/docker_service_not_ready/u.test(lower)) code = 'DOCKER_SERVICE_NOT_READY'
  else if (/windows_interactive_user_required/u.test(lower)) code = 'WINDOWS_INTERACTIVE_USER_REQUIRED'
  else if (/unable to locate package|no match for argument|target not found|no such package|nothing provides|package .* not found/u.test(lower)) code = 'PACKAGE_NOT_FOUND'
  else if (/apt(?:-get)?:|dnf:|yum:|apk:|pacman:|zypper:/u.test(lower) && item.phase === 'packages') code = 'PACKAGE_MANAGER_FAILED'
  else if (/checksum|sha(?:1|256|512).*(?:mismatch|failed)|digest.*(?:mismatch|failed)/u.test(lower)) code = 'CHECKSUM_MISMATCH'
  else if (/curl: \(|wget:|download.*failed|could not resolve host/u.test(lower) && item.phase === 'acquire') code = 'ARTIFACT_DOWNLOAD_FAILED'
  else if (/http\/?\d(?:\.\d)?[" ]+500|status(?: code)?[=: ]+500|http 500/u.test(lower)) code = 'APP_HTTP_500'
  else if (item.phase === 'health' && /connection refused|couldn't connect|failed to connect|timed out|empty reply/u.test(lower)) code = 'APP_HTTP_UNREACHABLE'
  else if (item.phase === 'database' && /not ready|can't connect|connection refused|authentication failed/u.test(lower)) code = 'DATABASE_NOT_READY'
  else if (item.phase === 'services' || /service.*(?:failed|not running)|unit .* failed/u.test(lower)) code = 'SERVICE_NOT_READY'
  else if (/permission denied|operation not permitted|access is denied/u.test(lower)) code = 'PERMISSION_DENIED'
  else if (/address already in use|port .* already allocated|bind.*failed/u.test(lower)) code = 'PORT_CONFLICT'
  else if (/timed out|timeout|deadline exceeded/u.test(lower)) code = 'TIMEOUT'
  else if (item.phase === 'baseline' && /drift|baseline.*(?:different|mismatch|failed)/u.test(lower)) code = 'BASELINE_DRIFT'
  return {
    code,
    phase: item.phase ?? 'application',
    commandId: item.id,
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    evidence: safeEvidence(text)
  }
}

export function isFailureCode (value) {
  return FAILURE_CODES.has(value)
}

function safeEvidence (text) {
  return String(text)
    .replaceAll(/(?:password|passwd|token|secret|authorization)\s*[=:]\s*[^\s;,]+/giu, '$1=[redacted]')
    .replaceAll(/[A-Za-z0-9_-]{48,}/gu, '[redacted-long-value]')
    .replaceAll(/[\r\n]+/gu, ' ')
    .slice(0, 500)
}
