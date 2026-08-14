/* eslint-disable no-template-curly-in-string, quotes */

const UNIX_STATE_ROOT = '/var/lib/webminai/task-state'

export function buildSystemUpdateTask (taskId, definition, { platform }) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  const route = updateRoute(platform, taskId)
  return {
    plan: {
      changeOverview: 'Capture an exact package baseline, install all updates offered by the current operating-system release, preserve a package delta, check for a newer OS release without starting an OS upgrade, and never reboot the host.',
      modifiedFiles: route.modifiedFiles,
      assumptions: [
        'Configured package repositories remain on the current operating-system release or rolling-release channel.',
        'The task-owned audit directory is retained so the full before/after package delta remains available after bounded terminal output.'
      ],
      warnings: [
        'System updates are intentionally not given an automatic rollback plan because package downgrades are not reliably safe across distributions.',
        'Kernel or system-library updates may require a later administrator-approved reboot; this task never initiates one.',
        'A newer OS release is reported but never selected, downloaded, or installed by this task.'
      ],
      requiresConfirmation: true,
      commands: route.commands,
      revertCommands: []
    },
    updateProfile: systemUpdateProfile(platform),
    definition
  }
}

export function isSystemUpdateTask (catalogId) {
  return /^system-update-(?:freebsd|linux|windows)$/u.test(catalogId ?? '')
}

export function systemUpdateProfile (platform) {
  const profiles = {
    linux: {
      packageManagers: ['apt-get dist-upgrade', 'dnf upgrade', 'yum update', 'zypper update', 'apk upgrade', 'pacman -Syu'],
      releaseCheck: 'Read official distro release metadata and report published release targets; never invoke a release-upgrade tool.',
      rebootPolicy: 'No reboot or shutdown command is executed; systemd shutdown inhibition is used while the package manager runs when available.'
    },
    freebsd: {
      packageManagers: ['freebsd-update fetch/install for same-release base patches', 'pkg upgrade for installed third-party packages'],
      releaseCheck: 'Read the official FreeBSD release directory and compare it with freebsd-version; never invoke freebsd-update upgrade.',
      rebootPolicy: 'No reboot or shutdown command is executed; kernel/userland mismatch is reported for later action.'
    },
    windows: {
      packageManagers: ['Windows Update Agent COM API'],
      releaseCheck: 'Feature upgrades are detected by Windows Update category/title, excluded from installation, and reported separately.',
      rebootPolicy: 'Windows Update reboot requirements are recorded; no restart API or command is invoked.'
    }
  }
  const profile = profiles[platform]
  if (!profile) throw new Error(`system update does not support ${platform}`)
  return { format: 'webminai-system-update-profile', version: 1, platform, ...profile }
}

function updateRoute (platform, taskId) {
  if (platform === 'linux') return linuxRoute(taskId)
  if (platform === 'freebsd') return freebsdRoute(taskId)
  if (platform === 'windows') return windowsRoute(taskId)
  throw new Error(`system update does not support ${platform}`)
}

