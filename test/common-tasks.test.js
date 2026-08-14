import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildCandidatePlanningContext, buildCommonTask, commonTaskEligibility, listCommonTasks, listEligibleCommonTasks } from '../src/common-tasks.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { LinuxHostContextService } from '../src/linux-host-context.js'
import { validateCommandPlan } from '../src/plan-validator.js'
import { hostHealthProfile, isHostHealthTask } from '../src/host-health-task.js'
import { isSystemUpdateTask, systemUpdateProfile } from '../src/system-update-task.js'

test('common task catalog contains ten syntactically valid reversible plans', () => {
  const available = listCommonTasks({ category: 'system' })
  assert.equal(available.length, 10)
  assert.equal(new Set(available.map(task => task.id)).size, 10)

  available.forEach((task, index) => {
    const built = buildCommonTask(task.id, index + 1)
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.ok(built.plan.revertCommands.length > 0)
    assert.ok(built.plan.modifiedFiles.length > 0)
    for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
      const syntax = spawnSync('/bin/bash', ['-n', '-c', command.command], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, `${task.id}/${command.id}: ${syntax.stderr}`)
    }
    for (const verification of [built.verifyApplied, built.verifyReverted, built.stateProbe]) {
      const syntax = spawnSync('/bin/bash', ['-n', '-c', verification], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, `${task.id} verification: ${syntax.stderr}`)
    }
  })
})

test('generic Linux tasks are repeat-apply safe and hide unsupported container or init routes', () => {
  for (const catalogId of ['install-htop', 'install-jq', 'system-user', 'systemd-service', 'systemd-timer', 'cron-job', 'logrotate-rule', 'tmpfiles-rule']) {
    const built = buildCommonTask(catalogId, 110)
    assert.match(built.plan.commands[0].command, /apply-complete|prepare-complete/u, catalogId)
  }

  const alpineContainer = {
    platform: 'linux',
    linuxContext: { management: { serviceManager: 'openrc' } },
    docker: { hostIsContainer: true }
  }
  assert.equal(commonTaskEligibility('systemd-service', alpineContainer).eligible, false)
  assert.equal(commonTaskEligibility('systemd-timer', alpineContainer).eligible, false)
  assert.equal(commonTaskEligibility('tmpfiles-rule', alpineContainer).eligible, false)
  assert.equal(commonTaskEligibility('swap-file', alpineContainer).eligible, false)
  assert.equal(commonTaskEligibility('system-user', alpineContainer).eligible, true)

  const physicalSystemd = {
    platform: 'linux',
    linuxContext: { management: { serviceManager: 'systemd' } },
    docker: { hostIsContainer: false }
  }
  assert.equal(commonTaskEligibility('systemd-service', physicalSystemd).eligible, true)
  assert.equal(commonTaskEligibility('swap-file', physicalSystemd).eligible, true)

  const oracleHtop = buildCommonTask('install-htop', 111, {
    linuxContext: { identity: { id: 'ol' } }
  })
  assert.match(oracleHtop.plan.commands[0].command, /oracle-epel-release-el9/u)
  assert.match(oracleHtop.plan.revertCommands[0].command, /oracle-epel-was-present/u)

  const alpineCron = buildCommonTask('cron-job', 112, {
    linuxContext: { management: { packageManager: 'apk' } }
  })
  assert.match(alpineCron.plan.commands[0].command, /\/etc\/crontabs\/root/u)
  assert.match(alpineCron.plan.commands[0].command, /dcron/u)
  assert.match(alpineCron.plan.revertCommands[0].command, /root-crontab-before/u)
})

test('common task catalog rejects unsupported target platforms before execution', () => {
  assert.throws(
    () => buildCommonTask('install-htop', 1, { platform: 'freebsd' }),
    /use an AI-assisted task/
  )
})

test('diagnostic catalog exposes one read-only Netdata-first health report per supported platform', () => {
  const platforms = ['freebsd', 'linux', 'macos', 'windows']
  assert.deepEqual(listCommonTasks({ category: 'diagnostic' }).map(task => task.platform).sort(), platforms)
  for (const [index, platform] of platforms.entries()) {
    const catalogId = `host-health-${platform}`
    const built = buildCommonTask(catalogId, index + 1, { platform })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.equal(built.plan.commands.length, 3)
    assert.ok(built.plan.commands.every(item => item.risk === 'read'))
    assert.ok(built.plan.commands.every(item => item.requiresSudo === false))
    assert.deepEqual(built.plan.revertCommands, [])
    assert.equal(isHostHealthTask(catalogId), true)
    assert.equal(hostHealthProfile(platform).platform, platform)
    assert.ok(hostHealthProfile(platform).logSources.length > 1)
    if (platform !== 'windows') {
      for (const item of built.plan.commands) {
        const syntax = spawnSync('/bin/sh', ['-n', '-c', item.command], { encoding: 'utf8' })
        assert.equal(syntax.status, 0, `${catalogId}/${item.id}: ${syntax.stderr}`)
      }
    }
  }
  const alpine = hostHealthProfile('linux', {
    webminaiLinuxContext: { identity: { id: 'alpine' }, management: { packageManager: 'apk', serviceManager: 'openrc' } }
  })
  assert.equal(alpine.distro, 'alpine')
  assert.equal(alpine.packageManager, 'apk')
  assert.match(alpine.logSources.join(' '), /OpenRC/u)
  assert.match(alpine.updateTools.join(' '), /apk/u)
})

test('maintenance catalog installs current-release updates without reboot or release-upgrade commands', () => {
  const platforms = ['freebsd', 'linux', 'windows']
  assert.deepEqual(listCommonTasks({ category: 'maintenance' }).map(task => task.platform).sort(), platforms)
  for (const [index, platform] of platforms.entries()) {
    const catalogId = `system-update-${platform}`
    const built = buildCommonTask(catalogId, index + 201, { platform })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({}), { requireRevert: false }), built.plan)
    assert.equal(isSystemUpdateTask(catalogId), true)
    assert.equal(systemUpdateProfile(platform).platform, platform)
    assert.equal(built.plan.commands.length, 3)
    assert.deepEqual(built.plan.revertCommands, [])
    assert.match(built.plan.warnings.join(' '), /not given an automatic rollback/u)
    assert.match(built.plan.commands.map(item => item.command).join('\n'), /reboot.?performed/iu)
    assert.doesNotMatch(built.plan.commands.map(item => item.command).join('\n'), /(?:^|[;&|]\s*)(?:\/sbin\/)?(?:reboot|shutdown)(?:\s|$)|Restart-Computer|do-release-upgrade\s+(?:-d|--frontend)|freebsd-update\s+(?:-[^;\n]*\s+)?upgrade|dnf\s+system-upgrade/u)
    if (platform !== 'windows') {
      for (const item of built.plan.commands) {
        const syntax = spawnSync('/bin/sh', ['-n', '-c', item.command], { encoding: 'utf8' })
        assert.equal(syntax.status, 0, `${catalogId}/${item.id}: ${syntax.stderr}`)
      }
    }
  }
  const linux = buildCommonTask('system-update-linux', 220, { platform: 'linux' }).plan.commands
  assert.match(linux.find(item => item.id === 'install-current-release-updates').command, /apt-get -y .* dist-upgrade/u)
  assert.match(linux.find(item => item.id === 'install-current-release-updates').command, /zypper --non-interactive update/u)
  const freebsd = buildCommonTask('system-update-freebsd', 222, { platform: 'freebsd' }).plan.commands
  assert.match(freebsd.find(item => item.id === 'report-system-update').command, /installed-userland-before/u)
  assert.match(freebsd.find(item => item.id === 'report-system-update').command, /full-base-update-log/u)
  const windows = buildCommonTask('system-update-windows', 221, { platform: 'windows' }).plan.commands
  assert.match(windows.find(item => item.id === 'install-current-release-updates').command, /Test-FeatureUpgrade/u)
  assert.match(windows.find(item => item.id === 'install-current-release-updates').command, /3689bdc8-b205-4af4-8d4a-a63924c5e9d5/u)
  assert.match(windows.find(item => item.id === 'report-system-update').command, /AvailableFeatureUpgrades/u)
})

