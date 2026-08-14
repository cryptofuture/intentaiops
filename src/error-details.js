export function formatDiagnosticError (error) {
  const sections = []
  const seen = new Set()
  collect(error, sections, seen)
  return redactDiagnosticText(sections.filter(Boolean).join('\n\n').trim())
}

function collect (error, sections, seen) {
  if (!error || seen.has(error)) return
  seen.add(error)

  if (error.message) sections.push(`Error: ${error.message}`)
  if (error.result) {
    const status = [
      `Exit code: ${error.result.code ?? 'unknown'}`,
      error.result.signal ? `Signal: ${error.result.signal}` : null,
      error.result.stdoutTruncated ? 'stdout was truncated' : null,
      error.result.stderrTruncated ? 'stderr was truncated' : null
    ].filter(Boolean).join('\n')
    sections.push(status)
    if (error.result.stdout?.trim()) sections.push(`Remote stdout:\n${error.result.stdout.trim()}`)
    if (error.result.stderr?.trim()) sections.push(`Remote stderr:\n${error.result.stderr.trim()}`)
  }
  if (error.diagnostics?.trim()) sections.push(`Remote diagnostics:\n${error.diagnostics.trim()}`)
  if (error.cause) collect(error.cause, sections, seen)
  if (error instanceof AggregateError) {
    for (const nested of error.errors) collect(nested, sections, seen)
  }
}

export function redactDiagnosticText (text) {
  return text
    .replace(/ssh:\/\/[^\s"']+/gi, '[redacted-ssh-url]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[redacted-64-hex]')
}
