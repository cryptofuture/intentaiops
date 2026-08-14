const PROFILES = {
  linux: {
    logSources: [
      'systemd journal: journalctl --since/--priority/--lines',
      'traditional system log: /var/log/messages or /var/log/syslog',
      'kernel log: journalctl -k or dmesg',
      'service state: systemctl --failed or OpenRC rc-status'
    ],
    updateTools: ['apt/dpkg', 'dnf/yum/rpm', 'zypper/rpm', 'apk', 'pacman']
  },
  freebsd: {
    logSources: [
      'system log: /var/log/messages',
      'daemon log: /var/log/daemon.log',
      'kernel ring buffer: dmesg',
      'service state: service -e and service <name> status'
    ],
    updateTools: ['pkg audit', 'pkg version']
  },
  windows: {
    logSources: [
      'Windows Event Log: System and Application',
      'service state: Win32_Service',
      'reliability and update state: CIM, registry, and Windows Update Agent'
    ],
    updateTools: ['Windows Update Agent COM API']
  },
  macos: {
    logSources: [
      'Apple unified log: log show',
      'traditional system log when present: /var/log/system.log',
      'system and application logs: /Library/Logs and ~/Library/Logs',
      'service state: launchctl print system'
    ],
    updateTools: ['softwareupdate']
  }
}

export function buildHostHealthTask (taskId, definition, { platform, linuxContext = null }) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  const profile = hostHealthProfile(platform, { webminaiLinuxContext: linuxContext })
  return {
    plan: {
      changeOverview: 'Collect bounded read-only operating-system evidence that supplements Netdata metrics, alerts, and host inventory for a concise health assessment.',
      modifiedFiles: [],
      assumptions: ['Netdata inventory is collected first and remains the primary source for metrics and active alerts.'],
      warnings: ['The report reads recent system/application errors and cached update metadata. Authentication and security logs are intentionally excluded.'],
      requiresConfirmation: true,
      commands: collector(platform),
      revertCommands: []
    },
    healthProfile: profile,
    definition
  }
}

export function hostHealthProfile (platform, inventory = null) {
  const profile = PROFILES[platform]
  if (!profile) throw new Error(`host health reporting does not support ${platform}`)
  const linux = platform === 'linux' ? linuxDiagnosticProfile(inventory?.webminaiLinuxContext) : null
  return {
    format: 'webminai-host-health-profile',
    version: 1,
    platform,
    ...(linux ? { distro: linux.distro, serviceManager: linux.serviceManager, packageManager: linux.packageManager } : {}),
    logSources: linux?.logSources ?? [...profile.logSources],
    updateTools: linux?.updateTools ?? [...profile.updateTools]
  }
}

export function isHostHealthTask (catalogId) {
  return /^host-health-(?:freebsd|linux|macos|windows)$/u.test(catalogId ?? '')
}

function collector (platform) {
  if (platform === 'linux') return linuxCollector()
  if (platform === 'freebsd') return freebsdCollector()
  if (platform === 'windows') return windowsCollector()
  if (platform === 'macos') return macosCollector()
  throw new Error(`host health reporting does not support ${platform}`)
}