test('common task catalog exposes every promoted Linux application candidate', () => {
  assert.deepEqual(
    listCommonTasks({ category: 'application', platform: 'linux' }).map(task => task.id),
    [
      'docker-linux',
      'wordpress-linux',
      'woocommerce-linux',
      'joomla-linux',
      'drupal-linux',
      'prestashop-linux',
      'moodle-linux',
      'magento-linux',
      'n8n-linux',
      'ghost-linux',
      'mattermost-linux',
      'odoo-linux',
      'jellyfin-linux',
      'home-assistant-linux',
      'intent-ai-ops-linux'
    ]
  )
})

test('Intent AI Ops installer is the last application task on every host platform', () => {
  for (const platform of ['linux', 'freebsd', 'macos', 'windows']) {
    const catalog = listCommonTasks({ category: 'application', platform })
    assert.equal(catalog.at(-1).id, `intent-ai-ops-${platform}`)
    const built = buildCommonTask(`intent-ai-ops-${platform}`, 88, { platform })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.match(built.plan.commands.find(command => command.id === 'install-intent-ai-ops').command, /raw\.githubusercontent\.com/u)
    assert.equal(built.plan.revertCommands.length, 1)
    if (platform !== 'windows') {
      for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
        const syntax = spawnSync('/bin/sh', ['-n', '-c', command.command], { encoding: 'utf8' })
        assert.equal(syntax.status, 0, `${platform}/${command.id}: ${syntax.stderr}`)
      }
    }
  }
})

test('Intent AI Ops macOS and Windows tasks install directly on the host', () => {
  const macos = buildCommonTask('intent-ai-ops-macos', 89, {
    platform: 'macos',
    docker: { ready: false },
    intentAiOpsInstallSource: {
      installerPath: '/tmp/intent ai ops/install.sh',
      packageUrl: '/tmp/intent ai ops/intent-ai-ops.tgz'
    }
  })
  const macosCommand = macos.plan.commands.find(command => command.id === 'install-intent-ai-ops').command
  assert.match(macosCommand, /\/usr\/local\/share\/intent-ai-ops/u)
  assert.match(macosCommand, /cp -- '\/tmp\/intent ai ops\/install\.sh'/u)
  assert.doesNotMatch(macosCommand, /docker|podman|colima/u)

  const windows = buildCommonTask('intent-ai-ops-windows', 90, {
    platform: 'windows',
    docker: { ready: false },
    intentAiOpsInstallSource: {
      installerPath: 'C:\\Windows\\Temp\\intent-ai-ops\\install.ps1',
      packageUrl: 'C:\\Windows\\Temp\\intent-ai-ops\\intent-ai-ops.tgz'
    }
  })
  const windowsCommand = windows.plan.commands.find(command => command.id === 'install-intent-ai-ops').command
  assert.match(windowsCommand, /Copy-Item -LiteralPath/u)
  assert.match(windowsCommand, /C:\\ProgramData\\IntentAIOps/u)
  assert.doesNotMatch(windowsCommand, /Docker|WSL|container/u)
})

