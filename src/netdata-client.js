import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { parseLinuxExecutionInventory } from './linux-host-context.js'

const API_PATH = /^\/api\/v3\/[A-Za-z0-9_./?&=%:,*|~-]+$/

export class NetdataClient {
  constructor ({ ssh, connectionUrl, actionKey = null, healthAttempts = 4, healthRetryMs = 500 }) {
    if (!Number.isInteger(healthAttempts) || healthAttempts < 1 || healthAttempts > 10) {
      throw new TypeError('health attempts must be between 1 and 10')
    }
    if (!Number.isInteger(healthRetryMs) || healthRetryMs < 0 || healthRetryMs > 10000) {
      throw new TypeError('health retry delay must be between 0 and 10000 milliseconds')
    }
    this.ssh = ssh
    this.connectionUrl = connectionUrl
    this.actionKey = actionKey
    this.healthAttempts = healthAttempts
    this.healthRetryMs = healthRetryMs
  }

  async info () {
    return this.getJson('/api/v3/info?options=full')
  }

  async contexts () {
    return this.getJson('/api/v3/contexts?options=full')
  }

  async nodeInstances () {
    return this.getJson('/api/v3/node_instances')
  }

  async functions () {
    return this.getJson('/api/v3/functions?options=debug')
  }

  async alerts () {
    return this.getJson('/api/v3/alerts')
  }

  async health () {
    const path = '/api/v3/function?function=webminai%3Ahealth&timeout=10'
    let lastError
    for (let attempt = 1; attempt <= this.healthAttempts; attempt++) {
      try {
        return await this.getJson(path)
      } catch (error) {
        lastError = error
        if (attempt === this.healthAttempts || !isTransientNetdataError(error)) throw error
        await wait(this.healthRetryMs * attempt)
      }
    }
    throw lastError
  }

