import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NetdataClient } from './netdata-client.js'
import { validateClaimDetails } from './netdata-claim.js'
import { PLUGIN_VERSION } from './plugin-version.js'
import {
  createRemoteTemporaryDirectory,
  detectPlatform,
  normalizeRemotePlatform,
  parseKeyValues,
  powershellCommand,
  removeRemoteTemporaryDirectory,
  selectPluginArtifact
} from './stage2-remote.js'

const INSTALLED_RUNNER = '/usr/local/libexec/webminai-stage2'
const WINDOWS_INSTALLED_RUNNER = 'C:/ProgramData/WebminAI/stage2.ps1'
const DEFAULT_READINESS_ATTEMPTS = 31
const DEFAULT_READINESS_INTERVAL_MS = 1000
const PLATFORM_CHECK = "printf 'system=%s\\nmachine=%s\\n' \"$(uname -s)\" \"$(uname -m)\""
// eslint-disable-next-line quotes
const DOCKER_CAPABILITY_CHECK = `containerRuntime=none; if command -v systemd-detect-virt >/dev/null 2>&1; then detectedContainer="$(systemd-detect-virt --container 2>/dev/null || true)"; if [ -n "$detectedContainer" ] && [ "$detectedContainer" != none ]; then containerRuntime="$detectedContainer"; fi; fi; if [ "$containerRuntime" = none ] && { [ -S /dev/lxd/sock ] || [ -e /dev/.lxd-mounts ]; }; then containerRuntime=lxc; fi; if [ "$containerRuntime" = none ] && [ -f /.dockerenv ]; then containerRuntime=docker; fi; if [ "$containerRuntime" = none ] && [ -f /run/.containerenv ]; then containerRuntime=podman; fi; if [ "$containerRuntime" = none ] && [ -r /run/systemd/container ]; then containerRuntime="$(sed -n '1p' /run/systemd/container)"; fi; if [ "$containerRuntime" = none ] && [ -r /proc/1/environ ]; then detectedContainer="$(tr '\\000' '\\n' < /proc/1/environ 2>/dev/null | sed -n 's/^container=//p' | sed -n '1p')"; if [ -n "$detectedContainer" ]; then containerRuntime="$detectedContainer"; fi; fi; dockerInstallSupported=no; dockerInstallMethod=; machine="$(uname -m)"; if [ "$containerRuntime" = none ] && { [ "$machine" = x86_64 ] || [ "$machine" = aarch64 ] || [ "$machine" = arm64 ] || [ "$machine" = s390x ] || [ "$machine" = ppc64le ]; } && [ -r /etc/os-release ]; then . /etc/os-release; case "$ID" in ubuntu|debian) if command -v apt-get >/dev/null 2>&1; then dockerInstallSupported=yes; dockerInstallMethod=official-apt; fi;; fedora|centos|rhel|rocky|almalinux|ol) if command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then dockerInstallSupported=yes; dockerInstallMethod=official-rpm; fi;; alpine|arch|opensuse*|sles) dockerInstallSupported=yes; dockerInstallMethod=distribution-packages;; esac; fi; printf 'containerRuntime=%s\\ndockerInstallSupported=%s\\ndockerInstallMethod=%s\\n' "$containerRuntime" "$dockerInstallSupported" "$dockerInstallMethod"; if command -v docker >/dev/null 2>&1; then printf 'dockerCli=yes\\n'; if command -v timeout >/dev/null 2>&1; then timeout 5 docker info >/dev/null 2>&1; dockerInfoStatus=$?; else docker info >/dev/null 2>&1; dockerInfoStatus=$?; fi; if [ "$dockerInfoStatus" -eq 0 ]; then printf 'dockerDaemon=yes\\n'; else printf 'dockerDaemon=no\\n'; fi; if docker compose version >/dev/null 2>&1; then printf 'dockerCompose=yes\\ndockerComposeCommand=docker compose\\n'; elif command -v docker-compose >/dev/null 2>&1; then printf 'dockerCompose=yes\\ndockerComposeCommand=docker-compose\\n'; else printf 'dockerCompose=no\\ndockerComposeCommand=\\n'; fi; else printf 'dockerCli=no\\ndockerDaemon=no\\ndockerCompose=no\\ndockerComposeCommand=\\n'; fi`
const CAPABILITY_CHECK = `${PLATFORM_CHECK}; printf 'uid=%s\\n' "$(id -u)"; if command -v sudo >/dev/null 2>&1; then printf 'sudo=yes\\n'; if sudo -n true >/dev/null 2>&1; then printf 'sudoNonInteractive=yes\\n'; else printf 'sudoNonInteractive=no\\n'; fi; else printf 'sudo=no\\nsudoNonInteractive=no\\n'; fi; if command -v doas >/dev/null 2>&1; then printf 'doas=yes\\n'; if doas -n true >/dev/null 2>&1; then printf 'doasNonInteractive=yes\\n'; else printf 'doasNonInteractive=no\\n'; fi; else printf 'doas=no\\ndoasNonInteractive=no\\n'; fi; if command -v curl >/dev/null 2>&1; then printf 'curl=yes\\n'; else printf 'curl=no\\n'; fi; if command -v netdata >/dev/null 2>&1 || [ -x /usr/sbin/netdata ] || [ -x /usr/local/sbin/netdata ] || [ -x /opt/netdata/usr/sbin/netdata ] || [ -x /opt/netdata/bin/netdata ]; then printf 'netdata=yes\\n'; else printf 'netdata=no\\n'; fi; if [ -x /usr/local/libexec/webminai-stage2 ]; then printf 'runner=yes\\n'; else printf 'runner=no\\n'; fi; ${DOCKER_CAPABILITY_CHECK}`
const WINDOWS_CAPABILITY_CHECK = powershellCommand("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$i=[Security.Principal.WindowsIdentity]::GetCurrent();$p=[Security.Principal.WindowsPrincipal]::new($i);Write-Output 'system=Windows_NT';Write-Output ('machine=' + $env:PROCESSOR_ARCHITECTURE);Write-Output 'uid=system';Write-Output ('administrator=' + $(if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){'yes'}else{'no'}));Write-Output ('curl=' + $(if(Get-Command curl.exe -ErrorAction SilentlyContinue){'yes'}else{'no'}));Write-Output ('netdata=' + $(if(Get-Service Netdata -ErrorAction SilentlyContinue){'yes'}else{'no'}));Write-Output ('runner=' + $(if(Test-Path -LiteralPath 'C:\\ProgramData\\WebminAI\\action.key'){'yes'}else{'no'}));Write-Output 'containerRuntime=none';Write-Output 'dockerInstallSupported=no';Write-Output 'dockerInstallMethod=';Write-Output 'dockerCli=no';Write-Output 'dockerDaemon=no';Write-Output 'dockerCompose=no';Write-Output 'dockerComposeCommand='")
const DIAGNOSTIC_CHECK = "printf '%s\\n' '=== system ==='; uname -a 2>&1 || true; if [ -r /etc/os-release ]; then sed -n '1,20p' /etc/os-release; fi; if [ -r /etc/version ]; then sed -n '1,5p' /etc/version; fi; printf '%s\\n' '=== netdata version ==='; (netdata -V 2>&1 || /usr/sbin/netdata -V 2>&1 || /usr/local/sbin/netdata -V 2>&1 || /opt/netdata/usr/sbin/netdata -V 2>&1 || /opt/netdata/bin/netdata -V 2>&1 || true); printf '%s\\n' '=== netdata service ==='; if command -v systemctl >/dev/null 2>&1; then systemctl status netdata --no-pager -l 2>&1 || true; else service netdata status 2>&1 || true; fi; printf '%s\\n' '=== recent netdata journal ==='; if command -v journalctl >/dev/null 2>&1; then journalctl -u netdata -n 80 --no-pager 2>&1 || true; fi; printf '%s\\n' '=== webminai artifacts ==='; ls -l /usr/local/libexec/webminai-stage2 /var/lib/webminai/action.key /var/db/webminai/action.key /usr/libexec/netdata/plugins.d/webminai.plugin /usr/lib/netdata/plugins.d/webminai.plugin /usr/local/libexec/netdata/plugins.d/webminai.plugin /opt/netdata/usr/libexec/netdata/plugins.d/webminai.plugin 2>&1 || true; printf '%s\\n' '=== mount flags ==='; if command -v findmnt >/dev/null 2>&1; then findmnt -no TARGET,OPTIONS / /usr /usr/local 2>&1 || true; else mount 2>&1 || true; fi; printf '%s\\n' '=== netdata functions API ==='; curl --silent --show-error --max-time 5 'http://127.0.0.1:19999/api/v3/functions?options=debug' 2>&1 || true"