test('verified FreeBSD catalog exposes native PHP application routes', () => {
  assert.deepEqual(
    listCommonTasks({ category: 'application', platform: 'freebsd' }).map(task => task.id),
    ['podman-freebsd', 'wordpress-freebsd', 'woocommerce-freebsd', 'joomla-freebsd', 'drupal-freebsd', 'prestashop-freebsd', 'moodle-freebsd', 'nextcloud-freebsd', 'jellyfin-freebsd', 'mattermost-freebsd', 'n8n-freebsd', 'ghost-freebsd', 'odoo-freebsd', 'home-assistant-freebsd', 'magento-freebsd', 'intent-ai-ops-freebsd']
  )
  const built = buildCommonTask('wordpress-freebsd', 91, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { daemonReachable: true, composeAvailable: true } }
  })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  assert.match(built.plan.commands.find(item => item.id === 'build-mariadb-image').command, /freebsd-notoolchain:15\.1/u)
  assert.match(built.plan.commands.find(item => item.id === 'build-wordpress-image').command, /php84/u)
  assert.match(built.plan.commands.find(item => item.id === 'build-wordpress-image').command, /location ~ \\\.php\$/u)
  assert.match(built.plan.commands.find(item => item.id === 'build-wordpress-image').command, /location ~ \/\\\./u)
  assert.match(built.plan.commands.find(item => item.id === 'deploy-wordpress').command, /10\.89\.101\.2/u)
  assert.match(built.plan.commands.find(item => item.id === 'deploy-wordpress').command, /file_get_contents\("\/run\/secrets\/db_password"\)/u)
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'deploy-wordpress').command, /sed -i.*password_here/u)
  assert.match(built.plan.commands.find(item => item.id === 'verify-wordpress').command, /page-list\/style\.min\.css/u)
  assert.ok(built.plan.commands.filter(item => item.id.startsWith('build-')).every(item => item.executionMode === 'job'))
  assert.throws(
    () => buildCommonTask('wordpress-freebsd', 92, { platform: 'freebsd', freebsdExecution: { platform: 'freebsd', docker: {} } }),
    /Podman Suite/u
  )
  const wooCommerce = buildCommonTask('woocommerce-freebsd', 93, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { daemonReachable: true, composeAvailable: true } }
  })
  assert.equal(validateCommandPlan(wooCommerce.plan, rootExecutionPolicy({})), wooCommerce.plan)
  assert.match(wooCommerce.plan.commands.find(item => item.id === 'install-woocommerce').command, /woocommerce\.11\.0\.0\.zip/u)
  assert.match(wooCommerce.plan.commands.find(item => item.id === 'install-woocommerce').command, /WEBMINAI_WOOCOMMERCE_OK/u)
  assert.match(wooCommerce.verifyApplied, /10\.89\.102\.3\/product\/webminai-woocommerce-product/u)
  assert.doesNotMatch(wooCommerce.plan.revertCommands[0].command, /podman rmi/u)
  const joomla = buildCommonTask('joomla-freebsd', 94, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { daemonReachable: true, composeAvailable: true } }
  })
  assert.equal(validateCommandPlan(joomla.plan, rootExecutionPolicy({})), joomla.plan)
  assert.match(joomla.plan.commands.find(item => item.id === 'build-php-runtime').command, /php84-simplexml/u)
  assert.match(joomla.plan.commands.find(item => item.id === 'build-php-runtime').command, /location ~ \\.php\$/u)
  assert.match(joomla.plan.commands.find(item => item.id === 'deploy-joomla').command, /WEBMINAI_DB_PASS_FILE/u)
  assert.match(joomla.verifyApplied, /10\.89\.103\.3/u)
  const drupal = buildCommonTask('drupal-freebsd', 95, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { daemonReachable: true, composeAvailable: true } }
  })
  assert.equal(validateCommandPlan(drupal.plan, rootExecutionPolicy({})), drupal.plan)
  assert.match(drupal.plan.commands.find(item => item.id === 'deploy-drupal').command, /install-drupal\.php/u)
  assert.match(drupal.plan.commands.find(item => item.id === 'verify-drupal').command, /users_field_data/u)
  assert.match(drupal.verifyApplied, /10\.89\.104\.3/u)
  const prestashop = buildCommonTask('prestashop-freebsd', 96, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { daemonReachable: true, composeAvailable: true } }
  })
  assert.equal(validateCommandPlan(prestashop.plan, rootExecutionPolicy({})), prestashop.plan)
  assert.match(prestashop.plan.commands.find(item => item.id === 'start-prestashop').command, /187175adafc6038d/u)
  assert.match(prestashop.plan.commands.find(item => item.id === 'start-prestashop').command, /\.webminai-installed/u)
  assert.match(prestashop.plan.commands.find(item => item.id === 'initialize-prestashop-database').command, /--step='database'/u)
  assert.match(prestashop.verifyApplied, /10\.89\.105\.3/u)
  const moodle = buildCommonTask('moodle-freebsd', 97, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { daemonReachable: true, composeAvailable: true } }
  })
  assert.equal(validateCommandPlan(moodle.plan, rootExecutionPolicy({})), moodle.plan)
  assert.match(moodle.plan.commands.find(item => item.id === 'deploy-moodle').command, /root \/srv\/app\/public/u)
  assert.match(moodle.plan.commands.find(item => item.id === 'deploy-moodle').command, /admin\/cli\/cron\.php/u)
  assert.match(moodle.verifyApplied, /10\.89\.106\.3\/webminai-health\.txt/u)
  const nextcloud = buildCommonTask('nextcloud-freebsd', 98, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { daemonReachable: true, composeAvailable: true } }
  })
  assert.equal(validateCommandPlan(nextcloud.plan, rootExecutionPolicy({})), nextcloud.plan)
  assert.match(nextcloud.plan.commands.find(item => item.id === 'acquire-nextcloud').command, /nextcloud-33\.0\.7\.tar\.bz2/u)
  assert.match(nextcloud.plan.commands.find(item => item.id === 'deploy-nextcloud').command, /background:cron/u)
  assert.match(nextcloud.verifyApplied, /10\.89\.107\.3\/status\.php/u)
  const jellyfin = buildCommonTask('jellyfin-freebsd', 99, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { daemonReachable: true, composeAvailable: true } }
  })
  assert.equal(validateCommandPlan(jellyfin.plan, rootExecutionPolicy({})), jellyfin.plan)
  assert.match(jellyfin.plan.commands.find(item => item.id === 'install-jellyfin-runtime').command, /jellyfin-10\.11\.11/u)
  assert.match(jellyfin.plan.commands.find(item => item.id === 'prepare-jellyfin').command, /\[ ! -d .*99-jellyfin-freebsd.* \] \|\| exit 0/u)
  assert.match(jellyfin.plan.commands.find(item => item.id === 'deploy-jellyfin').command, /Startup\/Complete/u)
  assert.match(jellyfin.verifyApplied, /System\/Info\/Public/u)
  const mattermost = buildCommonTask('mattermost-freebsd', 100, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { daemonReachable: true, composeAvailable: true } }
  })
  assert.equal(validateCommandPlan(mattermost.plan, rootExecutionPolicy({})), mattermost.plan)
  assert.match(mattermost.plan.commands.find(item => item.id === 'install-mattermost-runtime').command, /mattermost-server-11\.7\.3_1/u)
  assert.match(mattermost.plan.commands.find(item => item.id === 'initialize-mattermost-admin').command, /system_admin/u)
  assert.match(mattermost.verifyApplied, /api\/v4\/system\/ping/u)
  const n8n = buildCommonTask('n8n-freebsd', 101, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { daemonReachable: true, composeAvailable: true } }
  })
  assert.equal(validateCommandPlan(n8n.plan, rootExecutionPolicy({})), n8n.plan)
  assert.match(n8n.plan.commands.find(item => item.id === 'install-n8n-runtime').command, /node24-24\.18\.0/u)
  assert.match(n8n.plan.commands.find(item => item.id === 'install-n8n-application').command, /n8n@2\.33\.7/u)
  assert.match(n8n.plan.commands.find(item => item.id === 'install-n8n-application').command, /SQLITE_DQS/u)
  assert.match(n8n.plan.commands.find(item => item.id === 'install-n8n-application').command, /-Bsymbolic/u)
  assert.match(n8n.plan.commands.find(item => item.id === 'install-n8n-application').command, /application-installed/u)
  assert.match(n8n.verifyApplied, /healthz/u)
  const ghost = buildCommonTask('ghost-freebsd', 102, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd' }
  })
  assert.equal(validateCommandPlan(ghost.plan, rootExecutionPolicy({})), ghost.plan)
  assert.match(ghost.plan.commands.find(item => item.id === 'install-ghost-runtime').command, /node22/u)
  assert.match(ghost.plan.commands.find(item => item.id === 'install-ghost-application').command, /corepack pnpm install --prod --frozen-lockfile/u)
  assert.match(ghost.plan.commands.find(item => item.id === 'initialize-ghost-database').command, /install -o mysql -g mysql -m 0640 \/dev\/null/u)
  assert.match(ghost.verifyApplied, /blog\//u)
  const odoo = buildCommonTask('odoo-freebsd', 103, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd' }
  })
  assert.equal(validateCommandPlan(odoo.plan, rootExecutionPolicy({})), odoo.plan)
  assert.match(odoo.plan.commands.find(item => item.id === 'install-odoo-runtime').command, /postgresql17-server-17\.10/u)
  assert.equal(odoo.plan.commands.find(item => item.id === 'install-odoo-runtime').timeoutMs, 3600000)
  assert.match(odoo.plan.commands.find(item => item.id === 'install-odoo-application').command, /GEVENTSETUP_EMBED_LIBEV=0/u)
  assert.match(odoo.plan.commands.find(item => item.id === 'configure-odoo').command, /CRYPTOGRAPHY_OPENSSL_NO_LEGACY=1/u)
  assert.doesNotMatch(odoo.plan.commands.find(item => item.id === 'install-odoo-runtime').command, /pkg clean/u)
  assert.match(odoo.verifyApplied, /odoo\/web\/login/u)
  const homeAssistant = buildCommonTask('home-assistant-freebsd', 104, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd' }
  })
  assert.equal(validateCommandPlan(homeAssistant.plan, rootExecutionPolicy({})), homeAssistant.plan)
  assert.match(homeAssistant.plan.commands.find(item => item.id === 'install-home-assistant-runtime').command, /python314-3\.14\.7/u)
  assert.match(homeAssistant.plan.commands.find(item => item.id === 'install-home-assistant-application').command, /uv==0\.11\.31/u)
  assert.match(homeAssistant.plan.commands.find(item => item.id === 'install-home-assistant-application').command, /application-installed/u)
  assert.doesNotMatch(homeAssistant.plan.commands.find(item => item.id === 'install-home-assistant-runtime').command, /pkg clean/u)
  assert.match(homeAssistant.plan.commands.find(item => item.id === 'verify-home-assistant').command, /for attempt in \$\(jot 90\)/u)
  assert.match(homeAssistant.plan.commands.find(item => item.id === 'initialize-home-assistant').command, /for attempt in \$\(jot 60\)/u)
  assert.match(homeAssistant.verifyApplied, /homeassistant\//u)
  const magento = buildCommonTask('magento-freebsd', 105, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd' }
  })
  assert.equal(validateCommandPlan(magento.plan, rootExecutionPolicy({})), magento.plan)
  assert.match(magento.plan.commands.find(item => item.id === 'install-magento-runtime').command, /php84-8\.4\.24/u)
  assert.equal(magento.plan.commands.find(item => item.id === 'install-magento-runtime').timeoutMs, 3600000)
  assert.match(magento.plan.commands.find(item => item.id === 'install-magento-runtime').command, /opensearch219-2\.19\.5/u)
  assert.match(magento.plan.commands.find(item => item.id === 'install-magento-source').command, /application-installed/u)
  assert.match(magento.plan.commands.find(item => item.id === 'initialize-magento').command, /application-initialized/u)
  assert.doesNotMatch(magento.plan.commands.find(item => item.id === 'install-magento-runtime').command, /pkg clean/u)
  assert.match(magento.plan.commands.find(item => item.id === 'configure-magento-runtime').command, /listen = \/var\/db\/webminai-magento-18108\/php-run\/php-fpm\.sock/u)
  assert.match(magento.verifyApplied, /WEBMINAI_MAGENTO_OK/u)
})