function linuxCollector () {
  const parts = [
    "printf '%s\\n' '=== WEBMINAI LINUX HEALTH SUPPLEMENT v1 ==='",
    "printf '%s\\n' '-- failed services --'",
    "if command -v systemctl >/dev/null 2>&1; then systemctl --failed --no-legend --plain 2>&1 | head -n 80; elif command -v rc-status >/dev/null 2>&1; then rc-status --crashed 2>&1 | head -n 80; else printf '%s\\n' 'service-manager-check: unavailable'; fi",
    "printf '%s\\n' '-- recent priority errors (authentication logs excluded) --'",
    "if command -v journalctl >/dev/null 2>&1 && journalctl --list-boots >/dev/null 2>&1; then journalctl --since '-2 hours' --priority 0..3 --lines 120 --no-pager --output short-iso 2>&1; elif [ -r /var/log/messages ]; then tail -n 120 /var/log/messages; elif [ -r /var/log/syslog ]; then tail -n 120 /var/log/syslog; else printf '%s\\n' 'recent-system-log: unavailable'; fi",
    "printf '%s\\n' '-- recent kernel errors --'",
    "if command -v journalctl >/dev/null 2>&1 && journalctl --list-boots >/dev/null 2>&1; then journalctl -k -b --priority 0..3 --lines 80 --no-pager --output short-iso 2>&1; elif command -v dmesg >/dev/null 2>&1; then dmesg 2>&1 | tail -n 80; else printf '%s\\n' 'kernel-log: unavailable'; fi",
    "printf '%s\\n' '-- cached package updates and reboot state --'",
    "if command -v apt-get >/dev/null 2>&1; then apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | sed -n 's/^Inst /update: /p' | head -n 120; [ -e /var/run/reboot-required ] && printf '%s\\n' 'reboot-required: yes' || printf '%s\\n' 'reboot-required: no'; elif command -v dnf >/dev/null 2>&1; then dnf --cacheonly -q check-update 2>&1 | head -n 120; elif command -v yum >/dev/null 2>&1; then yum -C -q check-update 2>&1 | head -n 120; elif command -v zypper >/dev/null 2>&1; then zypper --no-refresh --non-interactive list-updates 2>&1 | head -n 120; elif command -v apk >/dev/null 2>&1; then apk version -l '<' 2>&1 | head -n 120; elif command -v pacman >/dev/null 2>&1; then pacman -Qu 2>&1 | head -n 120; else printf '%s\\n' 'package-update-check: unavailable'; fi",
    "printf '%s\\n' '-- top processes snapshot --'",
    'ps -eo pid,ppid,comm,%cpu,%mem --sort=-%cpu 2>/dev/null | head -n 16 || ps aux 2>/dev/null | head -n 16 || true',
    "printf '%s\\n' '-- container service snapshot --'",
    "if command -v docker >/dev/null 2>&1; then docker ps --format 'docker {{.Names}} {{.Status}} {{.Image}}' 2>&1 | head -n 80; elif command -v podman >/dev/null 2>&1; then podman ps --format 'podman {{.Names}} {{.Status}} {{.Image}}' 2>&1 | head -n 80; else printf '%s\\n' 'container-runtime: unavailable'; fi"
  ]
  return [
    healthItem('collect-health-reliability', parts.slice(0, 7).join('; '), 'Collect failed-service and recent system/kernel error evidence'),
    healthItem('collect-health-maintenance', parts.slice(7, 9).join('; '), 'Collect cached package-update and reboot evidence'),
    healthItem('collect-health-activity', parts.slice(9).join('; '), 'Collect bounded process and container activity snapshots')
  ]
}

function freebsdCollector () {
  const parts = [
    "printf '%s\\n' '=== WEBMINAI FREEBSD HEALTH SUPPLEMENT v1 ==='",
    "printf '%s\\n' '-- release and resource supplement --'",
    'freebsd-version -kru 2>&1 || true',
    'sysctl kern.boottime vm.loadavg hw.ncpu hw.physmem 2>&1 || true',
    'swapinfo -h 2>&1 || true',
    'df -h 2>&1 | head -n 80',
    'df -i 2>&1 | head -n 80',
    "printf '%s\\n' '-- recent system and daemon errors (authentication logs excluded) --'",
    "for file in /var/log/messages /var/log/daemon.log; do if [ -r \"$file\" ]; then printf '%s\\n' \"log: $file\"; tail -n 100 \"$file\"; fi; done",
    "printf '%s\\n' '-- kernel ring buffer --'",
    'dmesg 2>&1 | tail -n 80 || true',
    "printf '%s\\n' '-- enabled service status --'",
    "if command -v service >/dev/null 2>&1; then service -e 2>/dev/null | head -n 60 | while IFS= read -r item; do [ -n \"$item\" ] && \"$item\" status 2>&1 | head -n 3; done; else printf '%s\\n' 'service-check: unavailable'; fi",
    "printf '%s\\n' '-- package vulnerability and cached update state --'",
    "if command -v pkg >/dev/null 2>&1; then pkg audit -q 2>&1 | head -n 120; pkg version -vIL= 2>&1 | head -n 120; else printf '%s\\n' 'pkg-check: unavailable'; fi",
    "printf '%s\\n' '-- top processes snapshot --'",
    'ps auxww -r 2>/dev/null | head -n 16 || true',
    "printf '%s\\n' '-- Podman service snapshot --'",
    "if command -v podman >/dev/null 2>&1; then podman ps --format 'podman {{.Names}} {{.Status}} {{.Image}}' 2>&1 | head -n 80; else printf '%s\\n' 'podman: unavailable'; fi"
  ]
  return [
    healthItem('collect-health-reliability', [parts[0], ...parts.slice(7, 13)].join('; '), 'Collect recent system/kernel errors and enabled-service status'),
    healthItem('collect-health-maintenance', [parts[0], ...parts.slice(1, 7), ...parts.slice(13, 15)].join('; '), 'Collect resource, vulnerability, and cached package-update evidence'),
    healthItem('collect-health-activity', [parts[0], ...parts.slice(15)].join('; '), 'Collect bounded process and Podman activity snapshots')
  ]
}

