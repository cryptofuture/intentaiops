import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { buildN8nTask, n8nRelease } from '../src/n8n-task.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const contexts = {
  debian: context('ubuntu', '24.04', 'debian', 'apt', 'systemd', {
    nginxService: 'nginx.service',
    nginxVhost: '/etc/nginx/sites-available/webminai-wordpress-18101.conf',
    nginxEnableLink: '/etc/nginx/sites-enabled/webminai-wordpress-18101.conf'
  }),
  alpine: context('alpine', '3.23', 'alpine', 'apk', 'openrc', {
    nginxService: 'nginx',
    nginxVhost: '/etc/nginx/http.d/webminai-wordpress-18101.conf'
  }),
  arch: context('arch', '', 'arch', 'pacman', 'systemd', {
    nginxService: 'nginx.service',
    nginxVhost: '/etc/nginx/conf.d/webminai-wordpress-18101.conf'
  }),
  rhel: context('almalinux', '9', 'rhel', 'dnf', 'systemd', {
    nginxService: 'nginx.service',
    nginxVhost: '/etc/nginx/conf.d/webminai-wordpress-18101.conf'
  }),
  suse: context('opensuse-leap', '16.0', 'suse', 'zypper', 'systemd', {
    nginxService: 'nginx.service',
    nginxVhost: '/etc/nginx/vhosts.d/webminai-wordpress-18101.conf'
  })
}

for (const [family, linuxContext] of Object.entries(contexts)) {
  test(`native n8n task uses the reviewed ${family} route and protects credentials`, () => {
    const built = buildN8nTask(42, linuxContext, { preferred: false })
    validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
    const commands = built.plan.commands.map(item => item.command).join('\n')
    assert.match(commands, /n8n@2\.33\.7/u)
    assert.match(commands, /WEBMINAI_N8N_OK/u)
    assert.match(commands, /N8N_ENCRYPTION_KEY/u)
    assert.match(commands, /\/root\/n8n_credentials\/encryption_key/u)
    assert.doesNotMatch(commands, /N8N_ENCRYPTION_KEY=[a-f0-9]{32,}/u)
    assert.equal(built.plan.commands.find(item => item.id === 'install-n8n').executionMode, 'job')
    assert.equal(built.plan.commands.find(item => item.id === 'install-n8n').timeoutMs, 3600000)
    assert.equal(built.plan.commands.find(item => item.id === 'install-runtime').timeoutMs, 1800000)
    const restore = built.plan.revertCommands.find(item => item.id === 'restore-packages').command
    assert.match(restore, /packages\.current/u)
    assert.match(restore, /comm -13/u)
    assert.match(built.verifyApplied, /database\.sqlite/u)
    assert.match(built.verifyReverted, /n8n_credentials/u)
    for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
      const checked = spawnSync('/bin/sh', ['-n', '-c', command.command], { encoding: 'utf8' })
      assert.equal(checked.status, 0, `${command.id}: ${checked.stderr}`)
    }
  })
}

test('native package routes avoid incompatible Node versions', () => {
  const alpine = buildN8nTask(1, contexts.alpine, { preferred: false }).plan.commands.find(item => item.id === 'install-runtime').command
  const arch = buildN8nTask(1, contexts.arch, { preferred: false }).plan.commands.find(item => item.id === 'install-runtime').command
  const suse = buildN8nTask(1, contexts.suse, { preferred: false }).plan.commands.find(item => item.id === 'install-runtime').command
  const debian = buildN8nTask(1, contexts.debian, { preferred: false }).plan.commands.find(item => item.id === 'install-runtime').command
  const rhel = buildN8nTask(1, contexts.rhel, { preferred: false }).plan.commands.find(item => item.id === 'install-runtime').command
  assert.match(alpine, /apk add[^;]+nodejs npm/u)
  assert.match(alpine, /build-base python3/u)
  assert.match(arch, /nodejs-lts-jod npm/u)
  assert.match(arch, /base-devel python/u)
  assert.doesNotMatch(arch, /pacman[^;]+ nodejs npm/u)
  assert.match(suse, /nodejs24 npm24/u)
  assert.match(suse, /gcc gcc-c\+\+ make python3/u)
  assert.match(debian, /deb\.nodesource\.com\/node_24\.x/u)
  assert.doesNotMatch(debian, /apt-get install -y nodejs npm/u)
  assert.match(rhel, /rpm\.nodesource\.com\/pub_24\.x/u)
  assert.match(rhel, /gcc gcc-c\+\+ make python3/u)
})