test('eligible catalog resolves distro and runtime prerequisites before display or AI routing', () => {
  const linuxContext = { identity: { id: 'fedora', versionId: '44' }, management: { packageManager: 'dnf' } }
  const freshLinux = {
    platform: 'linux',
    linuxContext,
    docker: { platform: 'linux', preference: 'auto', preferred: true, ready: false, installSupported: true, installMethod: 'official-rpm' }
  }
  assert.deepEqual(listEligibleCommonTasks({ category: 'application', ...freshLinux }).map(task => task.id), ['docker-linux', 'intent-ai-ops-linux'])
  assert.equal(commonTaskEligibility('wordpress-linux', freshLinux).eligible, false)

  const readyLinux = { ...freshLinux, docker: { ...freshLinux.docker, ready: true, cliAvailable: true, daemonReachable: true, composeAvailable: true } }
  const readyIds = listEligibleCommonTasks({ category: 'application', ...readyLinux }).map(task => task.id)
  assert.equal(readyIds.includes('docker-linux'), true)
  assert.equal(readyIds.includes('home-assistant-linux'), true)

  const disabledLinux = { ...freshLinux, docker: { ...freshLinux.docker, preference: 'disabled', preferred: false } }
  assert.equal(listEligibleCommonTasks({ category: 'application', ...disabledLinux }).some(task => task.id === 'docker-linux'), false)
})

test('container runtime prerequisites gate dependent Windows, macOS, and FreeBSD tasks', () => {
  const windowsExecution = { platform: 'windows', architecture: 'AMD64', docker: { serverOs: 'linux', cliAvailable: true, daemonReachable: true, composeAvailable: true, composeCommand: 'docker compose' } }
  const windowsFresh = { platform: 'windows', windowsExecution, docker: { platform: 'windows', preference: 'auto', ready: false } }
  assert.deepEqual(listEligibleCommonTasks({ category: 'application', ...windowsFresh }).map(task => task.id), ['brave-windows', 'docker-desktop-windows', 'intent-ai-ops-windows'])
  assert.equal(listEligibleCommonTasks({ category: 'application', ...windowsFresh, docker: { ...windowsFresh.docker, preferred: true, ready: true } }).some(task => task.id === 'wordpress-windows'), true)

  const macosExecution = { platform: 'macos', macosVersion: '15.7', architecture: 'x86_64', runtimeUser: 'mac', runtimeHome: '/Users/mac', brewPath: '/usr/local/bin/brew', brewPrefix: '/usr/local', docker: {} }
  const macosFresh = { platform: 'macos', macosExecution, docker: { platform: 'macos', preference: 'auto', ready: false, runtimeUser: 'mac', runtimeHome: '/Users/mac' } }
  assert.deepEqual(listEligibleCommonTasks({ category: 'application', ...macosFresh }).map(task => task.id), ['colima-macos', 'intent-ai-ops-macos'])
  assert.equal(listEligibleCommonTasks({ category: 'application', ...macosFresh, docker: { ...macosFresh.docker, ready: true } }).some(task => task.id === 'wordpress-macos'), true)

  const freebsdExecution = { platform: 'freebsd', freebsdVersion: '15.1-RELEASE', docker: { installSupported: true, hostIsContainer: false } }
  const freebsdFresh = { platform: 'freebsd', freebsdExecution, docker: { platform: 'freebsd', preference: 'auto', ready: false, installSupported: true, installMethod: 'freebsd-podman-linux' } }
  const freebsdIds = listEligibleCommonTasks({ category: 'application', ...freebsdFresh }).map(task => task.id)
  assert.equal(freebsdIds.includes('podman-freebsd'), true)
  assert.equal(freebsdIds.includes('wordpress-freebsd'), false)
  const freebsd14 = { ...freebsdFresh, freebsdExecution: { platform: 'freebsd', freebsdVersion: '14.4-RELEASE', docker: { installSupported: false, hostIsContainer: false } }, docker: { ...freebsdFresh.docker, installSupported: false } }
  assert.equal(listEligibleCommonTasks({ category: 'application', ...freebsd14 }).some(task => task.id === 'podman-freebsd'), false)
})

test('Linux Docker and FreeBSD Podman common tasks expose actionable platform preflights', () => {
  const linuxRoutes = [
    ['ubuntu', 'apt', 'official-apt'],
    ['fedora', 'dnf', 'official-rpm'],
    ['alpine', 'apk', 'distribution-packages'],
    ['arch', 'pacman', 'distribution-packages'],
    ['opensuse-leap', 'zypper', 'distribution-packages']
  ]
  for (const [id, packageManager, installMethod] of linuxRoutes) {
    const built = buildCommonTask('docker-linux', 120, {
      platform: 'linux',
      linuxContext: { identity: { id, versionId: 'test' }, management: { packageManager } },
      docker: { platform: 'linux', preference: 'auto', preferred: true, ready: false, installSupported: true, installMethod }
    })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.match(built.plan.commands[0].command, /VT-x, AMD-V, and nested virtualization are not required/u)
    assert.match(built.plan.commands.find(item => item.id === 'install-docker-engine').command, /packages\.added/u)
    assert.ok(built.plan.revertCommands.length > 0)
    assert.match(built.plan.revertCommands.find(item => item.id === 'verify-docker-baseline').command, /\[ -d '\/var\/lib\/webminai\/tasks\/120\/linux-docker' \] \|\| exit 0/u)
  }

  const freebsd = buildCommonTask('podman-freebsd', 121, {
    platform: 'freebsd',
    freebsdExecution: { platform: 'freebsd', docker: { installSupported: true, hostIsContainer: false } },
    docker: { platform: 'freebsd', preference: 'auto', ready: false, installSupported: true, installMethod: 'freebsd-podman-linux' }
  })
  assert.equal(validateCommandPlan(freebsd.plan, rootExecutionPolicy({})), freebsd.plan)
  assert.match(freebsd.plan.commands[0].command, /FreeBSD 15 or newer/u)
  assert.match(freebsd.plan.commands[0].command, /nested virtualization are not required/u)
  assert.match(freebsd.plan.commands.find(item => item.id === 'install-podman-suite').command, /podman-suite py312-podman-compose/u)
  assert.match(freebsd.plan.revertCommands.find(item => item.id === 'verify-podman-baseline').command, /\[ ! -d .*121-freebsd-podman.* \] \|\|/u)
})