  async rootExecutionHealth () {
    const probe = `/etc/.webminai-root-probe-${randomUUID()}`
    const command = `set -eu; umask 077; : > '${probe}'; rm -f -- '${probe}'; if [ "$(uname -s)" = Linux ] && [ -r /proc/self/status ]; then cap_eff=$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status); case "$cap_eff" in ''|*[!0-9a-fA-F]*) printf 'invalid Linux capability state\\n' >&2; exit 1 ;; esac; if [ $((0x$cap_eff & 32)) -eq 0 ]; then printf 'CAP_KILL is missing from the Netdata plugin process\\n' >&2; exit 1; fi; fi; printf 'WEBMINAI_HOST_ROOT_OK\\n'`
    const result = await this.runCommand(command, { timeoutSeconds: 10 })
    if (result.exitCode !== 0 || result.stdout.trim() !== 'WEBMINAI_HOST_ROOT_OK') {
      throw new Error(`root command child cannot modify the host filesystem: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    }
    return { status: 'ok', identity: 'root', hostExecution: true }
  }

  async windowsSystemExecutionHealth () {
    const marker = `webminai-system-probe-${randomUUID()}`
    const command = [
      "$ErrorActionPreference='Stop'",
      `$path=Join-Path $env:ProgramData 'Intent AI Ops\\${marker}'`,
      "[IO.File]::WriteAllText($path,'ok',[Text.Encoding]::ASCII)",
      'Remove-Item -LiteralPath $path -Force',
      "Write-Output 'WEBMINAI_WINDOWS_SYSTEM_OK'"
    ].join(';')
    const result = await this.runCommand(command, { timeoutSeconds: 10 })
    if (result.exitCode !== 0 || result.stdout.trim() !== 'WEBMINAI_WINDOWS_SYSTEM_OK') {
      throw new Error(`LocalSystem command child cannot modify ProgramData: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    }
    return { status: 'ok', identity: 'system', hostExecution: true }
  }

  async windowsExecutionInventory () {
    const command = [
      '$winget=[bool](Get-Command winget.exe -ErrorAction SilentlyContinue)',
      '$chocolatey=Test-Path -LiteralPath (Join-Path $env:ProgramData \'chocolatey\\bin\\choco.exe\') -PathType Leaf',
      '$msiexec=[bool](Get-Command msiexec.exe -ErrorAction SilentlyContinue)',
      '$curl=[bool](Get-Command curl.exe -ErrorAction SilentlyContinue)',
      '$dockerPath=Join-Path $env:ProgramFiles \'Docker\\Docker\\resources\\bin\\docker.exe\';if(-not(Test-Path -LiteralPath $dockerPath -PathType Leaf)){$dockerCommand=Get-Command docker.exe -ErrorAction SilentlyContinue;$dockerPath=$(if($dockerCommand){[string]$(if($dockerCommand.Path){$dockerCommand.Path}else{$dockerCommand.Definition})}else{$null})}',
      '$dockerCli=[bool]$dockerPath;$dockerDaemon=$false;$dockerCompose=$false;$dockerServerOs=$null;$dockerServerVersion=$null;$dockerServerArchitecture=$null',
      'if($dockerPath){$out=[IO.Path]::GetTempFileName();$err=[IO.Path]::GetTempFileName();try{$process=Start-Process -FilePath $dockerPath -ArgumentList @(\'info\',\'--format\',\'{{.OSType}}|{{.ServerVersion}}|{{.Architecture}}\') -PassThru -RedirectStandardOutput $out -RedirectStandardError $err;if($process.WaitForExit(3000)){$dockerInfo=(Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue).Trim();$fields=@($dockerInfo -split \'\\|\',3);if($fields.Count -eq 3 -and $fields[0] -in @(\'linux\',\'windows\') -and -not[string]::IsNullOrWhiteSpace($fields[1]) -and -not[string]::IsNullOrWhiteSpace($fields[2])){$dockerDaemon=$true;$dockerServerOs=$fields[0];$dockerServerVersion=$fields[1];$dockerServerArchitecture=$fields[2]}};Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue;$out=[IO.Path]::GetTempFileName();$err=[IO.Path]::GetTempFileName();$compose=Start-Process -FilePath $dockerPath -ArgumentList @(\'compose\',\'version\') -PassThru -RedirectStandardOutput $out -RedirectStandardError $err;if($compose.WaitForExit(3000)){$composeOutput=(Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue).Trim();if($composeOutput -match \'^Docker Compose version \'){$dockerCompose=$true}}}finally{Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue}}',
      '$os=Get-CimInstance Win32_OperatingSystem;$computer=Get-CimInstance Win32_ComputerSystem;$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1',
      '$featureStates=[ordered]@{};foreach($name in @(\'Microsoft-Windows-Subsystem-Linux\',\'VirtualMachinePlatform\')){$featureStates[$name]=[string](Get-WindowsOptionalFeature -Online -FeatureName $name -ErrorAction SilentlyContinue).State}',
      '$firmwareVirtualization=[bool]($computer.HypervisorPresent -or $cpu.VirtualizationFirmwareEnabled);$slat=[bool]($computer.HypervisorPresent -or $cpu.SecondLevelAddressTranslationExtensions);$dockerInstallSupported=[bool]($os.ProductType -eq 1 -and [int]$os.BuildNumber -ge 22631 -and [Environment]::Is64BitOperatingSystem -and $computer.TotalPhysicalMemory -ge 8GB -and $slat -and $firmwareVirtualization)',
      '[pscustomobject]@{platform=\'windows\';identity=\'LocalSystem\';powerShellVersion=$PSVersionTable.PSVersion.ToString();is64BitProcess=[Environment]::Is64BitProcess;nativeProcessMode=\'start-process-wait\';commands=[ordered]@{winget=$winget;chocolatey=$chocolatey;msiexec=$msiexec;curl=$curl;docker=$dockerCli};bootstrap=[ordered]@{osCaption=$os.Caption;osBuild=[int]$os.BuildNumber;productType=[int]$os.ProductType;memoryBytes=[int64]$computer.TotalPhysicalMemory;consoleUser=[string]$computer.UserName;hypervisorPresent=[bool]$computer.HypervisorPresent;firmwareVirtualization=$firmwareVirtualization;slat=$slat;slatReportedByProcessor=[bool]$cpu.SecondLevelAddressTranslationExtensions;features=$featureStates;pendingReboot=[bool](Test-Path \'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending\')};docker=[ordered]@{cliAvailable=$dockerCli;daemonReachable=$dockerDaemon;composeAvailable=$dockerCompose;composeCommand=$(if($dockerCompose){\'docker compose\'}else{$null});serverOs=$dockerServerOs;serverVersion=$dockerServerVersion;serverArchitecture=$dockerServerArchitecture;installSupported=$dockerInstallSupported;installMethod=\'wsl2-docker-desktop\';virtualizationRequired=$true;virtualizationAvailable=$firmwareVirtualization;virtualizationInstructions=\'Enable AMD SVM/AMD-V or Intel VT-x in BIOS/UEFI; for a Windows VM enable nested virtualization in the outer hypervisor, fully restart Windows, and retry.\'}} | ConvertTo-Json -Depth 6 -Compress'
    ].join(';')
    const result = await this.runCommand(command, { timeoutSeconds: 10 })
    if (result.exitCode !== 0) {
      throw new Error(`could not inspect the Windows execution environment: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    }
    try {
      return JSON.parse(result.stdout)
    } catch (error) {
      throw new Error(`Windows execution inventory returned invalid JSON: ${error.message}`, { cause: error })
    }
  }

  async linuxExecutionInventory () {
    const commands = [
      'if [ -r /etc/os-release ]; then osReleaseBase64="$(base64 < /etc/os-release 2>/dev/null | tr -d \'\\n\')"; else osReleaseBase64=; fi',
      'printf \'osReleaseBase64=%s\\narchitecture=%s\\nkernel=%s\\ninit=%s\\n\' "$osReleaseBase64" "$(uname -m)" "$(uname -r)" "$(if [ -r /proc/1/comm ]; then sed -n \'1p\' /proc/1/comm; else printf unknown; fi)"',
      'for commandName in apt apt-cache dnf yum apk pacman zypper systemctl rc-service service ip hostname curl tar gzip base64 sha1sum sha256sum openssl nginx apache2 httpd php php-fpm composer mariadbd mysqld postgres psql node npm python3 pip3 ruby redis-server docker docker-compose podman getenforce aa-status; do commandKey="$(printf \'%s\' "$commandName" | tr \'-\' \'_\')"; if command -v "$commandName" >/dev/null 2>&1; then printf \'command_%s=yes\\n\' "$commandKey"; else printf \'command_%s=no\\n\' "$commandKey"; fi; done',
      'installedPackages=; if command -v dpkg-query >/dev/null 2>&1; then installedPackages="$(dpkg-query -W 2>/dev/null | awk \'{print $1}\' | grep -E \'^(nginx|apache2|mariadb|mysql|php|composer|postgresql|nodejs|npm|python3|redis|docker|podman)\' | sort -u | head -n 256)"; elif command -v rpm >/dev/null 2>&1; then installedPackages="$(rpm -qa --qf \'%{NAME}\\n\' 2>/dev/null | grep -E \'^(nginx|httpd|apache2|mariadb|mysql|php|composer|postgresql|nodejs|npm|python3|redis|docker|podman)\' | sort -u | head -n 256)"; elif command -v apk >/dev/null 2>&1; then installedPackages="$(apk info 2>/dev/null | grep -E \'^(nginx|apache2|mariadb|mysql|php|composer|postgresql|nodejs|npm|python3|py3|redis|docker|podman)\' | sort -u | head -n 256)"; elif command -v pacman >/dev/null 2>&1; then installedPackages="$(pacman -Qq 2>/dev/null | grep -E \'^(nginx|apache|mariadb|mysql|php|composer|postgresql|nodejs|npm|python|redis|docker|podman)\' | sort -u | head -n 256)"; fi; printf \'installedPackagesBase64=%s\\n\' "$(printf \'%s\\n\' "$installedPackages" | base64 | tr -d \'\\n\')"',
      'serviceUnits=; if command -v systemctl >/dev/null 2>&1; then serviceUnits="$(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk \'{print $1}\' | grep -E \'^(nginx|httpd|apache2|mariadb|mysql|php.*fpm|postgresql|redis|docker|podman).*\\.service$\' | sort -u | head -n 128)"; elif command -v rc-service >/dev/null 2>&1; then serviceUnits="$(rc-service -l 2>/dev/null | grep -E \'^(nginx|apache2|mariadb|mysql|php.*fpm|postgresql|redis|docker|podman)$\' | sort -u | head -n 128)"; fi; printf \'serviceUnitsBase64=%s\\n\' "$(printf \'%s\\n\' "$serviceUnits" | base64 | tr -d \'\\n\')"',
      'probeVersion() { versionName="$1"; shift; if command -v "$versionName" >/dev/null 2>&1; then versionKey="$(printf \'%s\' "$versionName" | tr \'-\' \'_\')"; versionValue="$("$@" 2>&1 | sed -n \'1p\' | cut -c 1-512 | base64 | tr -d \'\\n\')"; printf \'version_%s=%s\\n\' "$versionKey" "$versionValue"; fi; }; probeVersion nginx nginx -v; probeVersion apache2 apache2 -v; probeVersion httpd httpd -v; probeVersion php php -v; probeVersion php-fpm php-fpm -v; probeVersion composer composer --version; probeVersion mariadbd mariadbd --version; probeVersion mysqld mysqld --version; probeVersion postgres postgres --version; probeVersion psql psql --version; probeVersion node node --version; probeVersion npm npm --version; probeVersion python3 python3 --version; probeVersion pip3 pip3 --version; probeVersion ruby ruby --version; probeVersion redis-server redis-server --version; probeVersion docker docker --version; probeVersion podman podman --version'
    ].join('; ')
    // Package and service enumeration can legitimately exceed ten seconds on a
    // small host that is recovering from a memory-intensive application job.
    // Keep the request bounded, but do not make inventory refresh itself the
    // next failure after the durable job has yielded control.
    const result = await this.runCommand(commands, { timeoutSeconds: 30 })
    if (result.exitCode !== 0) {
      throw new Error(`could not inspect the Linux execution environment: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    }
    return parseLinuxExecutionInventory(result.stdout)
  }

  async freebsdExecutionInventory () {
    const command = [
      'freebsdVersion="$(freebsd-version -ru 2>/dev/null | tr \'\\n\' \'|\' | sed \'s/|$//\')"',
      'architecture="$(uname -m)"',
      'jailed="$(sysctl -n security.jail.jailed 2>/dev/null || printf 0)"',
      'podmanCli=no; podmanReady=no; composeAvailable=no; composeCommand=',
      'if command -v podman >/dev/null 2>&1; then podmanCli=yes; if podman info >/dev/null 2>&1; then podmanReady=yes; fi; fi',
      'if command -v podman-compose >/dev/null 2>&1 && podman-compose version >/dev/null 2>&1; then composeAvailable=yes; composeCommand=podman-compose; fi',
      'major="$(freebsd-version -u 2>/dev/null | sed -E \'s/^([0-9]+).*/\\1/\')"; installSupported=no; case "$major" in \'\'|*[!0-9]*) ;; *) if [ "$major" -ge 15 ] && command -v pkg >/dev/null 2>&1; then installSupported=yes; fi ;; esac',
      'printf \'freebsdVersion=%s\\narchitecture=%s\\njailed=%s\\npodmanCli=%s\\npodmanReady=%s\\ncomposeAvailable=%s\\ncomposeCommand=%s\\ninstallSupported=%s\\n\' "$freebsdVersion" "$architecture" "$jailed" "$podmanCli" "$podmanReady" "$composeAvailable" "$composeCommand" "$installSupported"'
    ].join('; ')
    const result = await this.runCommand(command, { timeoutSeconds: 15 })
    if (result.exitCode !== 0) {
      throw new Error(`could not inspect the FreeBSD execution environment: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    }
    const values = Object.fromEntries(result.stdout.trim().split(/\r?\n/u).map(line => {
      const separator = line.indexOf('=')
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
    }))
    const jailed = values.jailed === '1'
    return {
      platform: 'freebsd',
      freebsdVersion: values.freebsdVersion || null,
      architecture: values.architecture || null,
      packageManager: 'pkg',
      serviceManager: 'rc.d',
      shell: '/bin/sh',
      docker: {
        platform: 'freebsd',
        runtime: 'podman',
        installSupported: values.installSupported === 'yes' && !jailed,
        installMethod: 'freebsd-podman-linux',
        cliAvailable: values.podmanCli === 'yes',
        daemonReachable: values.podmanReady === 'yes',
        composeAvailable: values.composeAvailable === 'yes',
        composeCommand: values.composeCommand || null,
        hostIsContainer: jailed,
        containerRuntime: jailed ? 'freebsd-jail' : null,
        requiresExplicitLinuxPlatform: true,
        virtualizationRequired: false,
        virtualizationAvailable: true,
        virtualizationInstructions: 'FreeBSD Podman uses jails and VFS; CPU virtualization is not required. Install it on the outer FreeBSD 15+ host, not inside a jail.'
      }
    }
  }

  async macosExecutionInventory () {
    const command = [
      'macosVersion="$(sw_vers -productVersion 2>/dev/null || true)"',
      'architecture="$(uname -m)"',
      'memoryBytes="$(sysctl -n hw.memsize 2>/dev/null || printf 0)"',
      'cpuCount="$(sysctl -n hw.ncpu 2>/dev/null || printf 0)"',
      'hypervisorSupport="$(sysctl -n kern.hv_support 2>/dev/null || printf 0)"',
      'brewPath=; for candidate in /usr/local/bin/brew /opt/homebrew/bin/brew; do if [ -x "$candidate" ]; then brewPath="$candidate"; break; fi; done',
      'brewPrefix=; brewRepository=; runtimeUser=; runtimeHome=; if [ -n "$brewPath" ]; then brewPrefix="$("$brewPath" --prefix 2>/dev/null || true)"; brewRepository="$("$brewPath" --repository 2>/dev/null || true)"; if [ -n "$brewRepository" ]; then runtimeUser="$(stat -f %Su "$brewRepository" 2>/dev/null || true)"; fi; fi',
      'case "$runtimeUser" in ""|root) runtimeUser=;; *) runtimeHome="$(dscl . -read "/Users/$runtimeUser" NFSHomeDirectory 2>/dev/null | sed -n "s/^NFSHomeDirectory: //p")";; esac',
      'dockerPath=; if [ -n "$brewPrefix" ]; then candidate="$brewPrefix/bin/docker"; if [ -x "$candidate" ]; then dockerPath="$candidate"; fi; fi; if [ -z "$dockerPath" ]; then for candidate in /usr/local/bin/docker /opt/homebrew/bin/docker /Applications/Docker.app/Contents/Resources/bin/docker; do if [ -x "$candidate" ]; then dockerPath="$candidate"; break; fi; done; fi',
      'colimaPath=; if [ -n "$brewPrefix" ]; then candidate="$brewPrefix/bin/colima"; if [ -x "$candidate" ]; then colimaPath="$candidate"; fi; fi; if [ -z "$colimaPath" ]; then for candidate in /usr/local/bin/colima /opt/homebrew/bin/colima; do if [ -x "$candidate" ]; then colimaPath="$candidate"; break; fi; done; fi',
      'dockerCli=no; dockerDaemon=no; composeAvailable=no; composeCommand=; dockerSocket=',
      'if [ -n "$dockerPath" ]; then dockerCli=yes; if [ -n "$runtimeHome" ] && [ -S "$runtimeHome/.colima/default/docker.sock" ]; then dockerSocket="$runtimeHome/.colima/default/docker.sock"; fi; if [ -n "$dockerSocket" ] && DOCKER_HOST="unix://$dockerSocket" "$dockerPath" info >/dev/null 2>&1; then dockerDaemon=yes; if DOCKER_HOST="unix://$dockerSocket" "$dockerPath" compose version >/dev/null 2>&1; then composeAvailable=yes; composeCommand="docker compose"; fi; fi; fi',
      'installSupported=no; if [ -n "$brewPath" ] && [ -n "$runtimeUser" ] && [ -n "$runtimeHome" ] && [ "$hypervisorSupport" = 1 ]; then case "$architecture" in x86_64|arm64) installSupported=yes;; esac; fi',
      'printf \'macosVersion=%s\\narchitecture=%s\\nmemoryBytes=%s\\ncpuCount=%s\\nhypervisorSupport=%s\\nbrewPath=%s\\nbrewPrefix=%s\\nbrewRepository=%s\\nruntimeUser=%s\\nruntimeHome=%s\\ncolimaPath=%s\\ndockerPath=%s\\ndockerSocket=%s\\ndockerCli=%s\\ndockerDaemon=%s\\ncomposeAvailable=%s\\ncomposeCommand=%s\\ninstallSupported=%s\\n\' "$macosVersion" "$architecture" "$memoryBytes" "$cpuCount" "$hypervisorSupport" "$brewPath" "$brewPrefix" "$brewRepository" "$runtimeUser" "$runtimeHome" "$colimaPath" "$dockerPath" "$dockerSocket" "$dockerCli" "$dockerDaemon" "$composeAvailable" "$composeCommand" "$installSupported"'
    ].join('; ')
    const result = await this.runCommand(command, { timeoutSeconds: 15 })
    if (result.exitCode !== 0) {
      throw new Error(`could not inspect the macOS execution environment: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    }
    const values = Object.fromEntries(result.stdout.trim().split(/\r?\n/u).map(line => {
      const separator = line.indexOf('=')
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
    }))
    return {
      platform: 'macos',
      macosVersion: values.macosVersion || null,
      architecture: values.architecture || null,
      memoryBytes: Number(values.memoryBytes) || 0,
      cpuCount: Number(values.cpuCount) || 0,
      hypervisorSupport: values.hypervisorSupport === '1',
      packageManager: values.brewPath ? 'homebrew' : null,
      brewPath: values.brewPath || null,
      brewPrefix: values.brewPrefix || null,
      brewRepository: values.brewRepository || null,
      runtimeUser: values.runtimeUser || null,
      runtimeHome: values.runtimeHome || null,
      docker: {
        platform: 'macos',
        runtime: 'colima',
        installSupported: values.installSupported === 'yes',
        installMethod: 'homebrew-colima',
        cliAvailable: values.dockerCli === 'yes',
        daemonReachable: values.dockerDaemon === 'yes',
        composeAvailable: values.composeAvailable === 'yes',
        composeCommand: values.composeCommand || null,
        dockerPath: values.dockerPath || null,
        colimaPath: values.colimaPath || null,
        socketPath: values.dockerSocket || null,
        runtimeUser: values.runtimeUser || null,
        runtimeHome: values.runtimeHome || null,
        hypervisorSupport: values.hypervisorSupport === '1',
        virtualizationRequired: true,
        virtualizationAvailable: values.hypervisorSupport === '1',
        virtualizationInstructions: 'If kern.hv_support is not 1, expose Apple Hypervisor support; for a macOS VM enable nested VMX/virtualization in its outer QEMU/KVM configuration and restart it.',
        hostIsContainer: false,
        containerRuntime: null
      }
    }
  }

  async dockerExecutionInventory () {
    const command = [
      'containerRuntime=none',
      'if command -v systemd-detect-virt >/dev/null 2>&1; then detectedContainer="$(systemd-detect-virt --container 2>/dev/null || true)"; if [ -n "$detectedContainer" ] && [ "$detectedContainer" != none ]; then containerRuntime="$detectedContainer"; fi; fi',
      'if [ "$containerRuntime" = none ] && { [ -S /dev/lxd/sock ] || [ -e /dev/.lxd-mounts ]; }; then containerRuntime=lxc; fi',
      'if [ "$containerRuntime" = none ] && [ -f /.dockerenv ]; then containerRuntime=docker; fi',
      'if [ "$containerRuntime" = none ] && [ -f /run/.containerenv ]; then containerRuntime=podman; fi',
      'if [ "$containerRuntime" = none ] && [ -r /run/systemd/container ]; then containerRuntime="$(sed -n \'1p\' /run/systemd/container)"; fi',
      'if [ "$containerRuntime" = none ] && [ -r /proc/1/environ ]; then detectedContainer="$(tr \'\\000\' \'\\n\' < /proc/1/environ 2>/dev/null | sed -n \'s/^container=//p\' | sed -n \'1p\')"; if [ -n "$detectedContainer" ]; then containerRuntime="$detectedContainer"; fi; fi',
      'dockerInstallSupported=no; dockerInstallMethod=; machine="$(uname -m)"; if [ "$containerRuntime" = none ] && { [ "$machine" = x86_64 ] || [ "$machine" = aarch64 ] || [ "$machine" = arm64 ] || [ "$machine" = s390x ] || [ "$machine" = ppc64le ]; } && [ -r /etc/os-release ]; then . /etc/os-release; case "$ID" in ubuntu|debian) if command -v apt-get >/dev/null 2>&1; then dockerInstallSupported=yes; dockerInstallMethod=official-apt; fi;; fedora|centos|rhel|rocky|almalinux|ol) if command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then dockerInstallSupported=yes; dockerInstallMethod=official-rpm; fi;; alpine|arch|opensuse*|sles) dockerInstallSupported=yes; dockerInstallMethod=distribution-packages;; esac; fi',
      'dockerCli=no; dockerDaemon=no; dockerCompose=no; dockerComposeCommand=',
      'if command -v docker >/dev/null 2>&1; then dockerCli=yes; if command -v timeout >/dev/null 2>&1; then timeout 5 docker info >/dev/null 2>&1; dockerInfoStatus=$?; else docker info >/dev/null 2>&1; dockerInfoStatus=$?; fi; if [ "$dockerInfoStatus" -eq 0 ]; then dockerDaemon=yes; fi; if docker compose version >/dev/null 2>&1; then dockerCompose=yes; dockerComposeCommand="docker compose"; elif command -v docker-compose >/dev/null 2>&1; then dockerCompose=yes; dockerComposeCommand=docker-compose; fi; fi',
      'printf \'containerRuntime=%s\\ndockerInstallSupported=%s\\ndockerInstallMethod=%s\\ndockerCli=%s\\ndockerDaemon=%s\\ndockerCompose=%s\\ndockerComposeCommand=%s\\n\' "$containerRuntime" "$dockerInstallSupported" "$dockerInstallMethod" "$dockerCli" "$dockerDaemon" "$dockerCompose" "$dockerComposeCommand"'
    ].join('; ')
    const result = await this.runCommand(command, { timeoutSeconds: 10 })
    if (result.exitCode !== 0) {
      throw new Error(`could not inspect Docker availability: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    }
    const values = Object.fromEntries(result.stdout.trim().split(/\r?\n/u).map(line => {
      const separator = line.indexOf('=')
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
    }))
    return {
      platform: 'linux',
      installSupported: values.dockerInstallSupported === 'yes',
      installMethod: values.dockerInstallMethod || null,
      cliAvailable: values.dockerCli === 'yes',
      daemonReachable: values.dockerDaemon === 'yes',
      composeAvailable: values.dockerCompose === 'yes',
      composeCommand: values.dockerComposeCommand || null,
      hostIsContainer: Boolean(values.containerRuntime && !['none', 'unknown'].includes(values.containerRuntime)),
      containerRuntime: values.containerRuntime || null,
      virtualizationRequired: false,
      virtualizationAvailable: true,
      virtualizationInstructions: 'Docker Engine uses Linux namespaces and cgroups; VT-x, AMD-V, and nested virtualization are not required. Nested Docker inside a container instead requires explicit outer-host privileges.'
    }
  }

  async runCommand (command, { timeoutSeconds = 30 } = {}) {
    if (typeof command !== 'string' || command.length === 0 || command.length > 32768) {
      throw new TypeError('command must be a non-empty string no longer than 32768 characters')
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
      throw new TypeError('timeout must be between 1 and 300 seconds')
    }

    const body = createSignedCommand(command, this.actionKey)
    const result = await this.postJson(
      `/api/v3/function?function=webminai%3Acommand&timeout=${timeoutSeconds}`,
      body,
      (timeoutSeconds + 5) * 1000
    )
    return decodeCommandOutput(result)
  }

  async startJob (command, { timeoutSeconds = 3600 } = {}) {
    validateCommand(command)
    validateJobTimeout(timeoutSeconds)
    const request = [
      `timeoutSeconds=${timeoutSeconds}`,
      `command=${Buffer.from(command, 'utf8').toString('base64url')}`
    ].join('\n')
    const result = await this.signedJobRequest('job_start', request)
    if (result?.status !== 'accepted' || result?.state !== 'running') {
      throw new Error('Netdata job start returned an invalid response')
    }
    validateJobId(result.jobId)
    return result
  }

  async jobStatus (jobId) {
    validateJobId(jobId)
    const result = decodeCommandOutput(await this.signedJobRequest('job_status', jobId))
    if (!JOB_STATES.has(result?.state) || result.jobId !== jobId) {
      throw new Error('Netdata job status returned an invalid response')
    }
    return result
  }

  async cancelJob (jobId) {
    validateJobId(jobId)
    return this.signedJobRequest('job_cancel', jobId)
  }

  async cleanupJob (jobId) {
    validateJobId(jobId)
    return this.signedJobRequest('job_cleanup', jobId)
  }

  /**
   * @param {string} command
   * @param {{timeoutSeconds?: number, pollIntervalMs?: number, statusErrorAttempts?: number, signal?: AbortSignal, onStatus?: (status: any) => any}} [options]
   */
  async runJob (command, {
    timeoutSeconds = 3600,
    pollIntervalMs = 1000,
    statusErrorAttempts = 120,
    signal,
    onStatus = (_status) => {}
  } = {}) {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 10000) {
      throw new TypeError('job poll interval must be between 100 and 10000 milliseconds')
    }
    if (signal !== undefined && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
      throw new TypeError('job signal must be an AbortSignal')
    }
    if (!Number.isInteger(statusErrorAttempts) || statusErrorAttempts < 0 || statusErrorAttempts > 120) {
      throw new TypeError('job status error attempts must be between 0 and 120')
    }
    if (typeof onStatus !== 'function') throw new TypeError('job status callback must be a function')

    const started = await this.startJob(command, { timeoutSeconds })
    const jobId = started.jobId
    let cancellationRequested = false
    let consecutiveStatusErrors = 0
    while (true) {
      if (signal?.aborted && !cancellationRequested) {
        await this.cancelJob(jobId)
        cancellationRequested = true
      }
      let status
      try {
        status = await this.jobStatus(jobId)
        consecutiveStatusErrors = 0
      } catch (error) {
        consecutiveStatusErrors++
        if (consecutiveStatusErrors > statusErrorAttempts || !isRecoverableJobStatusError(error)) throw error
        await onStatus({ jobId, state: 'temporarily_unavailable', attempt: consecutiveStatusErrors })
        await wait(pollIntervalMs)
        continue
      }
      await onStatus(status)
      if (TERMINAL_JOB_STATES.has(status.state)) {
        try {
          await this.cleanupJob(jobId)
          return { ...status, cleaned: true }
        } catch (error) {
          return { ...status, cleaned: false, cleanupError: String(error?.message ?? error) }
        }
      }
      await wait(pollIntervalMs)
    }
  }

  async signedJobRequest (functionName, request) {
    const body = createSignedCommand(request, this.actionKey)
    return this.postJson(
      `/api/v3/function?function=webminai%3A${functionName}&timeout=10`,
      body,
      15000
    )
  }

  async inventory () {
    const [info, contextsResult, nodeInstancesResult, functionsResult, alertsResult] = await Promise.all([
      this.info(),
      optionalInventoryEndpoint(() => this.contexts()),
      optionalInventoryEndpoint(() => this.nodeInstances()),
      optionalInventoryEndpoint(() => this.functions()),
      optionalInventoryEndpoint(() => this.alerts())
    ])

    const endpointErrors = Object.fromEntries([
      ['contexts', contextsResult.error],
      ['nodeInstances', nodeInstancesResult.error],
      ['functions', functionsResult.error],
      ['alerts', alertsResult.error]
    ].filter(([, error]) => error))

    return {
      source: {
        name: 'Netdata Agent',
        apiVersion: 3,
        loopbackBaseUrl: 'http://127.0.0.1:19999',
        preferredFor: ['monitoring', 'statistics', 'system-discovery', 'alerts', 'services', 'processes', 'containers'],
        endpoints: {
          info: '/api/v3/info',
          contexts: '/api/v3/contexts',
          data: '/api/v3/data',
          alerts: '/api/v3/alerts',
          functions: '/api/v3/functions',
          function: '/api/v3/function'
        },
        ...(Object.keys(endpointErrors).length > 0 ? { endpointErrors } : {})
      },
      info,
      contexts: contextsResult.value,
      nodeInstances: nodeInstancesResult.value,
      functions: functionsResult.value,
      alerts: alertsResult.value
    }
  }

  async getJson (path) {
    validateApiPath(path)
    const command = curlCommand('GET', path)
    try {
      const result = await this.ssh.execute(this.connectionUrl, command)
      return parseJsonResponse(result.stdout)
    } catch (error) {
      throw netdataRequestError('GET', path, error)
    }
  }

  async postJson (path, body, timeoutMs = 35000) {
    validateApiPath(path)
    const command = curlCommand('POST', path)
    try {
      const result = await this.ssh.execute(this.connectionUrl, command, {
        input: `${JSON.stringify(body)}\n`,
        timeoutMs
      })
      return parseJsonResponse(result.stdout)
    } catch (error) {
      throw netdataRequestError('POST', path, error)
    }
  }
}

export function createSignedCommand (command, actionKey, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/i.test(actionKey)) {
    throw new TypeError('action key must be a 32-byte hexadecimal key')
  }

  const payload = [
    'v=1',
    `issuedAt=${Math.floor(now / 1000)}`,
    `requestId=${randomUUID()}`,
    `nonce=${randomBytes(18).toString('base64url')}`,
    `command=${Buffer.from(command, 'utf8').toString('base64url')}`
  ].join('\n')

  return {
    payload: Buffer.from(payload, 'utf8').toString('base64url'),
    mac: createHmac('sha256', Buffer.from(actionKey, 'hex'))
      .update(payload, 'utf8')
      .digest('hex')
  }
}

export function createKubernetesApiCommand ({ method, path, body, contentType = 'application/json' }) {
  const normalizedMethod = String(method ?? '').toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) {
    throw new TypeError('Kubernetes API method must be GET, POST, PUT, PATCH, or DELETE')
  }
  if (typeof path !== 'string' || path.length > 4096 ||
      (!path.startsWith('/api/') && !path.startsWith('/apis/') && path !== '/version') ||
      path.includes('..') || !/^\/[A-Za-z0-9_./?&=%:,*|~-]+$/.test(path)) {
    throw new TypeError('invalid Kubernetes API path')
  }
  if (!['application/json', 'application/merge-patch+json', 'application/apply-patch+yaml'].includes(contentType)) {
    throw new TypeError('unsupported Kubernetes API content type')
  }
  let serializedBody = ''
  if (body !== undefined && body !== null) {
    serializedBody = typeof body === 'string' ? body : JSON.stringify(body)
  }
  if (['POST', 'PUT', 'PATCH'].includes(normalizedMethod) && serializedBody.length === 0) {
    throw new TypeError(`${normalizedMethod} Kubernetes API requests require a body`)
  }
  if (Buffer.byteLength(serializedBody) > 24 * 1024) {
    throw new TypeError('Kubernetes API request body is too large')
  }
  return [
    'v=1',
    `method=${normalizedMethod}`,
    `path=${Buffer.from(path, 'utf8').toString('base64url')}`,
    `contentType=${contentType}`,
    `body=${Buffer.from(serializedBody, 'utf8').toString('base64url')}`
  ].join('\n')
}

function curlCommand (method, path) {
  const request = method === 'POST'
    ? '--request POST --header "Content-Type: application/json" --data-binary @-'
    : '--request GET'

  return `curl --fail-with-body --silent --show-error --max-time 300 ${request} "http://127.0.0.1:19999${path}"`
}

function validateApiPath (path) {
  if (!API_PATH.test(path)) throw new TypeError('invalid Netdata API path')
}

function parseJsonResponse (text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Netdata returned invalid JSON: ${error.message}`, { cause: error })
  }
}

async function optionalInventoryEndpoint (load) {
  try {
    return { value: await load(), error: null }
  } catch (error) {
    return {
      value: null,
      error: String(error?.message ?? error).replaceAll(/[\r\n]+/gu, ' ').slice(0, 1000)
    }
  }
}

function decodeCommandOutput (result) {
  if (result?.outputEncoding !== 'base64') return result
  return {
    ...result,
    stdout: Buffer.from(result.stdout, 'base64').toString('utf8'),
    stderr: Buffer.from(result.stderr, 'base64').toString('utf8')
  }
}

const JOB_STATES = new Set(['running', 'cancelling', 'succeeded', 'failed', 'timed_out', 'cancelled', 'completed', 'cleaned'])
const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled'])

function validateCommand (command) {
  if (typeof command !== 'string' || command.length === 0 || Buffer.byteLength(command, 'utf8') > 32768) {
    throw new TypeError('command must be a non-empty string no longer than 32768 bytes')
  }
}

function validateJobTimeout (timeoutSeconds) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
    throw new TypeError('job timeout must be between 1 and 86400 seconds')
  }
}

function validateJobId (jobId) {
  if (typeof jobId !== 'string' || !/^[a-f0-9]{32}$/u.test(jobId)) {
    throw new TypeError('invalid Netdata job ID')
  }
}

function netdataRequestError (method, path, cause) {
  return new Error(`Netdata ${method} ${path} failed: ${cause.message}`, { cause })
}

function isTransientNetdataError (error) {
  const evidence = [
    error?.message,
    error?.cause?.message,
    error?.cause?.result?.stdout,
    error?.cause?.result?.stderr
  ].filter(Boolean).join('\n')
  return /(?:HTTP\/?\d(?:\.\d)?\s+|"status"\s*:\s*|status(?:=|\s))?(?:429|502|503|504)\b|connection refused|connection reset|empty reply/iu.test(evidence)
}

function isRecoverableJobStatusError (error) {
  const evidence = [
    error?.message,
    error?.cause?.message,
    error?.cause?.result?.stdout,
    error?.cause?.result?.stderr
  ].filter(Boolean).join('\n')
  return isTransientNetdataError(error) || /\b404\b.*(?:job not found|feature is not available)|connection refused|connection reset|connection closed|empty reply|exit code null|timed?\s*out|\bETIMEDOUT\b|broken pipe|\bEPIPE\b/iu.test(evidence)
}

function wait (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
