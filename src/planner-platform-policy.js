import { detectPersistedPlatform } from './platform-identity.js'

export function detectPlannerPlatform (inventory) {
  return detectPersistedPlatform(inventory) ?? 'unknown'
}

export function validatePortablePlan (plan) {
  const unresolvedTaskPlaceholder = /(?:<\s*task[-_ ]?id\s*>|\{\{\s*task[-_ ]?id\s*\}\}|\$\{?TASK_ID\}?)/iu
  for (const item of [...plan.commands, ...plan.revertCommands]) {
    if ([...item.command].some(character => {
      const code = character.codePointAt(0)
      return code === 0x7f || (code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code))
    })) {
      throw new Error(`command ${item.id} contains a control character other than a command newline or tab; replace terminal escape or corrupted identifier bytes with plain shell text`)
    }
    if (unresolvedTaskPlaceholder.test(item.command)) {
      throw new Error(`command ${item.id} contains an unresolved task ID placeholder; use the exact task-state directory supplied in the prompt`)
    }
  }
  if (plan.modifiedFiles.some(file => unresolvedTaskPlaceholder.test(file))) {
    throw new Error('modifiedFiles contains an unresolved task ID placeholder; use the exact task-state directory supplied in the prompt')
  }
}

export function validateWindowsPlan (plan, inventory, request) {
  const commands = inventory?.webminaiExecution?.commands ?? {}
  if (plan.modifiedFiles.some(file => !/^[A-Za-z]:[\\/]/u.test(file))) {
    throw new Error('Windows modifiedFiles must use native drive-letter paths such as C:\\ProgramData\\...')
  }
  const items = [...plan.commands, ...plan.revertCommands]
  for (const item of items) {
    if (/\bNew-Item\b[^;\r\n]*\s-LiteralPath\b/iu.test(item.command)) {
      throw new Error(`command ${item.id} uses New-Item -LiteralPath, which is unavailable in Windows PowerShell 5.1`)
    }
    if (/&\s+(?:[A-Za-z0-9_.-]+\.exe|\$[A-Za-z_][A-Za-z0-9_.]*)/iu.test(item.command)) {
      throw new Error(`command ${item.id} directly invokes a native process with &, which is unsupported by the bounded Windows executor; use a PowerShell cmdlet or Start-Process -Wait`)
    }
    if (/\bwinget(?:\.exe)?\b/iu.test(item.command)) {
      throw new Error(`command ${item.id} uses WinGet, which is unsupported under LocalSystem`)
    }
    if (/\bchoco(?:\.exe)?\b/iu.test(item.command) && commands.chocolatey !== true) {
      throw new Error(`command ${item.id} uses Chocolatey but it is unavailable in the LocalSystem execution inventory`)
    }
    if (/\$env:LOCALAPPDATA\b/iu.test(item.command)) {
      throw new Error(`command ${item.id} relies on LOCALAPPDATA, which may be unset under the LocalSystem service environment`)
    }
    if (/\$_\.Publisher\s+-(?:like|match|eq)\s+['"][^'"]*Brave Software/iu.test(item.command)) {
      throw new Error(`command ${item.id} requires an English Brave registry Publisher value, which can be localized; verify the executable Authenticode signer instead`)
    }
  }
  if (!/\bbrave(?:\s+browser)?\b/iu.test(request)) return
  const commandText = items.map(item => item.command).join('\n')
  if (/Brave[^\s'";]*\.msi\b/iu.test(commandText) || plan.modifiedFiles.some(file => /Brave[^\\/]*\.msi$/iu.test(file))) {
    throw new Error('Brave Browser does not publish a BraveBrowser.msi; use its signed official standalone x64 EXE release asset')
  }
  if (!/api\.github\.com\/repos\/brave\/brave-browser\/releases\/latest(?:[?'"\s]|$)/iu.test(commandText)) {
    throw new Error('Brave installation must use the official releases/latest API endpoint so prerelease pagination cannot hide the stable release')
  }
  if (!/Get-AuthenticodeSignature/iu.test(commandText)) {
    throw new Error('Brave installation must verify the installer Authenticode signature before execution')
  }
  if (!/BraveBrowserStandaloneSetup\.exe\.sha256/iu.test(commandText)) {
    throw new Error('Brave installation must select only the exact BraveBrowserStandaloneSetup.exe.sha256 checksum asset when it is present')
  }
  if (/if\s*\([^)]*(?:ExistingInstallation|ProductExistedBefore|InstalledBefore)[^)]*\)\s*\{\s*throw\b/iu.test(commandText)) {
    throw new Error('Brave installation must treat an already installed product as an idempotent success after verification, not throw because it exists')
  }
  if (/-replace\s+['"]\[\^0-9A-Fa-f\]['"]\s*,\s*['"]{2}/iu.test(commandText) || /-replace\s+['"]\[\^0-9A-Fa-f\]\+['"]\s*,\s*['"]{2}/iu.test(commandText)) {
    throw new Error('Brave checksum parsing must capture one line-anchored 64-hex token instead of stripping non-hex characters from the filename')
  }
  for (const item of plan.commands) {
    if (/(?:Invoke-WebRequest|Start-Process)[\s\S]*BraveBrowserStandaloneSetup/iu.test(item.command) && item.timeoutMs !== 300000) {
      throw new Error(`command ${item.id} must use timeoutMs 300000 for the large Brave download or installer process`)
    }
  }
}

export function validateDockerAndSecrets (plan, inventory) {
  const items = [...plan.commands, ...plan.revertCommands]
  const commandText = items.map(item => item.command).join('\n')
  const docker = inventory?.webminaiDocker
  const usesDocker = /\bdocker(?:-compose|\s+compose|\s+run)\b/iu.test(commandText)
  if (usesDocker && docker?.preferred !== true) {
    throw new Error(`Docker is not enabled by this host's effective Docker preference: ${docker?.reason ?? 'unavailable'}`)
  }
  if (/\bdocker\s+run\b/iu.test(commandText)) {
    throw new Error('service deployments must use Docker Compose instead of docker run')
  }
  if (/\b(?:docker\s+compose|docker-compose)\s+config\b|\bdocker\s+inspect\b/iu.test(commandText)) {
    throw new Error('Docker commands must not render resolved configuration or inspect secret-bearing container environment data')
  }
  if (items.some(item => enablesShellTracing(item.command))) {
    throw new Error('commands that may handle credentials must not enable shell tracing')
  }
  if (/\bcat\s+(?:--\s+)?['"]?\/root\/[^\s'"]*_credentials(?:\/[^\s'"]*)?/iu.test(commandText)) {
    throw new Error('commands must not print root-only service credential files')
  }
  if (/\b(?:password|passwd|token|secret|api[_-]?key|username|login)\s*[:=]\s*['"]?(?!['"$%<{(])[^\s'";]{6,}/iu.test(commandText) || /--(?:password|token|secret|api-key)\s+['"]?(?!['"$<{])[^\s'"]{6,}/iu.test(commandText)) {
    throw new Error('plans must not contain literal login or secret values; generate them only during remote execution')
  }
  const generatesSecret = /openssl\s+rand|\/dev\/(?:u?random)\b/iu.test(commandText)
  if (generatesSecret && !/\/root\/[A-Za-z0-9_.-]+_credentials(?:\/|\b)/u.test(commandText)) {
    throw new Error('generated service credentials must be stored under /root/<service>_credentials')
  }
  if (generatesSecret && !/\bumask\s+0?77\b/u.test(commandText)) {
    throw new Error('credential generation must set umask 077')
  }
  if (/\b(?:docker\s+compose|docker-compose)\b/iu.test(commandText) && !plan.modifiedFiles.some(file => /^\/opt\/webminai\/services\/[^/]+\/(?:compose\.ya?ml|docker-compose\.ya?ml)$/u.test(file))) {
    throw new Error('Docker Compose service plans must list /opt/webminai/services/<service>/compose.yaml in modifiedFiles')
  }
}

export function validateNetdataFunctions (plan, inventory) {
  const knownFunctions = new Set(
    Array.isArray(inventory?.functions?.functions)
      ? inventory.functions.functions.map(item => item.name).filter(Boolean)
      : []
  )
  for (const item of [...plan.commands, ...plan.revertCommands]) {
    if (!/\/api\/v3\/function(?:[?/'"\s]|$)/iu.test(item.command)) continue
    const selected = [...item.command.matchAll(/function=([^&'"\s]+)/giu)]
    if (selected.length === 0) {
      throw new Error(`command ${item.id} does not select a Netdata function with the function query parameter`)
    }
    for (const match of selected) {
      let functionCall
      try {
        functionCall = decodeURIComponent(match[1])
      } catch {
        throw new Error(`command ${item.id} has an invalid encoded Netdata function name`)
      }
      const known = [...knownFunctions].some(name => functionCall === name || functionCall.startsWith(`${name} `))
      if (!known) throw new Error(`command ${item.id} uses a Netdata function absent from inventory: ${functionCall}`)
    }
  }
  return plan
}

function enablesShellTracing (command) {
  return /\bset\s+-[A-Za-z]*x[A-Za-z]*\b/u.test(command) ||
    /\bset[^;\r\n]*\s-o\s+xtrace\b/u.test(command)
}