test('macOS catalog exposes a virtualization-gated Colima prerequisite', () => {
  assert.deepEqual(
    listCommonTasks({ category: 'application', platform: 'macos' }).map(task => task.id),
    ['colima-macos', 'wordpress-macos', 'woocommerce-macos', 'joomla-macos', 'drupal-macos', 'prestashop-macos', 'moodle-macos', 'magento-macos', 'n8n-macos', 'ghost-macos', 'mattermost-macos', 'odoo-macos', 'jellyfin-macos', 'home-assistant-macos', 'intent-ai-ops-macos']
  )
  const built = buildCommonTask('colima-macos', 106, {
    platform: 'macos',
    macosExecution: {
      platform: 'macos',
      brewPath: '/usr/local/bin/brew',
      brewPrefix: '/usr/local',
      runtimeUser: 'mac',
      runtimeHome: '/Users/mac'
    },
    docker: { platform: 'macos', installMethod: 'homebrew-colima', runtimeUser: 'mac', runtimeHome: '/Users/mac' }
  })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  assert.match(built.plan.commands[0].command, /kern\.hv_support/u)
  assert.match(built.plan.commands[0].command, /MACOS_HYPERVISOR_UNAVAILABLE/u)
  assert.match(built.plan.commands.find(item => item.id === 'install-colima-toolchain').command, /brew.*install.*colima.*docker.*docker-compose/u)
  assert.doesNotMatch(built.plan.commands.map(item => item.command).join('\n'), /Docker\.app/u)
  for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
    const syntax = spawnSync('/bin/sh', ['-n', '-c', command.command], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, `${command.id}: ${syntax.stderr}`)
  }

  const wordpress = buildCommonTask('wordpress-macos', 107, {
    platform: 'macos',
    macosExecution: {
      platform: 'macos',
      runtimeUser: 'mac',
      runtimeHome: '/Users/mac'
    },
    docker: { ready: true }
  })
  assert.equal(validateCommandPlan(wordpress.plan, rootExecutionPolicy({})), wordpress.plan)
  assert.match(wordpress.plan.commands.find(item => item.id === 'write-compose').command, /wordpress:7\.0\.2-php8\.3-fpm/u)
  assert.match(wordpress.plan.commands.find(item => item.id === 'write-compose').command, /\/Users\/mac\/\.webminai\/credentials\/wordpress/u)
  assert.doesNotMatch(JSON.stringify(wordpress.plan), /\/var\/lib\/webminai|\/opt\/webminai|\/root\/wordpress_credentials|systemctl|apt-get|dpkg/u)
  for (const command of [...wordpress.plan.commands, ...wordpress.plan.revertCommands]) {
    const syntax = spawnSync('/bin/sh', ['-n', '-c', command.command], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, `${command.id}: ${syntax.stderr}`)
  }

  for (const application of ['woocommerce', 'joomla', 'drupal', 'prestashop', 'moodle', 'magento', 'n8n', 'ghost', 'mattermost', 'odoo', 'jellyfin', 'home-assistant']) {
    const candidate = buildCommonTask(`${application}-macos`, 108, {
      platform: 'macos',
      macosExecution: { platform: 'macos', architecture: 'x86_64', runtimeUser: 'mac', runtimeHome: '/Users/mac' },
      docker: { ready: true }
    })
    assert.equal(validateCommandPlan(candidate.plan, rootExecutionPolicy({})), candidate.plan)
    const serialized = JSON.stringify(candidate.plan)
    assert.match(serialized, /DOCKER_HOST='unix:\/\/\/Users\/mac\/\.colima\/default\/docker\.sock'/u)
    assert.doesNotMatch(serialized, /\/opt\/webminai\/services|\/root\/[a-z_-]+_credentials|\/var\/lib\/webminai\/task-state|systemctl (start|stop) docker/u)
    assert.doesNotMatch(serialized, /stat -c|ip -4 route|hostname -I|\$\(seq /u)
    for (const command of [...candidate.plan.commands, ...candidate.plan.revertCommands]) {
      const syntax = spawnSync('/bin/sh', ['-n', '-c', command.command], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, `${application}/${command.id}: ${syntax.stderr}`)
    }
  }
  const n8n = buildCommonTask('n8n-macos', 109, { platform: 'macos', macosExecution: { platform: 'macos', architecture: 'x86_64', runtimeUser: 'mac', runtimeHome: '/Users/mac' }, docker: { ready: true } })
  assert.match(n8n.plan.commands.find(command => command.id === 'start-compose').command, /up -d n8n;.*healthy.*up -d;/u)
  const jellyfin = buildCommonTask('jellyfin-macos', 110, { platform: 'macos', macosExecution: { platform: 'macos', architecture: 'x86_64', runtimeUser: 'mac', runtimeHome: '/Users/mac' }, docker: { ready: true } })
  assert.match(JSON.stringify(jellyfin.plan), /\/Users\/mac\/\.webminai\/data\/jellyfin/u)
  assert.doesNotMatch(JSON.stringify(jellyfin.plan), /\/var\/lib\/webminai-jellyfin/u)
  const homeAssistant = buildCommonTask('home-assistant-macos', 111, { platform: 'macos', macosExecution: { platform: 'macos', architecture: 'x86_64', runtimeUser: 'mac', runtimeHome: '/Users/mac' }, docker: { ready: true } })
  assert.doesNotMatch(homeAssistant.plan.commands.find(command => command.id === 'start-compose').command, /homeassistant\//u)
  assert.doesNotMatch(homeAssistant.plan.commands.find(command => command.id === 'verify-compose').command, /api\/onboarding/u)
  assert.doesNotMatch(homeAssistant.plan.commands.find(command => command.id === 'verify-compose').command, /homeassistant\//u)
  assert.doesNotMatch(homeAssistant.verifyApplied, /api\/onboarding|homeassistant\//u)
})

test('custom planning can consume bounded intelligence from verified candidates', async () => {
  const service = new LinuxHostContextService({
    fetchImpl: async () => new Response('official release', { status: 200 }),
    now: () => new Date('2026-08-10T00:00:00.000Z')
  })
  const context = await service.build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
  })
  const references = buildCandidatePlanningContext(['wordpress-linux'], 90, {
    platform: 'linux',
    linuxContext: context,
    docker: { preferred: false }
  })
  assert.equal(references[0].catalogId, 'wordpress-linux')
  assert.match(references[0].verifiedPlan.summary, /WordPress/u)
  assert.ok(references[0].verifiedPlan.commands.every(item => item.commandFragment.length <= 2048))
  assert.throws(() => buildCandidatePlanningContext(['wordpress-linux', 'wordpress-linux'], 90), /unique/u)
})

test('verified WordPress task builds valid plans for every Linux package family', async () => {
  const service = new LinuxHostContextService({
    fetchImpl: async () => new Response('official release', { status: 200 }),
    now: () => new Date('2026-08-08T00:00:00.000Z')
  })
  const identities = [
    { ID: 'ubuntu', VERSION_ID: '24.04' },
    { ID: 'alpine', VERSION_ID: '3.23' },
    { ID: 'arch' },
    { ID: 'opensuse-leap', VERSION_ID: '16.0' },
    { ID: 'fedora', VERSION_ID: '44' }
  ]
  for (const [index, osRelease] of identities.entries()) {
    const context = await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: osRelease.ID === 'alpine' ? 'init' : 'systemd', osRelease, commands: {} }
    })
    const built = buildCommonTask('wordpress-linux', 100 + index, { platform: 'linux', linuxContext: context })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.match(built.plan.commands.find(item => item.id === 'prepare-database').command, /install -d -o mysql -g mysql -m 0755 \/run\/mariadb \/run\/mysqld/)
    if (osRelease.ID === 'fedora') {
      assert.match(built.plan.commands.find(item => item.id === 'prepare-database').command, /@'127\.0\.0\.1'/)
      assert.match(built.plan.commands.find(item => item.id === 'install-wordpress').command, /--dbhost='127\.0\.0\.1'/)
      assert.match(built.plan.commands.find(item => item.id === 'install-wordpress').command, /chown 'nginx:nginx'.*wp-config\.php/)
    }
    for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
      const syntax = spawnSync('/bin/bash', ['-n', '-c', command.command], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, `${osRelease.ID}/${command.id}: ${syntax.stderr}`)
    }
  }
  assert.equal(listCommonTasks({ category: 'application' }).some(task => task.id === 'wordpress-linux'), true)
})