function windowsCollector () {
  const parts = [
    "$ErrorActionPreference='Continue'",
    "Write-Output '=== WEBMINAI WINDOWS HEALTH SUPPLEMENT v1 ==='",
    "Write-Output '-- operating system, resources, and disks --'",
    '$os=Get-CimInstance Win32_OperatingSystem',
    '$cpu=Get-CimInstance Win32_Processor|Select-Object Name,LoadPercentage',
    '$disks=Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"|Select-Object DeviceID,Size,FreeSpace',
    '[pscustomobject]@{Caption=$os.Caption;Version=$os.Version;LastBootUpTime=$os.LastBootUpTime;TotalVisibleMemoryKB=$os.TotalVisibleMemorySize;FreePhysicalMemoryKB=$os.FreePhysicalMemory;CPU=$cpu;Disks=$disks}|ConvertTo-Json -Depth 4 -Compress',
    "Write-Output '-- failed automatic services --'",
    "Get-CimInstance Win32_Service|Where-Object{$_.StartMode -eq 'Auto' -and $_.State -ne 'Running'}|Select-Object -First 80 Name,DisplayName,State,Status,ExitCode|ConvertTo-Json -Compress",
    "Write-Output '-- recent System and Application errors (Security log excluded) --'",
    '$start=(Get-Date).AddHours(-2)',
    "try{Get-WinEvent -FilterHashtable @{LogName=@('System','Application');Level=@(1,2);StartTime=$start} -MaxEvents 120 -ErrorAction Stop|Select-Object TimeCreated,LogName,ProviderName,Id,LevelDisplayName,@{Name='Message';Expression={($_.Message -replace '[\\r\\n]+',' ').Substring(0,[Math]::Min(600,($_.Message -replace '[\\r\\n]+',' ').Length))}}|ConvertTo-Json -Compress}catch{Write-Output ('event-log-check: '+$_.Exception.Message)}",
    "Write-Output '-- pending reboot and available updates --'",
    "$reboot=(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')",
    "Write-Output ('reboot-required: '+$reboot)",
    "try{$searcher=(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher();$updates=$searcher.Search(\"IsInstalled=0 and IsHidden=0\").Updates;Write-Output ('available-updates: '+$updates.Count);@($updates|Select-Object -First 80 Title)|ConvertTo-Json -Compress}catch{Write-Output ('windows-update-check: '+$_.Exception.Message)}",
    "Write-Output '-- top processes snapshot --'",
    'Get-Process|Sort-Object CPU -Descending|Select-Object -First 15 Id,ProcessName,CPU,WorkingSet64|ConvertTo-Json -Compress',
    "Write-Output '-- Docker service snapshot --'",
    "if(Get-Command docker.exe -ErrorAction SilentlyContinue){& docker.exe ps --format 'docker {{.Names}} {{.Status}} {{.Image}}' 2>&1|Select-Object -First 80}else{Write-Output 'docker: unavailable'}"
  ]
  return [
    healthItem('collect-health-reliability', parts.slice(0, 12).join(';'), 'Collect operating-system, resource, failed-service, and recent event-log evidence', 120000),
    healthItem('collect-health-maintenance', [parts[0], parts[1], ...parts.slice(12, 16)].join(';'), 'Collect pending-reboot and Windows Update evidence', 180000, 'job'),
    healthItem('collect-health-activity', [parts[0], parts[1], ...parts.slice(16)].join(';'), 'Collect bounded process and Docker activity snapshots', 120000)
  ]
}