function linuxRoute (taskId) {
  const state = `${UNIX_STATE_ROOT}/${taskId}-system-update`
  const snapshot = [
    'snapshot() {',
    `if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f='\${binary:Package}\\t\${Version}\\n';`,
    `elif command -v rpm >/dev/null 2>&1; then rpm -qa --qf '%{NAME}.%{ARCH}\\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\\n' | awk -F '\\t' '$1 !~ /^gpg-pubkey\\./';`,
    `elif command -v pacman >/dev/null 2>&1; then pacman -Q | awk '{name=$1; $1=""; sub(/^ /,""); print name "\\t" $0}';`,
    `elif [ -r /lib/apk/db/installed ]; then awk -F: '/^P:/{name=substr($0,3)} /^V:/{print name "\\t" substr($0,3)}' /lib/apk/db/installed;`,
    'else return 1; fi;',
    '}'
  ].join(' ')
  const capture = [
    'set -eu',
    `state='${state}'`,
    'mkdir -p "$state"',
    'chmod 700 "$state"',
    `if [ -e "$state/owner" ]; then [ "$(cat "$state/owner")" = '${taskId}' ] || { printf '%s\n' 'task state ownership mismatch' >&2; exit 1; }; else printf '%s\n' '${taskId}' > "$state/owner"; fi`,
    'if [ ! -e "$state/os-before" ]; then { cat /etc/os-release 2>/dev/null || true; uname -a; } > "$state/os-before"; fi',
    `if [ ! -e "$state/packages-before.tsv" ]; then ${snapshot}; snapshot | LC_ALL=C sort > "$state/packages-before.tsv"; fi`,
    'printf "%s\\n" "baseline: $state/packages-before.tsv"',
    `wc -l < "$state/packages-before.tsv" | awk '{print "installed-packages-before: " $1}'`
  ].join('; ')
  const update = [
    'set -u',
    `state='${state}'`,
    '[ -f "$state/owner" ] || { printf "%s\\n" "missing update baseline" >&2; exit 1; }',
    'run_guarded() { if command -v systemd-inhibit >/dev/null 2>&1; then systemd-inhibit --what=shutdown --mode=block --why="Intent AI Ops current-release system update" "$@"; else "$@"; fi; }',
    'if [ -e "$state/update-complete" ]; then printf "%s\\n" "update already completed for this task"; exit 0; fi',
    'status=0',
    'if command -v apt-get >/dev/null 2>&1; then manager=apt; run_guarded apt-get update && run_guarded env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -y -o Dpkg::Options::=--force-confold dist-upgrade || status=$?; elif command -v dnf >/dev/null 2>&1; then manager=dnf; run_guarded dnf -y upgrade --refresh || status=$?; elif command -v yum >/dev/null 2>&1; then manager=yum; run_guarded yum -y update || status=$?; elif command -v zypper >/dev/null 2>&1; then manager=zypper; run_guarded zypper --non-interactive refresh && run_guarded zypper --non-interactive update --auto-agree-with-licenses || status=$?; elif command -v apk >/dev/null 2>&1; then manager=apk; run_guarded apk update && run_guarded apk upgrade --available || status=$?; elif command -v pacman >/dev/null 2>&1; then manager=pacman; run_guarded pacman -Syu --noconfirm || status=$?; else manager=unavailable; status=127; fi > "$state/update.log" 2>&1',
    'printf "%s\\n" "$manager" > "$state/package-manager"',
    'printf "%s\\n" "$status" > "$state/update-exit-code"',
    '[ "$status" -eq 0 ] && : > "$state/update-complete"',
    'printf "%s\\n" "package-manager: $manager" "package-manager-exit-code: $status" "reboot-performed: no"',
    'tail -n 40 "$state/update.log" || true',
    'exit 0'
  ].join('; ')
  const summarize = [
    'set -u',
    `state='${state}'`,
    snapshot,
    'snapshot | LC_ALL=C sort > "$state/packages-after.tsv"',
    `awk -F '\\t' 'NR==FNR{old[$1]=$2;next}{seen[$1]=1;if(!($1 in old))print "installed\\t"$1"\\t-\\t"$2;else if(old[$1]!=$2)print "updated\\t"$1"\\t"old[$1]"\\t"$2}END{for(name in old)if(!(name in seen))print "removed\\t"name"\\t"old[name]"\\t-"}' "$state/packages-before.tsv" "$state/packages-after.tsv" | LC_ALL=C sort > "$state/package-delta.tsv"`,
    'printf "%s\\n" "=== WEBMINAI SYSTEM UPDATE REPORT v1 ==="',
    'printf "%s\\n" "platform: linux" "package-manager: $(cat "$state/package-manager" 2>/dev/null || printf unknown)" "package-manager-exit-code: $(cat "$state/update-exit-code" 2>/dev/null || printf unknown)" "reboot-performed: no"',
    'if [ -e /var/run/reboot-required ]; then printf "%s\\n" "reboot-required: yes"; cat /var/run/reboot-required.pkgs 2>/dev/null | sed "s/^/reboot-trigger: /" | head -n 80; else printf "%s\\n" "reboot-required: no-or-not-reported"; fi',
    'printf "%s\\n" "changed-package-count: $(wc -l < "$state/package-delta.tsv" | tr -d " ")" "full-package-delta: $state/package-delta.tsv"',
    'sed -n "1,200p" "$state/package-delta.tsv"',
    'printf "%s\\n" "-- official newer OS release check (read-only) --"',
    '. /etc/os-release 2>/dev/null || true; printf "%s\\n" "current-release: ${ID:-unknown} ${VERSION_ID:-unknown}"',
    `case "\${ID:-}" in ubuntu) curl -fsSL --max-time 20 https://releases.ubuntu.com/ 2>/dev/null | sed -n 's/.*href="\\([0-9][0-9.]*\\)\\/".*/published-release: ubuntu \\1/p' | sort -u | tail -n 20 ;; debian) curl -fsSL --max-time 20 https://deb.debian.org/debian/dists/stable/Release 2>/dev/null | sed -n 's/^Version: /published-stable-release: debian /p' ;; fedora) curl -fsSL --max-time 20 https://fedoraproject.org/releases.json 2>/dev/null | sed -n 's/.*"version": "\\([0-9][0-9]*\\)".*/published-release: fedora \\1/p' | sort -u | tail -n 10 ;; alpine) machine=$(uname -m); curl -fsSL --max-time 20 "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/$machine/latest-releases.yaml" 2>/dev/null | sed -n 's/^  branch: v/published-stable-release: alpine /p' | sort -u ;; arch) printf '%s\\n' 'release-upgrade-availability: not-applicable (rolling release)' ;; opensuse*|sles) curl -fsSL --max-time 20 https://get.opensuse.org/leap/ 2>/dev/null | sed -n 's/.*url=\\/leap\\/\\([0-9][0-9.]*\\)\\/.*/published-release: openSUSE Leap \\1/p' | head -n 1 ;; almalinux) curl -fsSL --max-time 20 https://repo.almalinux.org/almalinux/ 2>/dev/null | sed -n 's/.*href="\\([0-9][0-9.]*\\)\\/".*/published-release: AlmaLinux \\1/p' | sort -u | tail -n 10 ;; rocky) curl -fsSL --max-time 20 https://download.rockylinux.org/pub/rocky/ 2>/dev/null | sed -n 's/.*href="\\([0-9][0-9.]*\\)\\/".*/published-release: Rocky Linux \\1/p' | sort -u | tail -n 10 ;; ol) curl -fsSL --max-time 20 https://yum.oracle.com/oracle-linux-isos.html 2>/dev/null | sed -n 's/.*Oracle Linux \\([0-9][0-9]*\\).*/published-release: Oracle Linux \\1/p' | sort -u | tail -n 10 ;; *) printf '%s\\n' 'release-upgrade-availability: unknown; unsupported official release index' ;; esac`,
    'code=$(cat "$state/update-exit-code" 2>/dev/null || printf 1)',
    'case "$code" in 0) exit 0 ;; *) exit "$code" ;; esac'
  ].join('; ')
  return {
    modifiedFiles: [state, '/var/lib/dpkg', '/var/lib/rpm', '/lib/apk/db', '/var/lib/pacman', '/usr', '/boot'],
    commands: [
      item('capture-update-baseline', capture, 'Capture the current OS identity and exact installed-package versions', 'change', 120000),
      item('install-current-release-updates', update, 'Install every package update offered by the configured current-release repositories without rebooting', 'change', 3600000, ['capture-update-baseline'], 'job'),
      item('report-system-update', summarize, 'Record the exact package delta, reboot requirement, and read-only OS-release availability check', 'read', 300000, ['install-current-release-updates'])
    ]
  }
}