test('Arch n8n route explicitly approves and verifies the SQLite native binding', () => {
  const install = buildN8nTask(1, contexts.arch, { preferred: false }).plan.commands.find(item => item.id === 'install-n8n').command
  assert.match(install, /npm install-scripts approve sqlite3/u)
  assert.match(install, /node -e .*sqlite3/u)
  assert.match(install, /chmod -R a\+rX/u)
  const built = buildN8nTask(1, contexts.arch, { preferred: false })
  const configure = built.plan.commands.find(item => item.id === 'configure-services').command
  const baseline = built.plan.commands.find(item => item.id === 'capture-baseline').command
  const restore = built.plan.revertCommands.find(item => item.id === 'restore-packages').command
  assert.match(configure, /include \/etc\/nginx\/conf\.d\/\*\.conf/u)
  assert.match(baseline, /\/etc\/nginx\/nginx\.conf/u)
  assert.match(restore, /\/etc\/nginx\/nginx\.conf/u)
})

test('RPM n8n rollback filters already removed dependencies and absent nginx', () => {
  const restore = buildN8nTask(2, contexts.rhel, { preferred: false }).plan.revertCommands.find(item => item.id === 'restore-packages').command
  assert.match(restore, /rpm -q -- "\$package"/u)
  assert.match(restore, /systemctl cat 'nginx\.service'/u)
})

test('Compose n8n task uses protected secrets and persistent SQLite data', () => {
  const built = buildN8nTask(7, contexts.debian, { preferred: true, ready: true })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /docker\.n8n\.io\/n8nio\/n8n:2\.33\.7/u)
  assert.match(commands, /encryption_key: \{ file: \/root\/n8n_credentials\/encryption_key \}/u)
  assert.match(commands, /n8n_data:\/home\/node\/\.n8n/u)
  assert.match(commands, /user: root/u)
  assert.match(commands, /su -p -s \/bin\/sh node -c/u)
  assert.match(commands, /database\.sqlite/u)
  assert.match(commands, /NODE_OPTIONS: --max-old-space-size=384/u)
  assert.match(built.plan.commands.find(item => item.id === 'prepare-n8n-swap').command, /fallocate -l 1G/u)
  assert.deepEqual(built.plan.commands.find(item => item.id === 'start-compose').dependsOn, ['prepare-n8n-swap'])
  assert.match(built.plan.revertCommands.find(item => item.id === 'remove-n8n-swap').command, /swapoff/u)
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'verify-compose').command, /docker compose[^;]* restart/u)
  assert.doesNotMatch(built.verifyApplied, /\brestart\b/u)
  assert.doesNotMatch(commands, /N8N_ENCRYPTION_KEY=[a-f0-9]{32,}/u)
  for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
    const checked = spawnSync('/bin/sh', ['-n', '-c', command.command], { encoding: 'utf8' })
    assert.equal(checked.status, 0, `${command.id}: ${checked.stderr}`)
  }
})

test('n8n release is pinned', () => {
  assert.deepEqual(n8nRelease(), {
    version: '2.33.7',
    image: 'docker.n8n.io/n8nio/n8n:2.33.7',
    nginxImage: 'nginx:1.30.4-alpine'
  })
})

function context (id, versionId, family, packageManager, serviceManager, wordpress) {
  return {
    fingerprint: `${id}:${versionId}:x86_64`,
    identity: { id, versionId, architecture: 'x86_64' },
    management: { family, packageManager, serviceManager },
    applications: { wordpress }
  }
}