test('verified WordPress task selects a reversible Compose route when Docker setup is preferred', async () => {
  const service = new LinuxHostContextService({
    fetchImpl: async () => new Response('official release', { status: 200 }),
    now: () => new Date('2026-08-08T00:00:00.000Z')
  })
  const context = await service.build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '22.04' }, commands: { apt: true } }
  })
  const built = buildCommonTask('wordpress-linux', 200, {
    platform: 'linux',
    linuxContext: context,
    docker: { preferred: true, ready: false, installSupported: true, installMethod: 'official-apt' },
    applicationDefaults: { adminEmail: 'owner@example.test' }
  })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  assert.match(built.plan.summary, /Compose/)
  assert.match(built.plan.commands.find(item => item.id === 'prepare-docker').command, /download\.docker\.com/)
  const compose = built.plan.commands.find(item => item.id === 'write-compose').command
  assert.match(compose, /wordpress:7\.0\.2-php8\.3-fpm/)
  assert.match(compose, /nginx:1\.30\.4-alpine/)
  assert.match(compose, /fastcgi_pass unix:\/run\/php-fpm\/webminai\.sock/)
  assert.doesNotMatch(compose, /apache/u)
  assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /\/run\/webminai\/db_password/)
  assert.match(built.plan.commands.find(item => item.id === 'pull-images').command, /--profile tools pull/)
  assert.equal(built.plan.commands.some(item => item.command.includes('docker run')), false)
  assert.match(built.plan.commands.find(item => item.id === 'initialize-wordpress').command, /--admin_email=owner@example\.test/)
  assert.equal(JSON.stringify(built).includes('intentaiops@example.invalid'), false)
  for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
    const syntax = spawnSync('/bin/bash', ['-n', '-c', command.command], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, `${command.id}: ${syntax.stderr}`)
  }
})

test('verified WooCommerce task composes a pinned application delta for native and Compose routes', async () => {
  const service = new LinuxHostContextService({
    fetchImpl: async () => new Response('official release', { status: 200 }),
    now: () => new Date('2026-08-08T00:00:00.000Z')
  })
  const context = await service.build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
  })
  const routes = [
    { docker: { preferred: false }, expected: /native WooCommerce/u },
    { docker: { preferred: true, ready: false, installSupported: true, installMethod: 'official-apt' }, expected: /WooCommerce Compose/u }
  ]
  for (const [index, route] of routes.entries()) {
    const built = buildCommonTask('woocommerce-linux', 300 + index, { platform: 'linux', linuxContext: context, docker: route.docker })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.match(built.plan.summary, route.expected)
    assert.equal(built.plan.compatibilityManifest.status, 'resolved')
    assert.equal(built.plan.compatibilityManifest.application.version, '11.0.0')
    assert.equal(built.plan.applicationDelta.application.id, 'woocommerce')
    const delta = built.plan.commands.find(item => item.id === (route.docker.preferred ? 'configure-woocommerce-store' : 'install-woocommerce'))
    assert.equal(delta.phase, 'initialize')
    const deltaText = built.plan.commands.filter(item => ['configure', 'initialize'].includes(item.phase)).map(item => item.command).join('\n')
    assert.match(deltaText, /ba08c7fc58c98a11f22866269c5832d85c52b664806ec206036f09737ba21666/u)
    assert.match(deltaText, /woocommerce\.11\.0\.0\.zip/u)
    if (route.docker.preferred) assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /tmpfs: \["\/run\/webminai:size=64k,mode=0711"\]/u)
    else {
      const packages = built.plan.commands.find(item => item.id === 'install-packages').command
      const packageStep = built.plan.commands.find(item => item.id === 'install-packages')
      const nginx = built.plan.commands.find(item => item.id === 'configure-nginx').command
      assert.equal(packageStep.executionMode, 'job')
      assert.equal(packageStep.timeoutMs, 1800000)
      assert.match(packages, /package-install\.log/u)
      assert.match(packages, /> .*package-install\.log.*2>&1/u)
      assert.match(packages, /tail -n 20/u)
      assert.match(nginx, /fastcgi_param HTTP_HOST \$http_host/u)
      assert.match(nginx, /fastcgi_param SERVER_PORT \$server_port/u)
      assert.match(nginx, /fastcgi_param REQUEST_SCHEME \$scheme/u)
    }
    assert.match(delta.command, /WEBMINAI_WOOCOMMERCE_OK/u)
    assert.doesNotMatch(JSON.stringify(built.plan), /WEBMINAI_WORDPRESS_OK/u)
    assert.match(built.verifyApplied, /plugin is-active woocommerce/u)
    for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
      const syntax = spawnSync('/bin/bash', ['-n', '-c', command.command], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, `${command.id}: ${syntax.stderr}`)
    }
  }
  assert.equal(listCommonTasks({ category: 'application' }).some(task => task.id === 'woocommerce-linux'), true)
})

test('verified Joomla task resolves native and Compose routes without credential literals', async () => {
  const service = new LinuxHostContextService({
    fetchImpl: async () => new Response('official release', { status: 200 }),
    now: () => new Date('2026-08-08T00:00:00.000Z')
  })
  const contexts = [
    await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'almalinux', VERSION_ID: '9.8' }, commands: { dnf: true } }
    }),
    await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
  ]
  const routes = [
    { context: contexts[0], docker: { preferred: false }, route: 'joomla-native' },
    { context: contexts[1], docker: { preferred: true, ready: false, installSupported: true, installMethod: 'official-apt' }, route: 'joomla-compose' }
  ]
  for (const [index, route] of routes.entries()) {
    const built = buildCommonTask('joomla-linux', 400 + index, { platform: 'linux', linuxContext: route.context, docker: route.docker })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.equal(built.plan.compatibilityManifest.application.version, '5.4.7')
    assert.equal(built.plan.compatibilityManifest.selectedRoute.id, route.route)
    assert.equal(built.plan.applicationDelta.application.id, 'joomla')
    const serialized = JSON.stringify(built.plan)
    assert.match(serialized, /WEBMINAI_JOOMLA_OK/u)
    assert.match(serialized, /d989e8a315238784b8e4ca5eef0cad3e498e989cc0b9094d341c0d997ddb8729/u)
    assert.doesNotMatch(serialized, /WEBMINAI_WORDPRESS_OK/u)
    assert.doesNotMatch(serialized, /password: [0-9A-Fa-f]{16,}/u)
    if (route.docker.preferred) {
      const compose = built.plan.commands.find(item => item.id === 'write-compose').command
      assert.match(compose, /joomla:5\.4\.7-php8\.3-fpm/u)
      assert.match(compose, /nginx:1\.30\.4-alpine/u)
      assert.match(compose, /fastcgi_pass unix:\/run\/php-fpm\/webminai\.sock/u)
      assert.doesNotMatch(compose, /apache/u)
      assert.match(compose, /admin_password/u)
    } else {
      assert.match(built.plan.commands.find(item => item.id === 'install-packages').command, /module enable php:8\.3/u)
      assert.match(built.plan.commands.find(item => item.id === 'install-joomla').command, /auto_prepend_file/u)
      assert.doesNotMatch(built.plan.commands.find(item => item.id === 'install-joomla').command, /--admin-password=/u)
    }
    for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
      const syntax = spawnSync('/bin/bash', ['-n', '-c', command.command], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, `${route.route}/${command.id}: ${syntax.stderr}`)
    }
  }
  assert.equal(listCommonTasks({ category: 'application' }).some(task => task.id === 'joomla-linux'), true)
})