function freebsdRoute (taskId) {
  const state = `/var/db/webminai/task-state/${taskId}-system-update`
  const capture = `set -eu; state='${state}'; mkdir -p "$state"; chmod 700 "$state"; if [ -e "$state/owner" ]; then [ "$(cat "$state/owner")" = '${taskId}' ] || exit 1; else printf '%s\\n' '${taskId}' > "$state/owner"; fi; if [ ! -e "$state/os-before" ]; then freebsd-version -kru > "$state/os-before"; uname -a >> "$state/os-before"; freebsd-version -k > "$state/kernel-before"; freebsd-version -r > "$state/running-kernel-before"; freebsd-version -u > "$state/userland-before"; fi; if [ ! -e "$state/packages-before.tsv" ]; then pkg query '%n\\t%v' | LC_ALL=C sort > "$state/packages-before.tsv"; fi; printf '%s\\n' "baseline: $state/packages-before.tsv"; wc -l < "$state/packages-before.tsv" | awk '{print "installed-packages-before: " $1}'`
  const update = `set -u; state='${state}'; base_fetch=127; base_install=127; pkg_status=127; base_mode=unknown; if pkg query '%n' 2>/dev/null | grep -q '^FreeBSD-runtime$'; then base_mode=pkgbase; base_fetch=0; base_install=0; printf '%s\\n' 'FreeBSD base is managed by the enabled pkgbase repository.' > "$state/freebsd-update.log"; elif command -v freebsd-update >/dev/null 2>&1; then base_mode=freebsd-update; env PAGER=cat freebsd-update --not-running-from-cron fetch > "$state/freebsd-update.log" 2>&1; base_fetch=$?; if [ "$base_fetch" -eq 0 ]; then env PAGER=cat freebsd-update install >> "$state/freebsd-update.log" 2>&1; base_install=$?; fi; else printf '%s\\n' 'freebsd-update unavailable and pkgbase not detected' > "$state/freebsd-update.log"; fi; pkg update -f > "$state/pkg-update.log" 2>&1 && pkg upgrade -y >> "$state/pkg-update.log" 2>&1; pkg_status=$?; printf '%s\\n' "$base_mode" > "$state/base-update-mode"; printf '%s\\n' "$base_fetch" > "$state/base-fetch-exit-code"; printf '%s\\n' "$base_install" > "$state/base-install-exit-code"; printf '%s\\n' "$pkg_status" > "$state/package-exit-code"; printf '%s\\n' "base-update-mode: $base_mode" "base-fetch-exit-code: $base_fetch" "base-install-exit-code: $base_install" "package-manager-exit-code: $pkg_status" 'reboot-performed: no'; tail -n 25 "$state/freebsd-update.log"; tail -n 25 "$state/pkg-update.log"; exit 0`
  const summarize = `set -u; state='${state}'; pkg query '%n\\t%v' | LC_ALL=C sort > "$state/packages-after.tsv"; awk -F '\\t' 'NR==FNR{old[$1]=$2;next}{seen[$1]=1;if(!($1 in old))print "installed\\t"$1"\\t-\\t"$2;else if(old[$1]!=$2)print "updated\\t"$1"\\t"old[$1]"\\t"$2}END{for(name in old)if(!(name in seen))print "removed\\t"name"\\t"old[name]"\\t-"}' "$state/packages-before.tsv" "$state/packages-after.tsv" | LC_ALL=C sort > "$state/package-delta.tsv"; printf '%s\\n' '=== WEBMINAI SYSTEM UPDATE REPORT v1 ===' 'platform: freebsd' 'reboot-performed: no'; printf '%s\\n' "base-update-mode: $(cat "$state/base-update-mode" 2>/dev/null || printf unknown)" "base-fetch-exit-code: $(cat "$state/base-fetch-exit-code")" "base-install-exit-code: $(cat "$state/base-install-exit-code")" "package-manager-exit-code: $(cat "$state/package-exit-code")" "installed-kernel-before: $(cat "$state/kernel-before" 2>/dev/null || printf unknown)" "installed-kernel-after: $(freebsd-version -k)" "installed-userland-before: $(cat "$state/userland-before" 2>/dev/null || printf unknown)" "installed-userland-after: $(freebsd-version -u)"; running=$(uname -r); installed=$(freebsd-version -k); [ "$running" = "$installed" ] && printf '%s\\n' 'reboot-required: no-kernel-mismatch' || printf '%s\\n' "reboot-required: yes; running=$running installed=$installed"; printf '%s\\n' "changed-package-count: $(wc -l < "$state/package-delta.tsv" | tr -d ' ')" "full-package-delta: $state/package-delta.tsv" "full-base-update-log: $state/freebsd-update.log" "full-package-update-log: $state/pkg-update.log"; sed -n '1,200p' "$state/package-delta.tsv"; printf '%s\\n' '-- official release directories (read-only) --'; machine=$(uname -m); fetch -qo - "https://download.freebsd.org/releases/$machine/$machine/" 2>/dev/null | sed -n 's/.*href="\\([0-9][0-9.]*-RELEASE\\)\\/".*/available-release: \\1/p' | sort -Vu | tail -n 20 || printf '%s\\n' 'release-upgrade-availability: unknown'; base_fetch=$(cat "$state/base-fetch-exit-code"); base_install=$(cat "$state/base-install-exit-code"); pkg_status=$(cat "$state/package-exit-code"); case "$base_fetch:$base_install:$pkg_status" in 0:0:0|0:2:0) exit 0 ;; *) exit 1 ;; esac`
  return {
    modifiedFiles: [state, '/var/db/freebsd-update', '/var/db/pkg', '/boot', '/usr'],
    commands: [
      item('capture-update-baseline', capture, 'Capture FreeBSD kernel/userland identity and exact package versions', 'change', 120000),
      item('install-current-release-updates', update, 'Install same-release FreeBSD base patches and all configured pkg updates without rebooting', 'change', 300000, ['capture-update-baseline']),
      item('report-system-update', summarize, 'Record package changes, kernel reboot need, and newer official FreeBSD releases', 'read', 300000, ['install-current-release-updates'])
    ]
  }
}