function macosCollector () {
  const bounded = 'run_bounded() { limit="$1"; shift; "$@" & child=$!; ( sleep "$limit"; kill -TERM "$child" 2>/dev/null || true ) & guard=$!; wait "$child"; status=$?; kill "$guard" 2>/dev/null || true; wait "$guard" 2>/dev/null || true; return "$status"; }'
  const parts = [
    "printf '%s\\n' '=== WEBMINAI MACOS HEALTH SUPPLEMENT v1 ==='",
    "printf '%s\\n' '-- release and resource supplement --'",
    'sw_vers 2>&1 || true',
    'sysctl kern.boottime vm.loadavg hw.ncpu hw.memsize vm.swapusage 2>&1 || true',
    'df -h 2>&1 | head -n 80',
    'vm_stat 2>&1 | head -n 40',
    "printf '%s\\n' '-- recent unified-log errors (authentication logs excluded) --'",
    "run_bounded 30 log show --last 30m --style compact --predicate 'messageType == error OR messageType == fault' 2>&1 | tail -n 120 || true",
    "printf '%s\\n' '-- non-running system services --'",
    "launchctl print system 2>&1 | grep -E 'state = (waiting|exited)|last exit code = [1-9]' | head -n 100 || true",
    "printf '%s\\n' '-- available software updates --'",
    'run_bounded 45 softwareupdate --list 2>&1 | head -n 120 || true',
    "printf '%s\\n' '-- top processes snapshot --'",
    'ps -A -o pid,ppid,comm,%cpu,%mem -r 2>/dev/null | head -n 16 || true',
    "printf '%s\\n' '-- Colima and Docker service snapshot --'",
    'if command -v colima >/dev/null 2>&1; then colima status 2>&1 | head -n 40; fi',
    "if command -v docker >/dev/null 2>&1; then docker ps --format 'docker {{.Names}} {{.Status}} {{.Image}}' 2>&1 | head -n 80; else printf '%s\\n' 'docker: unavailable'; fi"
  ]
  return [
    healthItem('collect-health-reliability', [bounded, parts[0], ...parts.slice(6, 10)].join('; '), 'Collect recent unified-log errors and non-running service evidence', 120000, 'job'),
    healthItem('collect-health-maintenance', [bounded, parts[0], ...parts.slice(1, 6), ...parts.slice(10, 12)].join('; '), 'Collect resource and available software-update evidence', 120000, 'job'),
    healthItem('collect-health-activity', [parts[0], ...parts.slice(12)].join('; '), 'Collect bounded process, Colima, and Docker activity snapshots', 120000)
  ]
}

function healthItem (id, command, purpose, timeoutMs = 120000, executionMode = null) {
  return {
    id,
    command,
    purpose,
    risk: 'read',
    timeoutMs,
    requiresSudo: false,
    dependsOn: [],
    ...(executionMode ? { executionMode } : {})
  }
}

function linuxDiagnosticProfile (context) {
  const id = String(context?.identity?.id ?? 'unknown').toLowerCase()
  const management = context?.management ?? {}
  const profile = {
    distro: id,
    serviceManager: management.serviceManager ?? 'systemd or OpenRC detection',
    packageManager: management.packageManager ?? 'runtime package-manager detection',
    logSources: [...PROFILES.linux.logSources],
    updateTools: [...PROFILES.linux.updateTools]
  }
  if (['debian', 'ubuntu'].includes(id)) {
    profile.logSources = ['systemd journal', '/var/log/syslog when rsyslog is installed', 'kernel journal or dmesg']
    profile.updateTools = ['apt/dpkg cached upgrade simulation', '/var/run/reboot-required']
  } else if (['almalinux', 'centos', 'fedora', 'ol', 'oracle', 'rhel', 'rocky'].includes(id)) {
    profile.logSources = ['systemd journal', '/var/log/messages when rsyslog is installed', 'kernel journal or dmesg']
    profile.updateTools = ['dnf/yum cached check-update', 'rpm package database']
  } else if (['opensuse', 'opensuse-leap', 'sles'].includes(id)) {
    profile.logSources = ['systemd journal', '/var/log/messages when rsyslog is installed', 'kernel journal or dmesg']
    profile.updateTools = ['zypper --no-refresh list-updates', 'rpm package database']
  } else if (id === 'alpine') {
    profile.logSources = ['/var/log/messages when syslog is enabled', 'OpenRC rc-status', 'dmesg']
    profile.updateTools = ['apk version against the installed repository index']
  } else if (id === 'arch') {
    profile.logSources = ['systemd journal', 'kernel journal or dmesg']
    profile.updateTools = ['pacman -Qu against the local sync database']
  }
  return profile
}