test('verified Drupal task resolves native and Compose routes without credential literals', async () => {
  const service = new LinuxHostContextService({
    fetchImpl: async () => new Response('official release', { status: 200 }),
    now: () => new Date('2026-08-08T00:00:00.000Z')
  })
  const contexts = [
    await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'almalinux', VERSION_ID: '9.8' }, commands: { dnf: true } }
    }),
    await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
  ]
  const routes = [
    { context: contexts[0], docker: { preferred: false }, route: 'drupal-native' },
    { context: contexts[1], docker: { preferred: true, ready: false, installSupported: true, installMethod: 'official-apt' }, route: 'drupal-compose' }
  ]
  for (const [index, route] of routes.entries()) {
    const built = buildCommonTask('drupal-linux', 500 + index, { platform: 'linux', linuxContext: route.context, docker: route.docker })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.equal(built.plan.compatibilityManifest.application.version, '11.4.4')
    assert.equal(built.plan.compatibilityManifest.selectedRoute.id, route.route)
    assert.equal(built.plan.applicationDelta.application.id, 'drupal')
    const serialized = JSON.stringify(built.plan)
    assert.match(serialized, /WEBMINAI_DRUPAL_OK/u)
    assert.match(serialized, /c786e19dcf9e9129da23ece5f11cbc6dbac756aa1cc0ffe2e23b33cf74f9f619/u)
    assert.doesNotMatch(serialized, /WEBMINAI_JOOMLA_OK/u)
    assert.doesNotMatch(serialized, /password: [0-9A-Fa-f]{16,}/u)
    if (route.docker.preferred) {
      const compose = built.plan.commands.find(item => item.id === 'write-compose').command
      assert.match(compose, /drupal:11\.4\.4-php8\.4-fpm/u)
      assert.match(compose, /nginx:1\.30\.4-alpine/u)
      assert.match(compose, /fastcgi_pass unix:\/run\/php-fpm\/webminai\.sock/u)
      assert.doesNotMatch(compose, /apache/u)
      assert.match(compose, /admin_password/u)
    } else {
      assert.match(built.plan.commands.find(item => item.id === 'install-packages').command, /module enable mariadb:10\.11/u)
      assert.match(built.plan.commands.find(item => item.id === 'install-packages').command, /module enable php:8\.3/u)
      assert.match(built.plan.revertCommands.find(item => item.id === 'restore-packages-services').command, /module reset php/u)
      assert.match(built.plan.commands.find(item => item.id === 'install-drupal').command, /WEBMINAI_DB_PASS_FILE/u)
      assert.doesNotMatch(built.plan.commands.find(item => item.id === 'install-drupal').command, /--account-pass/u)
    }
    for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
      const syntax = spawnSync('/bin/bash', ['-n', '-c', command.command], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, `${route.route}/${command.id}: ${syntax.stderr}`)
    }
  }
  assert.equal(listCommonTasks({ category: 'application' }).some(task => task.id === 'drupal-linux'), true)
})

test('verified PrestaShop task resolves nginx and PHP-FPM socket routes without credential literals', async () => {
  const service = new LinuxHostContextService({
    fetchImpl: async () => new Response('official release', { status: 200 }),
    now: () => new Date('2026-08-08T00:00:00.000Z')
  })
  const contexts = [
    await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'almalinux', VERSION_ID: '9.8' }, commands: { dnf: true } }
    }),
    await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
  ]
  const routes = [
    { context: contexts[0], docker: { preferred: false }, route: 'prestashop-native' },
    { context: contexts[1], docker: { preferred: true, ready: false, installSupported: true, installMethod: 'official-apt' }, route: 'prestashop-compose' }
  ]
  for (const [index, route] of routes.entries()) {
    const built = buildCommonTask('prestashop-linux', 600 + index, { platform: 'linux', linuxContext: route.context, docker: route.docker })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.equal(built.plan.compatibilityManifest.application.version, '9.1.4')
    assert.equal(built.plan.compatibilityManifest.selectedRoute.id, route.route)
    assert.equal(built.plan.applicationDelta.application.id, 'prestashop')
    const serialized = JSON.stringify(built.plan)
    assert.match(serialized, /WEBMINAI_PRESTASHOP_OK/u)
    assert.match(serialized, /67babe2beb58ea242ca09f2942a301e5e09567c0e04f88525b2cfb6f671a5eeb/u)
    assert.doesNotMatch(serialized, /WEBMINAI_DRUPAL_OK/u)
    assert.doesNotMatch(serialized, /password: [0-9A-Fa-f]{16,}/u)
    if (route.docker.preferred) {
      const compose = built.plan.commands.find(item => item.id === 'write-compose').command
      assert.match(compose, /prestashop\/prestashop:9\.1\.4-5\.0-classic-8\.4-fpm/u)
      assert.match(compose, /nginx:1\.30\.4-alpine/u)
      assert.match(compose, /fastcgi_pass unix:\/run\/php-fpm\/webminai\.sock/u)
      assert.doesNotMatch(compose, /apache/u)
      assert.match(compose, /admin_password/u)
      assert.doesNotMatch(compose, /DB_PASSWD|ADMIN_PASSWD/u)
      assert.match(built.plan.commands.find(item => item.id === 'prepare-prestashop-swap').command, /fallocate -l 1G/u)
      assert.match(built.plan.commands.find(item => item.id === 'initialize-prestashop-modules-1').command, /--modules=ps_linklist/u)
      const start = built.plan.commands.find(item => item.id === 'start-compose').command
      assert.match(start, /\.webminai-installed \|\| test -f \/var\/www\/html\/install\/index_cli\.php/u)
      const finalize = built.plan.commands.find(item => item.id === 'initialize-prestashop-finalize').command
      assert.match(finalize, /mv \/var\/www\/html\/admin \/var\/www\/html\/admin-webminai/u)
      assert.match(finalize, /bundles\/fosjsrouting/u)
      assert.match(finalize, /bundles\/apiplatform/u)
      assert.match(finalize, /chown -R www-data:www-data \/var\/www\/html\/var\/cache/u)
      assert.doesNotMatch(finalize, /--step=finalize/u)
      assert.match(built.verifyApplied, /admin-webminai\/index\.php/u)
      assert.match(built.plan.revertCommands.find(item => item.id === 'remove-prestashop-swap').command, /swapoff/u)
    } else {
      const install = built.plan.commands.find(item => item.id === 'install-prestashop').command
      assert.match(built.plan.commands.find(item => item.id === 'install-packages').command, /module enable php:8\.3/u)
      assert.match(built.plan.revertCommands.find(item => item.id === 'restore-packages-services').command, /module reset php/u)
      assert.match(install, /auto_prepend_file/u)
      assert.match(install, /WEBMINAI_DB_PASS_FILE/u)
      assert.doesNotMatch(install, /--db_password=[0-9A-Fa-f]/u)
      assert.match(built.plan.commands.find(item => item.id === 'configure-php-fpm').command, /listen = \/run\/webminai-prestashop-18105\/php-fpm\.sock/u)
      assert.match(built.plan.commands.find(item => item.id === 'configure-nginx').command, /fastcgi_pass unix:\/run\/webminai-prestashop-18105\/php-fpm\.sock/u)
      assert.match(built.plan.commands.find(item => item.id === 'verify-prestashop').command, /test -S '\/run\/webminai-prestashop-18105\/php-fpm\.sock'/u)
    }
    for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
      const syntax = spawnSync('/bin/bash', ['-n', '-c', command.command], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, `${route.route}/${command.id}: ${syntax.stderr}`)
    }
  }
  assert.equal(listCommonTasks({ category: 'application' }).some(task => task.id === 'prestashop-linux'), true)
})