function windowsRoute (taskId) {
  const state = `C:\\ProgramData\\WebminAI\\Tasks\\${taskId}\\SystemUpdate`
  const featurePredicate = `function Test-FeatureUpgrade($u){$names=@();$ids=@();for($i=0;$i -lt $u.Categories.Count;$i++){$category=$u.Categories.Item($i);$names+=[string]$category.Name;$ids+=([string]$category.CategoryID).ToLowerInvariant()};return (($ids -contains '3689bdc8-b205-4af4-8d4a-a63924c5e9d5') -or ($names -contains 'Upgrades') -or ([string]$u.Title -match '(?i)^Feature update to Windows'))}`
  const capture = [
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)`,
    `$ErrorActionPreference='Stop'`,
    `$state='${state}'`,
    'New-Item -Path $state -ItemType Directory -Force|Out-Null',
    `$owner=Join-Path $state 'owner';if(Test-Path -LiteralPath $owner){if((Get-Content -LiteralPath $owner -Raw).Trim() -ne '${taskId}'){throw 'Task state ownership mismatch'}}else{Set-Content -LiteralPath $owner -Value '${taskId}' -Encoding ASCII}`,
    `$baseline=Join-Path $state 'baseline.json'`,
    `if(-not(Test-Path -LiteralPath $baseline)){${featurePredicate};$session=New-Object -ComObject Microsoft.Update.Session;$search=$session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0");$normal=@();$features=@();for($i=0;$i -lt $search.Updates.Count;$i++){$u=$search.Updates.Item($i);$entry=[pscustomobject]@{Title=[string]$u.Title;Identity=[string]$u.Identity.UpdateID;Revision=[int]$u.Identity.RevisionNumber};if(Test-FeatureUpgrade $u){$features+=$entry}else{$normal+=$entry}};$os=Get-CimInstance Win32_OperatingSystem;[pscustomobject]@{Caption=$os.Caption;Version=$os.Version;BuildNumber=$os.BuildNumber;Updates=@($normal);FeatureUpgrades=@($features);CapturedAtUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $baseline -Encoding UTF8}`,
    `$saved=Get-Content -LiteralPath $baseline -Raw|ConvertFrom-Json;[pscustomobject]@{Baseline=$baseline;ApplicableUpdates=@($saved.Updates).Count;ExcludedFeatureUpgrades=@($saved.FeatureUpgrades).Count}|ConvertTo-Json -Compress`
  ].join(';')
  const update = [
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)`,
    `$ErrorActionPreference='Stop'`,
    `$state='${state}'`,
    `$resultPath=Join-Path $state 'install-results.json'`,
    `try{${featurePredicate};$session=New-Object -ComObject Microsoft.Update.Session;$session.ClientApplicationID='Intent AI Ops current-release update';$search=$session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0");$collection=New-Object -ComObject Microsoft.Update.UpdateColl;for($i=0;$i -lt $search.Updates.Count;$i++){$u=$search.Updates.Item($i);if(-not(Test-FeatureUpgrade $u)){if(-not $u.EulaAccepted){$u.AcceptEula()};[void]$collection.Add($u)}};if($collection.Count -eq 0){[pscustomobject]@{Status='nothing-to-install';RebootRequired=$false;Updates=@();RebootPerformed=$false}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $resultPath -Encoding UTF8}else{$downloader=$session.CreateUpdateDownloader();$downloader.Updates=$collection;$download=$downloader.Download();$installer=$session.CreateUpdateInstaller();$installer.AllowSourcePrompts=$false;$installer.IsForced=$false;$installer.Updates=$collection;$installed=$installer.Install();$items=@();for($i=0;$i -lt $collection.Count;$i++){$one=$installed.GetUpdateResult($i);$items+=[pscustomobject]@{Title=[string]$collection.Item($i).Title;ResultCode=[int]$one.ResultCode;HResult=[int]$one.HResult;RebootRequired=[bool]$one.RebootRequired}};[pscustomobject]@{Status='install-attempted';DownloadResultCode=[int]$download.ResultCode;InstallResultCode=[int]$installed.ResultCode;RebootRequired=[bool]$installed.RebootRequired;RebootPerformed=$false;Updates=@($items)}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $resultPath -Encoding UTF8}}catch{[pscustomobject]@{Status='failed';Error=$_.Exception.Message;RebootPerformed=$false;Updates=@()}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $resultPath -Encoding UTF8}`,
    '$saved=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json',
    '[pscustomobject]@{Status=$saved.Status;UpdateCount=@($saved.Updates).Count;RebootRequired=$saved.RebootRequired;RebootPerformed=$false;AuditPath=$resultPath}|ConvertTo-Json -Compress',
    'exit 0'
  ].join(';')
  const summarize = [
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)`,
    `$ErrorActionPreference='Stop'`,
    `$state='${state}'`,
    `$resultPath=Join-Path $state 'install-results.json'`,
    '$saved=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json',
    `${featurePredicate};$session=New-Object -ComObject Microsoft.Update.Session;$search=$session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0");$features=@();for($i=0;$i -lt $search.Updates.Count;$i++){$u=$search.Updates.Item($i);if(Test-FeatureUpgrade $u){$features+=[pscustomobject]@{Title=[string]$u.Title;Identity=[string]$u.Identity.UpdateID}}}`,
    `$os=Get-CimInstance Win32_OperatingSystem`,
    `$pending=(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') -or [bool]$saved.RebootRequired`,
    `$report=[pscustomobject]@{Format='webminai-system-update-report';Version=1;Platform='windows';OS=[pscustomobject]@{Caption=$os.Caption;Version=$os.Version;BuildNumber=$os.BuildNumber};Status=$saved.Status;UpdatedSoftware=@($saved.Updates);RebootRequired=[bool]$pending;RebootPerformed=$false;AvailableFeatureUpgrades=@($features);FullAuditPath=$resultPath}`,
    '$report|ConvertTo-Json -Depth 7 -Compress',
    `if($saved.Status -eq 'failed'){exit 1};if(@($saved.Updates|Where-Object{$_.ResultCode -notin @(2,3)}).Count -gt 0){exit 1};exit 0`
  ].join(';')
  return {
    modifiedFiles: [state, 'C:\\Windows', 'C:\\Program Files'],
    commands: [
      item('capture-update-baseline', capture, 'Capture Windows build and applicable update identities while separating feature upgrades', 'change', 300000, [], 'job'),
      item('install-current-release-updates', update, 'Download and install all applicable Windows updates except feature upgrades without restarting', 'change', 3600000, ['capture-update-baseline'], 'job'),
      item('report-system-update', summarize, 'Report every attempted software update, reboot requirement, and available feature upgrade', 'read', 300000, ['install-current-release-updates'], 'job')
    ]
  }
}

function item (id, command, purpose, risk, timeoutMs, dependsOn = [], executionMode = null) {
  return {
    id,
    command,
    purpose,
    risk,
    timeoutMs,
    requiresSudo: true,
    dependsOn,
    ...(executionMode ? { executionMode } : {})
  }
}