const DEFAULT_PLUGIN_PATHS = {
  [`linux-${localArchitecture()}`]: fileURLToPath(new URL('../dist/webminai.plugin', import.meta.url)),
  'freebsd-amd64': fileURLToPath(new URL('../dist/webminai.plugin-freebsd-amd64', import.meta.url)),
  'freebsd-arm64': fileURLToPath(new URL('../dist/webminai.plugin-freebsd-arm64', import.meta.url)),
  'macos-amd64': fileURLToPath(new URL('../dist/webminai.plugin-macos-amd64', import.meta.url)),
  'macos-arm64': fileURLToPath(new URL('../dist/webminai.plugin-macos-arm64', import.meta.url)),
  'windows-amd64': fileURLToPath(new URL('../dist/webminai.plugin-windows-amd64.exe', import.meta.url))
}

export class Stage2Service {
  constructor ({
    ssh,
    debug = false,
    onDebug = (_event) => {},
    readinessAttempts = DEFAULT_READINESS_ATTEMPTS,
    readinessIntervalMs = DEFAULT_READINESS_INTERVAL_MS,
    installerPath = fileURLToPath(new URL('../remote/webminai-stage2.sh', import.meta.url)),
    windowsInstallerPath = fileURLToPath(new URL('../remote/webminai-stage2-windows.ps1', import.meta.url)),
    windowsCommandRunnerPath = fileURLToPath(new URL('../remote/webminai-command-runner-windows.ps1', import.meta.url)),
    pluginPath = null,
    pluginPaths = DEFAULT_PLUGIN_PATHS,
    pluginVersion = PLUGIN_VERSION
  }) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pluginVersion)) throw new TypeError('invalid plugin version')
    if (!Number.isInteger(readinessAttempts) || readinessAttempts < 1) {
      throw new TypeError('readinessAttempts must be a positive integer')
    }
    if (!Number.isInteger(readinessIntervalMs) || readinessIntervalMs < 0) {
      throw new TypeError('readinessIntervalMs must be a non-negative integer')
    }
    this.ssh = ssh
    this.debug = debug
    this.onDebug = onDebug
    this.readinessAttempts = readinessAttempts
    this.readinessIntervalMs = readinessIntervalMs
    this.installerPath = path.resolve(installerPath)
    this.windowsInstallerPath = path.resolve(windowsInstallerPath)
    this.windowsCommandRunnerPath = path.resolve(windowsCommandRunnerPath)
    this.pluginPath = pluginPath ? path.resolve(pluginPath) : null
    this.pluginPaths = Object.fromEntries(
      Object.entries(pluginPaths).map(([key, value]) => [key, path.resolve(value)])
    )
    this.pluginVersion = pluginVersion
  }

  async activate ({
    connectionUrl,
    actionKey,
    elevation = 'sudo-n',
    sudoPassword,
    installNetdata = true
  }) {
    const selectedPlugin = await this.selectPluginArtifact(connectionUrl)
    if (selectedPlugin.platform) {
      this.trace('platform', `Detected ${selectedPlugin.platform.system} ${selectedPlugin.platform.machine}; using ${selectedPlugin.key}`)
    }
    if (selectedPlugin.platform?.os === 'windows') {
      return this.activateWindows({
        connectionUrl,
        actionKey,
        elevation,
        installNetdata,
        selectedPlugin
      })
    }
    this.trace('create-temp', 'Creating restricted remote temporary directory')
    const temporaryDirectory = await this.createRemoteTemporaryDirectory(connectionUrl)
    this.trace('create-temp', `Created ${temporaryDirectory}`)
    const installerRemote = `${temporaryDirectory}/webminai-stage2.sh`
    const pluginRemote = `${temporaryDirectory}/webminai.plugin`

    try {
      this.trace('copy', 'Copying Stage 2 installer')
      await this.ssh.copy(connectionUrl, this.installerPath, installerRemote)
      this.trace('copy', 'Copying native Netdata plugin')
      await this.ssh.copy(connectionUrl, selectedPlugin.path, pluginRemote)
      const netdataMode = installNetdata ? 'install-if-needed' : 'require-existing'
      const elevated = elevationCommand(
        `/bin/sh '${installerRemote}' activate '${pluginRemote}' ${netdataMode} '${this.pluginVersion}'`,
        elevation,
        sudoPassword
      )
      this.trace('install', `Running installer with elevation mode: ${elevation}`)
      const installTimeoutMs = selectedPlugin.platform?.os === 'freebsd' && installNetdata
        ? 30 * 60 * 1000
        : 10 * 60 * 1000
      let result
      try {
        result = await this.ssh.execute(
          connectionUrl,
          elevated.command,
          { input: `${elevated.inputPrefix}${actionKey}\n`, timeoutMs: installTimeoutMs }
        )
      } catch (error) {
        this.trace('install-error', error.result?.stderr?.trim() || error.message)
        throw error
      }
      this.trace('install-output', [result.stdout, result.stderr].filter(Boolean).join('\n').trim())
      const activation = parseInstallerResult(result.stdout)
      return await this.verifyAndFinalizeActivation({
        connectionUrl,
        actionKey,
        activation,
        expectedPlatform: selectedPlugin.platform?.os,
        elevation,
        sudoPassword
      })
    } finally {
      await this.removeRemoteTemporaryDirectory(connectionUrl, temporaryDirectory)
    }
  }

  async activateWindows ({ connectionUrl, actionKey, elevation, installNetdata, selectedPlugin }) {
    if (elevation !== 'windows-admin') throw new Error('Windows Stage 2 activation requires an administrator SSH account')
    this.trace('create-temp', 'Creating restricted Windows temporary directory')
    const temporaryDirectory = await this.createRemoteTemporaryDirectory(connectionUrl, 'windows')
    this.trace('create-temp', `Created ${temporaryDirectory}`)
    const installerRemote = `${temporaryDirectory}/webminai-stage2-windows.ps1`
    const pluginRemote = `${temporaryDirectory}/webminai.plugin.exe`
    const commandRunnerRemote = `${temporaryDirectory}/webminai-command-runner.ps1`
    try {
      this.trace('copy', 'Copying Windows Stage 2 installer')
      await this.ssh.copy(connectionUrl, this.windowsInstallerPath, installerRemote)
      this.trace('copy', 'Copying Windows native Netdata plugin')
      await this.ssh.copy(connectionUrl, selectedPlugin.path, pluginRemote)
      this.trace('copy', 'Copying Windows command runner')
      await this.ssh.copy(connectionUrl, this.windowsCommandRunnerPath, commandRunnerRemote)
      const netdataMode = installNetdata ? 'install-if-needed' : 'require-existing'
      const command = [
        'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File',
        installerRemote,
        'Activate',
        pluginRemote,
        netdataMode,
        this.pluginVersion,
        commandRunnerRemote
      ].join(' ')
      this.trace('install', 'Running Windows installer as the administrator SSH identity')
      const result = await this.ssh.execute(connectionUrl, command, {
        input: `${actionKey}\n`,
        timeoutMs: 15 * 60 * 1000
      })
      this.trace('install-output', [result.stdout, result.stderr].filter(Boolean).join('\n').trim())
      const activation = parseInstallerResult(result.stdout)
      return await this.verifyAndFinalizeActivation({
        connectionUrl,
        actionKey,
        activation,
        expectedPlatform: 'windows',
        elevation,
        sudoPassword: undefined
      })
    } finally {
      await this.removeRemoteTemporaryDirectory(connectionUrl, temporaryDirectory)
    }
  }

  async verifyAndFinalizeActivation ({
    connectionUrl,
    actionKey,
    activation,
    expectedPlatform,
    elevation,
    sudoPassword
  }) {
    try {
      const observed = await this.waitForReadiness({
        connectionUrl,
        actionKey,
        expectedPlatform
      })
      if (observed.status !== 'active') {
        const error = new Error(`stage 2 health verification failed: ${observed.error}`)
        /** @type {any} */
        const detailedError = error
        detailedError.cause = observed.cause
        if (this.debug) {
          detailedError.diagnostics = await this.diagnostics({ connectionUrl, platform: expectedPlatform })
          this.trace('diagnostics', detailedError.diagnostics)
        }
        throw detailedError
      }
      if (observed.health.version !== this.pluginVersion) {
        throw new Error(`plugin version verification failed: expected ${this.pluginVersion}, received ${observed.health.version ?? 'unknown'}`)
      }
      if (activation.pluginAction === 'updated') {
        await this.runInstalledLifecycleCommand({ connectionUrl, command: 'commit', elevation, sudoPassword })
      }
      this.trace('probe', 'Stage 2 health verification passed')
      return { ...activation, observed }
    } catch (activationError) {
      this.trace('rollback', 'Health verification failed; rolling back activation')
      try {
        await this.rollbackActivation({
          connectionUrl,
          activation,
          elevation,
          sudoPassword
        })
      } catch (rollbackError) {
        throw new AggregateError(
          [activationError, rollbackError],
          'stage 2 activation and rollback both failed'
        )
      }
      throw activationError
    }
  }

  async rollbackActivation ({ connectionUrl, activation, elevation, sudoPassword }) {
    if (activation.pluginAction === 'updated') {
      await this.runInstalledLifecycleCommand({ connectionUrl, command: 'rollback-activation', elevation, sudoPassword })
      return
    }
    if (activation.pluginAction === 'installed' || activation.netdataAction === 'installed') {
      await this.deactivate({
        connectionUrl,
        removeManagedNetdata: activation.netdataAction === 'installed',
        elevation,
        sudoPassword
      })
      return
    }
    this.trace('rollback-preserve', 'Activation used the existing plugin and Netdata; preserving the prior Stage 2 installation')
  }

  async deactivate ({
    connectionUrl,
    removeManagedNetdata = false,
    elevation = 'sudo-n',
    sudoPassword
  }) {
    const mode = removeManagedNetdata ? 'remove-managed' : 'keep-netdata'
    if (elevation === 'windows-admin') {
      const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${WINDOWS_INSTALLED_RUNNER} Deactivate _ ${mode}`
      try {
        const result = await this.ssh.execute(connectionUrl, command, { timeoutMs: 10 * 60 * 1000 })
        return parseInstallerResult(result.stdout)
      } catch (error) {
        if (error.result?.code === 1 && /cannot find|not recognized|does not exist/i.test(error.result?.stderr ?? '')) {
          return { status: 'inactive', ownership: 'unknown', platform: 'windows' }
        }
        throw error
      }
    }
    const elevated = elevationCommand(
      `'${INSTALLED_RUNNER}' deactivate ${mode}`,
      elevation,
      sudoPassword
    )
    try {
      const result = await this.ssh.execute(
        connectionUrl,
        elevated.command,
        { input: elevated.inputPrefix || undefined, timeoutMs: 10 * 60 * 1000 }
      )
      return parseInstallerResult(result.stdout)
    } catch (error) {
      if (error.result?.code === 127) return { status: 'inactive', ownership: 'unknown' }
      throw error
    }
  }

  async claim ({
    connectionUrl,
    claimToken,
    claimUrl,
    roomIds,
    elevation = 'sudo-n',
    sudoPassword
  }) {
    const details = validateClaimDetails({ claimToken, claimUrl, roomIds })
    this.trace('claim-create-temp', 'Creating restricted remote claiming directory')
    const temporaryDirectory = await this.createRemoteTemporaryDirectory(connectionUrl)
    const installerRemote = `${temporaryDirectory}/webminai-stage2.sh`
    try {
      this.trace('claim-copy', 'Copying the fixed Netdata Cloud claiming helper')
      await this.ssh.copy(connectionUrl, this.installerPath, installerRemote)
      const elevated = elevationCommand(`/bin/sh '${installerRemote}' claim`, elevation, sudoPassword)
      this.trace('claim-configure', `Configuring Netdata Cloud URL and ${details.roomIds.split(',').length} room ID(s)`)
      const result = await this.ssh.execute(connectionUrl, elevated.command, {
        input: `${elevated.inputPrefix}${details.claimToken}\n${details.claimUrl}\n${details.roomIds}\n`,
        timeoutMs: 2 * 60 * 1000
      })
      const configured = parseInstallerResult(result.stdout)
      const cloud = await this.waitForCloudClaim(connectionUrl)
      if (!cloud.claimed) {
        throw new Error(`Netdata Cloud claiming verification failed: ${cloud.reason ?? cloud.status ?? 'unknown state'}`)
      }
      this.trace('claim-verify', `Netdata reports Cloud status ${cloud.status}`)
      return { ...configured, cloud }
    } finally {
      await this.removeRemoteTemporaryDirectory(connectionUrl, temporaryDirectory)
    }
  }

  async cloudStatus ({ connectionUrl }) {
    const info = await new NetdataClient({ ssh: this.ssh, connectionUrl, actionKey: null }).info()
    const cloud = info.agents?.[0]?.cloud
    if (!cloud || typeof cloud !== 'object') return { claimed: false, status: 'unavailable', reason: 'Cloud status is missing from Netdata info' }
    const normalizedStatus = String(cloud.status ?? 'unknown').toLowerCase()
    const claimed = (cloud.id !== null && cloud.id !== undefined && cloud.id !== 0 && cloud.id !== '0') ||
      ['online', 'connected', 'claimed'].includes(normalizedStatus)
    return {
      claimed,
      status: normalizedStatus,
      id: cloud.id ?? null,
      url: cloud.url ?? null,
      reason: cloud.reason ?? null
    }
  }

  async waitForCloudClaim (connectionUrl) {
    let cloud
    for (let attempt = 1; attempt <= this.readinessAttempts; attempt++) {
      cloud = await this.cloudStatus({ connectionUrl })
      if (cloud.claimed) return cloud
      this.trace('claim-wait', `Waiting for Netdata Cloud connection (${attempt}/${this.readinessAttempts}): ${cloud.reason ?? cloud.status}`)
      if (attempt < this.readinessAttempts) await delay(this.readinessIntervalMs)
    }
    return cloud
  }

  async runInstalledLifecycleCommand ({ connectionUrl, command, elevation = 'sudo-n', sudoPassword }) {
    if (!['commit', 'rollback-activation'].includes(command)) throw new TypeError('invalid Stage 2 lifecycle command')
    if (elevation === 'windows-admin') {
      const action = command === 'commit' ? 'Commit' : 'RollbackActivation'
      const result = await this.ssh.execute(
        connectionUrl,
        `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${WINDOWS_INSTALLED_RUNNER} ${action}`,
        { timeoutMs: 10 * 60 * 1000 }
      )
      return parseInstallerResult(result.stdout)
    }
    const elevated = elevationCommand(`'${INSTALLED_RUNNER}' ${command}`, elevation, sudoPassword)
    const result = await this.ssh.execute(connectionUrl, elevated.command, {
      input: elevated.inputPrefix || undefined,
      timeoutMs: 10 * 60 * 1000
    })
    return parseInstallerResult(result.stdout)
  }

  async capabilities ({ connectionUrl, platformHint }) {
    let result
    if (platformHint === 'windows') {
      try {
        result = await this.ssh.execute(connectionUrl, WINDOWS_CAPABILITY_CHECK)
      } catch (windowsError) {
        try {
          result = await this.ssh.execute(connectionUrl, CAPABILITY_CHECK)
        } catch {
          throw windowsError
        }
      }
    } else {
      try {
        result = await this.ssh.execute(connectionUrl, CAPABILITY_CHECK)
      } catch (posixError) {
        try {
          result = await this.ssh.execute(connectionUrl, WINDOWS_CAPABILITY_CHECK)
        } catch {
          throw posixError
        }
      }
    }
    const values = parseKeyValues(result.stdout)
    const platform = normalizeRemotePlatform(values, { rejectUnsupported: false })
    return {
      platform,
      uid: Number(values.uid),
      isRoot: values.uid === '0',
      isAdministrator: values.administrator === 'yes',
      hasSudo: values.sudo === 'yes',
      hasPasswordlessSudo: values.sudoNonInteractive === 'yes',
      hasDoas: values.doas === 'yes',
      hasPasswordlessDoas: values.doasNonInteractive === 'yes',
      hasCurl: values.curl === 'yes',
      hasNetdata: values.netdata === 'yes',
      hasStage2Runner: values.runner === 'yes',
      docker: {
        platform: platform.os,
        installSupported: values.dockerInstallSupported === 'yes',
        installMethod: values.dockerInstallMethod || null,
        cliAvailable: values.dockerCli === 'yes',
        daemonReachable: values.dockerDaemon === 'yes',
        composeAvailable: values.dockerCompose === 'yes',
        composeCommand: values.dockerComposeCommand || null,
        hostIsContainer: Boolean(values.containerRuntime && !['none', 'unknown'].includes(values.containerRuntime)),
        containerRuntime: values.containerRuntime || null
      }
    }
  }

  async probe ({ connectionUrl, actionKey, expectedPlatform }) {
    const client = new NetdataClient({ ssh: this.ssh, connectionUrl, actionKey })
    const checks = [
      ['info', client.info()],
      ['functions', client.functions()],
      ['health', client.health()]
    ]
    const settled = await Promise.allSettled(checks.map(([, request]) => request))
    const failures = settled.flatMap((result, index) => result.status === 'rejected'
      ? [{ name: checks[index][0], error: result.reason }]
      : [])
    if (failures.length > 0) {
      return {
        status: 'inactive',
        error: failures.map(failure => `${failure.name}: ${failure.error.message}`).join('; '),
        cause: new AggregateError(
          failures.map(failure => failure.error),
          'one or more Netdata Stage 2 probes failed'
        )
      }
    }
    if (!settled.every(result => result.status === 'fulfilled')) throw new Error('Netdata probe settlement invariant failed')
    const fulfilled = /** @type {PromiseFulfilledResult<any>[]} */ (settled)
    const health = fulfilled[2].value
    const observedPlatform = expectedPlatform ?? health.platform
    let privilegedExecution
    try {
      privilegedExecution = observedPlatform === 'windows'
        ? await client.windowsSystemExecutionHealth()
        : await client.rootExecutionHealth()
    } catch (error) {
      return {
        status: 'inactive',
        error: `privileged-execution: ${error.message}`,
        cause: new AggregateError([error], 'Netdata Stage 2 privileged execution probe failed')
      }
    }
    if (observedPlatform === 'windows' && health.isLocalSystem !== true) {
      const error = new Error('Intent AI Ops Windows plugin is not executing as LocalSystem')
      return {
        status: 'inactive',
        error: `health: ${error.message}`,
        cause: error
      }
    }
    if (observedPlatform !== 'windows' && health.effectiveUid !== 0) {
      const error = new Error('Intent AI Ops plugin is not executing as root; setuid may be disabled on its filesystem')
      return {
        status: 'inactive',
        error: `health: ${error.message}`,
        cause: error
      }
    }
    if (expectedPlatform && health.platform !== expectedPlatform) {
      const error = new Error(`Intent AI Ops plugin platform mismatch: expected ${expectedPlatform}, received ${health.platform ?? 'unknown'}`)
      return {
        status: 'inactive',
        error: `health: ${error.message}`,
        cause: error
      }
    }
    return {
      status: 'active',
      info: fulfilled[0].value,
      functions: fulfilled[1].value,
      health,
      rootExecution: privilegedExecution,
      executionIdentity: observedPlatform === 'windows' ? 'system' : 'root'
    }
  }

  async waitForReadiness ({ connectionUrl, actionKey, expectedPlatform }) {
    let observed
    for (let attempt = 1; attempt <= this.readinessAttempts; attempt++) {
      this.trace(
        'probe',
        'Checking Netdata info, function registry, and plugin health ' +
          `(attempt ${attempt}/${this.readinessAttempts})`
      )
      observed = await this.probe({ connectionUrl, actionKey, expectedPlatform })
      if (observed.status === 'active') return observed
      this.trace('probe-wait', observed.error)
      if (attempt < this.readinessAttempts) await delay(this.readinessIntervalMs)
    }
    return observed
  }

  async diagnostics ({ connectionUrl, platform }) {
    try {
      const command = platform === 'windows'
        ? powershellCommand("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture | Format-List;Get-CimInstance Win32_Service -Filter \"Name='Netdata'\" | Select-Object Name,State,StartName,PathName | Format-List;Get-ChildItem 'C:\\ProgramData\\WebminAI','C:\\Program Files\\Netdata' -Filter 'webminai*' -Recurse -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime | Format-Table -AutoSize;try{curl.exe --silent --show-error --max-time 5 \"http://127.0.0.1:19999/api/v3/functions?options=debug\"}catch{Write-Error $_}")
        : DIAGNOSTIC_CHECK
      const result = await this.ssh.execute(connectionUrl, command, {
        timeoutMs: 30000,
        maxOutputBytes: 512 * 1024
      })
      return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    } catch (error) {
      return [
        `Diagnostic command failed: ${error.message}`,
        error.result?.stdout,
        error.result?.stderr
      ].filter(Boolean).join('\n').trim()
    }
  }

  async createRemoteTemporaryDirectory (connectionUrl, platform = 'unix') {
    return createRemoteTemporaryDirectory({ ssh: this.ssh, connectionUrl, platform })
  }

  async detectPlatform (connectionUrl) {
    return detectPlatform({ ssh: this.ssh, connectionUrl })
  }

  async selectPluginArtifact (connectionUrl) {
    return selectPluginArtifact({
      ssh: this.ssh,
      connectionUrl,
      pluginPath: this.pluginPath,
      pluginPaths: this.pluginPaths
    })
  }

  async removeRemoteTemporaryDirectory (connectionUrl, directory) {
    return removeRemoteTemporaryDirectory({
      ssh: this.ssh,
      connectionUrl,
      directory,
      trace: this.trace.bind(this)
    })
  }

  trace (phase, message) {
    if (this.debug) this.onDebug({ phase, message })
  }
}

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function elevationCommand (command, elevation, sudoPassword) {
  if (elevation === 'root') return { command, inputPrefix: '' }
  if (elevation === 'sudo-n') return { command: `sudo -n ${command}`, inputPrefix: '' }
  if (elevation === 'doas-n') return { command: `doas -n ${command}`, inputPrefix: '' }
  if (elevation === 'sudo-password') {
    if (typeof sudoPassword !== 'string' || !sudoPassword || /[\0\r\n]/.test(sudoPassword)) {
      throw new TypeError('a single-line sudo password is required')
    }
    return {
      command: `sudo -k -S -p '' ${command}`,
      inputPrefix: `${sudoPassword}\n`
    }
  }
  throw new TypeError('unsupported elevation mode')
}

function parseInstallerResult (stdout) {
  const line = stdout.split('\n').findLast(line => line.startsWith('WEBMINAI_RESULT '))
  if (!line) throw new Error('stage 2 installer did not return a result')
  return JSON.parse(line.slice('WEBMINAI_RESULT '.length))
}

function localArchitecture () {
  if (process.arch === 'x64') return 'amd64'
  if (process.arch === 'arm64') return 'arm64'
  return process.arch
}