test('verified Moodle task resolves public-root nginx, PHP-FPM socket, off-web data, cron, and protected credentials', async () => {
  const service = new LinuxHostContextService({
    fetchImpl: async () => new Response('official release', { status: 200 }),
    now: () => new Date('2026-08-08T00:00:00.000Z')
  })
  const contexts = [
    await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'almalinux', VERSION_ID: '9.8' }, commands: { dnf: true } }
    }),
    await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    }),
    await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'arch', VERSION_ID: '' }, commands: { pacman: true } }
    }),
    await service.build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'opensuse-leap', VERSION_ID: '16.0' }, commands: { zypper: true } }
    })
  ]
  const routes = [
    { context: contexts[0], docker: { preferred: false }, route: 'moodle-native' },
    { context: contexts[1], docker: { preferred: true, ready: false, installSupported: true, installMethod: 'official-apt' }, route: 'moodle-compose' },
    { context: contexts[2], docker: { preferred: false }, route: 'moodle-native' },
    { context: contexts[3], docker: { preferred: false }, route: 'moodle-native' }
  ]
  for (const [index, route] of routes.entries()) {
    const built = buildCommonTask('moodle-linux', 700 + index, { platform: 'linux', linuxContext: route.context, docker: route.docker })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.equal(built.plan.compatibilityManifest.application.version, '5.2.1')
    assert.equal(built.plan.compatibilityManifest.selectedRoute.id, route.route)
    assert.equal(built.plan.applicationDelta.application.id, 'moodle')
    const serialized = JSON.stringify(built.plan)
    assert.match(serialized, /cbbd7176c9e88a33e577666347566b557cb97ef8c48d0e40da7a980c43fd16ab/u)
    assert.match(serialized, /WEBMINAI_MOODLE_OK/u)
    assert.match(serialized, /\/srv\/webminai-moodledata-18106/u)
    assert.doesNotMatch(serialized, /apache/u)
    assert.doesNotMatch(serialized, /--adminpass=[0-9A-Fa-f]/u)
    if (route.docker.preferred) {
      const compose = built.plan.commands.find(item => item.id === 'write-compose').command
      const pullImages = built.plan.commands.find(item => item.id === 'pull-images')
      const initialize = built.plan.commands.find(item => item.id === 'initialize-moodle')
      assert.match(compose, /FROM php:8\.4\.23-fpm-bookworm/u)
      assert.equal(compose.includes('%s  %s\\n'), true)
      assert.match(compose, /root \/var\/www\/html\/public/u)
      assert.match(compose, /fastcgi_pass unix:\/run\/php-fpm\/webminai\.sock/u)
      assert.match(compose, /\/var\/www\/html\/public\/version\.php/u)
      assert.match(compose, /cron:/u)
      assert.match(compose, /-m 0755 \/run\/php-fpm/u)
      assert.doesNotMatch(compose, /exec -T --user www-data -e WEBMINAI_MOODLE_URL/u)
      assert.match(built.plan.commands.find(item => item.id === 'prepare-moodle-swap').command, /fallocate -l 2G/u)
      assert.equal(pullImages.executionMode, 'job')
      assert.equal(pullImages.timeoutMs, 45 * 60 * 1000)
      assert.match(pullImages.command, /docker buildx build --builder 'webminai-moodle-[0-9]+' --pull --network host --load/u)
      assert.match(pullImages.command, /docker buildx rm --force 'webminai-moodle-[0-9]+'/u)
      assert.match(pullImages.command, /moby\/buildkit:buildx-stable-1/u)
      assert.match(built.plan.revertCommands.find(item => item.id === 'remove-compose-project').command, /docker buildx rm --force 'webminai-moodle-[0-9]+'/u)
      assert.match(built.verifyReverted, /docker buildx inspect 'webminai-moodle-[0-9]+'/u)
      assert.doesNotMatch(pullImages.command, /docker image inspect 'php:8\.4\.23-fpm-bookworm'/u)
      assert.doesNotMatch(pullImages.command, /nohup|moodle-build\.pid|build-still-running/u)
      assert.equal(initialize.executionMode, 'job')
      assert.equal(initialize.timeoutMs, 30 * 60 * 1000)
      assert.match(initialize.command, /admin\/cli\/cron\.php --help/u)
      assert.match(initialize.command, /-p 'webminai-moodle-18106' up -d cron/u)
      assert.match(initialize.command, /public\/webminai-health\.txt/u)
      assert.match(built.verifyApplied, /webminai-health\.txt/u)
      assert.doesNotMatch(built.plan.commands.find(item => item.id === 'verify-compose').command, /--location[^;]*login\/index\.php/u)
    } else {
      assert.match(built.plan.commands.find(item => item.id === 'configure-php-fpm').command, /max_input_vars/u)
      assert.match(built.plan.commands.find(item => item.id === 'configure-nginx').command, /root \/srv\/webminai-moodle-18106\/public/u)
      assert.match(built.plan.commands.find(item => item.id === 'install-moodle').command, /auto_prepend_file/u)
      assert.match(built.plan.commands.find(item => item.id === 'install-moodle').command, /installer-argv\.php/u)
      assert.match(built.plan.commands.find(item => item.id === 'extract-moodle').command, /\/public\/version\.php/u)
      assert.match(built.plan.commands.find(item => item.id === 'configure-moodle-cron').command, /cron/u)
      if (route.context.management.family === 'arch') {
        assert.match(built.plan.commands.find(item => item.id === 'install-packages').command, /php-legacy-fpm/u)
        assert.match(built.plan.commands.find(item => item.id === 'configure-php-fpm').command, /php-fpm-legacy/u)
        assert.match(built.plan.commands.find(item => item.id === 'install-moodle').command, /php-legacy/u)
      }
      if (route.context.management.family === 'rhel') {
        const packages = built.plan.commands.find(item => item.id === 'install-packages').command
        assert.match(packages, /remi-release-9\.rpm/u)
        assert.match(packages, /module enable mariadb:10\.11/u)
        assert.match(packages, /php84-php-fpm/u)
        assert.match(packages, /php84-php-sodium/u)
        assert.match(built.plan.commands.find(item => item.id === 'configure-php-fpm').command, /php84-php-fpm/u)
        assert.match(built.plan.commands.find(item => item.id === 'install-moodle').command, /\/opt\/remi\/php84\/root\/usr\/bin\/php/u)
        assert.doesNotMatch(built.plan.revertCommands.find(item => item.id === 'restore-packages-services').command, /dnf -y remove --/u)
        assert.match(built.plan.revertCommands.find(item => item.id === 'restore-packages-services').command, /module reset mariadb/u)
      }
      if (route.context.management.family === 'suse') {
        assert.match(built.plan.commands.find(item => item.id === 'install-packages').command, /php8-ctype/u)
      }
    }
    for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
      const syntax = spawnSync('/bin/bash', ['-n', '-c', command.command], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, `${route.route}/${command.id}: ${syntax.stderr}`)
    }
  }
  const alpineContext = await service.build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'openrc', osRelease: { ID: 'alpine', VERSION_ID: '3.23' }, commands: { apk: true } }
  })
  const alpine = buildCommonTask('moodle-linux', 799, { platform: 'linux', linuxContext: alpineContext, docker: { preferred: false } })
  assert.match(alpine.plan.commands.find(item => item.id === 'verify-moodle').command, /setpriv --help 2>&1 \| grep -q -- --reuid/u)
  assert.match(alpine.plan.commands.find(item => item.id === 'verify-moodle').command, /else su -s \/bin\/sh/u)
  assert.equal(listCommonTasks({ category: 'application' }).some(task => task.id === 'moodle-linux'), true)
})
