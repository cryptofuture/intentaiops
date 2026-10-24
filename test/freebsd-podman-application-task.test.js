import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { buildFreebsdPodmanApplicationTask } from '../src/freebsd-podman-application-task.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { validateCommandPlan } from '../src/plan-validator.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execution = { platform: 'freebsd', architecture: 'amd64', freebsdVersion: '15.1-RELEASE-p6', docker: { ready: true } }

test('new FreeBSD Podman routes isolate native graphs and select Automatic only on qualified targets', () => {
  for (const release of ['14.4-RELEASE-p12', '15.1-RELEASE-p6']) {
    for (const [application, port] of [['ghost', 18110], ['n8n', 18109], ['mattermost', 18111], ['jellyfin', 18113]]) {
      const context = { ...execution, freebsdVersion: release, memoryBytes: 4294967296 }
      const built = buildFreebsdPodmanApplicationTask(application, 42, context)
      validateCommandPlan(built.plan, rootExecutionPolicy({}))
      assert.deepEqual(built.plan.modifiedFiles, [`/var/db/webminai/podman-42-${application}`])
      const create = built.plan.commands.find(command => command.id === 'create-podman-application').command
      assert.match(create, /--restart always/u)
      assert.ok(create.includes(`--publish ${port}:${port}`))
      assert.doesNotMatch(create, /--privileged|--network[= ]host|--device|podman.sock|sysvshm=inherit/u)
      assert.equal(create.includes('org.freebsd.jail.sysvshm=new'), application === 'mattermost')
      if (application === 'mattermost') assert.match(built.plan.commands.find(command => command.id === 'podman-install-mattermost-runtime').command, /mattermost-server-11\.7\.10_2/u)
      assert.equal(create.includes('--annotation org.freebsd.jail.allow.mlock=true --ulimit memlock=65536:65536'), application === 'jellyfin')
      if (application === 'jellyfin') {
        assert.match(create, /jls -j "\$jail_name" -n allow[.]mlock/u)
        assert.ok(create.includes('if eq .Name "RLIMIT_MEMLOCK"'))
        assert.ok(create.includes("= '65536 65536'"))
        assert.ok(built.plan.warnings.some(warning => warning.includes('64 KiB process limit')))
        const runtime = built.plan.commands.find(command => command.id === 'verify-podman-jellyfin-runtime')
        assert.match(runtime.command, /su -m jellyfin/u)
        assert.match(runtime.command, /jellyfin --version/u)
        assert.deepEqual(runtime.dependsOn, ['clean-podman-package-cache'])
        assert.deepEqual(built.plan.commands.find(command => command.id === 'podman-deploy-jellyfin').dependsOn, ['verify-podman-jellyfin-runtime'])
      }
      const restart = built.plan.commands.find(command => command.id === 'verify-podman-application-restart').command
      assert.ok(restart.includes('onestatus'))
      const source = built.plan.commands.find(command => command.id === `podman-install-${application}-application`)
      if (['ghost', 'n8n'].includes(application)) {
        const compiler = built.plan.commands.find(command => command.id === 'prepare-podman-build-dependencies')
        assert.equal(compiler.timeoutMs, 3600000)
        assert.equal(compiler.retry, undefined)
        assert.match(source.command, /INTENTAI_OPS_BUILD/u)
        assert.match(source.command, /export CC CXX/u)
        assert.deepEqual(source.dependsOn, ['verify-podman-build-linker'])
        assert.ok(built.plan.commands.some(command => command.id === 'clean-podman-build-cache' && command.command.includes('pnpm-store')))
        assert.ok(!built.plan.commands.some(command => command.id === 'verify-podman-openssl-development'))
      }
      if (application === 'ghost') {
        assert.doesNotMatch(source.command, /--header "Host:/u)
        assert.match(restart, /--header "Host: \$public_address:18110"/u)
      }
      if (application === 'n8n') {
        assert.equal(built.plan.commands.find(command => command.id === 'podman-install-n8n-runtime').timeoutMs, 3600000)
        const resolution = built.plan.commands.find(command => command.id === 'podman-resolve-n8n-dependencies')
        assert.equal(resolution.timeoutMs, 3600000)
        assert.equal(resolution.retry, undefined)
        assert.deepEqual(resolution.dependsOn, ['clean-podman-package-cache'])
        assert.deepEqual(built.plan.commands.find(command => command.id === 'prepare-podman-build-dependencies').dependsOn, [resolution.id])
        assert.equal(source.timeoutMs, 3600000)
        assert.equal(source.retry, undefined)
        assert.match(resolution.command, /--package-lock-only --ignore-scripts --save-exact/u)
        assert.match(source.command, /ci --ignore-scripts/u)
        assert.match(source.command, /--maxsockets=8/u)
        assert.match(source.command, /npm_config_jobs=1 MAKEFLAGS=-j1/u)
        assert.match(built.verifyApplied, /podman exec intentaiops-n8n-42 \/bin\/sh -c/u)
        assert.match(built.verifyApplied, /127[.]0[.]0[.]1:5678\/healthz/u)
      }
      for (const preference of ['auto', 'enabled', 'disabled']) {
        const plan = buildCommonTask(`${application}-freebsd`, 42, { platform: 'freebsd', freebsdExecution: context, docker: { preference } }).plan
        const qualified = ['jellyfin', 'n8n'].includes(application) || (['ghost', 'mattermost'].includes(application) && release.startsWith('15.1-'))
        assert.equal(plan.commands[0].id === 'prepare-podman-application', preference === 'enabled' || (preference === 'auto' && qualified))
      }
      for (const command of [...built.plan.commands, ...built.plan.revertCommands]) assert.equal(spawnSync('/bin/sh', ['-n', '-c', command.command]).status, 0, command.id)
    }
  }
})

test('n8n cold-build headroom checks the actual Podman storage before reserving resources', () => {
  const { plan } = buildFreebsdPodmanApplicationTask('n8n', 42, execution)
  assert.ok(plan.assumptions.some(assumption => assumption.includes('8 GiB')))
  const command = plan.commands[0].command
  const start = command.indexOf('storage_root=')
  const end = command.indexOf('for path in /var', start)
  assert.ok(start > 0 && end > start && end < command.indexOf('mkdir -m 0700'))
  const guard = command.slice(start, end)
  for (const [available, status, root, error] of [
    ['8388608', 0, '/fixture/podman data', null],
    ['8388607', 0, '/fixture/podman data', 'INSUFFICIENT_DISK'],
    ['-1', 0, '/fixture/podman data', 'INSUFFICIENT_DISK'],
    ['', 0, '/fixture/podman data', 'DISK_CAPACITY_UNAVAILABLE'],
    ['unknown', 0, '/fixture/podman data', 'DISK_CAPACITY_UNAVAILABLE'],
    ['9223372036854775808', 0, '/fixture/podman data', 'DISK_CAPACITY_UNAVAILABLE'],
    ['8388608', 1, '/fixture/podman data', 'DISK_CAPACITY_UNAVAILABLE'],
    ['8388608', 0, 'denied', 'DISK_CAPACITY_UNAVAILABLE'],
    ['8388608', 0, 'relative', 'DISK_CAPACITY_UNAVAILABLE']
  ]) {
    const fixture = `podman () { [ '${root}' != denied ] || return 1; printf '%s\\n' '${root}'; }; df () { [ "$1" = -kP ] && [ "$2" = '${root}' ] || exit 96; printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 99999999 0 %s 0%% /fixture\\n' '${available}'; return ${status}; }; `
    const result = spawnSync('/bin/sh', ['-c', 'set -eu; ' + fixture + guard + 'printf ready'], { encoding: 'utf8' })
    assert.equal(result.status, error ? 78 : 0, result.stderr)
    if (error) assert.ok(result.stderr.includes(error), result.stderr)
    else assert.equal(result.stdout, 'ready')
  }
  assert.ok(!buildFreebsdPodmanApplicationTask('ghost', 42, execution).plan.commands[0].command.includes('storage_root='))
})

for (const [application, services] of [['magento', ['webminai_magento_mysql', 'opensearch', 'valkey', 'php_fpm', 'cron', 'nginx']], ['odoo', ['webminai_odoo_postgresql', 'webminai_odoo', 'nginx']], ['home-assistant', ['webminai_home_assistant', 'nginx']], ['jellyfin', ['jellyfin', 'nginx']]]) {
  test(`${application} container restart waits for every service before native verification`, () => {
    const built = buildFreebsdPodmanApplicationTask(application, 42, execution)
    const restart = built.plan.commands.find(command => command.id === 'verify-podman-application-restart').command
    const gate = restart.match(/\/bin\/sh -c '(ready=;[^']+)'/u)?.[1]
    assert.ok(gate)
    assert.ok(restart.indexOf('podman restart ') < restart.indexOf(gate))
    assert.ok(restart.indexOf(gate) < restart.lastIndexOf(' /bin/sh -c '))
    for (const service of services) assert.ok(gate.includes(`service ${service} onestatus`))
    if (application === 'magento') assert.match(gate, /test -S \/var\/db\/webminai-magento-18108\/php-run\/php-fpm[.]sock/u)
    if (application === 'jellyfin') assert.match(gate, /curl .*--max-time 3 http:\/\/127[.]0[.]0[.]1:8096\/health/u)
    for (const available of ['yes', 'no']) {
      const fixture = `available=${available}; round=0; jot () { printf '1\\n2\\n3\\n'; }; sleep () { round=$((round+1)); }; service () { [ "$2" = onestatus ] && [ "$available" = yes ] && [ "$round" -ge 2 ]; }; test () { [ "$1" = -S ] && return 0; command test "$@"; }; `
      const httpFixture = application === 'jellyfin' ? 'service () { [ "$2" = onestatus ] && [ "$available" = yes ]; }; curl () { [ "$round" -ge 2 ]; }; ' : ''
      const result = spawnSync('/bin/sh', ['-c', 'set -eu; ' + fixture + httpFixture + gate + '; printf "round=%s" "$round"'], { encoding: 'utf8' })
      assert.equal(result.status === 0, available === 'yes', result.stderr)
      if (available === 'yes') assert.equal(result.stdout, 'round=2')
    }
  })
}

test('Magento loopback health uses its public Host and exposes only public asset directories to nginx', () => {
  const built = buildCommonTask('magento-freebsd', 42, { platform: 'freebsd', freebsdExecution: execution, docker: { preference: 'disabled' } })
  const initialize = built.plan.commands.find(command => command.id === 'initialize-magento').command
  assert.match(built.plan.commands.find(command => command.id === 'configure-magento-runtime').command, /http \{ include \/usr\/local\/etc\/nginx\/mime[.]types; upstream/u)
  assert.match(initialize, /for public_path in '[^']+\/pub\/static' '[^']+\/pub\/media'; do test ! -L "\$public_path"; chgrp www "\$public_path"; chmod g\+rx "\$public_path"; done/u)
  assert.doesNotMatch(initialize, /chgrp -R|chmod 0777/u)
  const start = initialize.lastIndexOf('address=$(printenv WEBMINAI_PUBLIC_ADDRESS')
  const end = initialize.lastIndexOf('; : >')
  assert.ok(start > 0 && end > start)
  const wait = initialize.slice(start, end)
  const fixture = 'jot () { printf 1; }; sleep () { :; }; curl () { header=; output=; while [ "$#" -gt 0 ]; do case "$1" in --header) header=$2; shift 2;; --output) output=$2; shift 2;; *) shift;; esac; done; test "$header" = "Host: 192.0.2.31:18108" || return 97; printf WEBMINAI_MAGENTO_OK > "$output"; }; '
  const result = spawnSync('/bin/sh', ['-c', 'set -eu; ' + fixture + wait], { encoding: 'utf8', env: { ...process.env, WEBMINAI_PUBLIC_ADDRESS: '192.0.2.31' } })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(built.plan.commands.find(command => command.id === 'verify-magento').command.includes('--header "Host: $address:18108"'))
})

test('Ghost readiness allows observed cold rendering without exceeding its command budget', () => {
  const built = buildCommonTask('ghost-freebsd', 42, { platform: 'freebsd', freebsdExecution: execution, docker: { preference: 'disabled' } })
  const configure = built.plan.commands.find(command => command.id === 'configure-ghost')
  const wait = configure.command.match(/ready=; for attempt in \$\(jot 60\);[\s\S]*?\[ "\$ready" = yes \]/u)?.[0]
  assert.ok(wait)
  const fixture = 'jot () { printf 1; }; sleep () { :; }; curl () { limit=; while [ "$#" -gt 0 ]; do case "$1" in --max-time) limit=$2; shift 2;; *) shift;; esac; done; test "$limit" -ge 10; }; '
  assert.equal(spawnSync('/bin/sh', ['-c', 'set -eu; ' + fixture + wait]).status, 0)
  assert.ok(60 * (10 + 2) * 1000 < configure.timeoutMs)
  const wrapped = buildFreebsdPodmanApplicationTask('ghost', 42, execution)
  for (const id of ['podman-configure-ghost', 'podman-verify-ghost', 'verify-podman-application-restart']) assert.ok(wrapped.plan.commands.find(command => command.id === id).command.includes('--max-time 10'))
})

test('14.4 application candidates use the observed lean-base utilities and matching development packages', () => {
  for (const application of ['odoo', 'home-assistant', 'magento']) {
    const built = buildFreebsdPodmanApplicationTask(application, 42, { ...execution, freebsdVersion: '14.4-RELEASE-p12' })
    validateCommandPlan(built.plan, rootExecutionPolicy({}))
    const base = built.plan.commands.find(command => command.id === 'build-podman-application-base').command
    assert.match(base, /FROM ghcr[.]io\/freebsd\/freebsd-runtime:14[.]4/u)
    assert.match(base, /pkg install -y -r FreeBSD-base FreeBSD-utilities/u)
    for (const utility of ['chown', 'su', 'pw', 'service']) assert.ok(base.includes(`command -v ${utility}`))
    assert.match(base, /podman build --no-hosts --label/u)
    assert.doesNotMatch(base, /signature_type|fingerprints|--no-check|pkg upgrade/u)
    if (application !== 'magento') {
      const source = built.plan.commands.find(command => command.id === 'prepare-podman-source-libraries').command
      assert.match(source, /FreeBSD-libbsm-dev/u)
      assert.match(source, /FreeBSD-runtime-dev/u)
      assert.doesNotMatch(source, /FreeBSD-audit-dev|FreeBSD-zlib-dev/u)
      const tls = built.plan.commands.find(command => command.id === 'verify-podman-openssl-development').command
      assert.match(tls, /FreeBSD-openssl-lib-dev/u)
      assert.doesNotMatch(tls, /'FreeBSD-openssl-dev'/u)
    }
    assert.equal(built.plan.warnings.some(warning => warning.includes('pending live qualification')), false)
  }
})

test('Magento runtime reconciliation verifies packages without reinstalling or changing services', async t => {
  const built = buildCommonTask('magento-freebsd', 42, { platform: 'freebsd', freebsdExecution: execution, docker: { preference: 'disabled' } })
  assert.doesNotMatch(built.verifyRuntime, /pkg (?:install|add|delete)\b|(?:^|[; ])(?:rm|curl|service)\s/u)
  assert.match(built.verifyRuntime, /pkg check -d -n/u)
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-magento-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['packages.before', 'packages.after', 'packages.added']) await writeFile(path.join(root, name), 'fixture\n', { mode: 0o600 })
  const command = built.verifyRuntime.replaceAll('/var/lib/webminai/task-state/42-magento-freebsd', root).replaceAll('/usr/local/libexec/mariadbd', 'mariadbd').replaceAll('/usr/local/lib/opensearch/bin/opensearch', 'opensearch').replaceAll('valkey-server', 'valkey')
  const fixture = 'stat () { case "$2" in \'%u:%Lp\') printf \'0:700\';; \'%u\') printf 0;; *) return 99;; esac; }; pkg () { case "$1" in info) test "$3" != "$missing";; check) test "$dependencies" = yes;; query) printf \'1.30.6,3\';; version) printf \'%s\' "$comparison";; *) return 99;; esac; }; php () { return 0; }; composer () { printf \'Composer version 2.10.1\'; }; mariadbd () { printf \'MariaDB 11.4.8\'; }; opensearch () { printf \'Version: 2.19.6\'; }; valkey () { printf \'Valkey server v=8.1.3\'; }; '
  for (const [missing, dependencies, comparison] of [['', 'yes', '='], ['', 'yes', '>'], ['php84-soap', 'yes', '='], ['', 'no', '='], ['', 'yes', '<'], ['', 'yes', '?']]) {
    const result = spawnSync('/bin/sh', ['-c', `missing='${missing}'; dependencies='${dependencies}'; comparison='${comparison}'; ` + fixture + command + '; printf VERIFIED'], { encoding: 'utf8' })
    assert.equal(result.status === 0, !missing && dependencies === 'yes' && ['=', '>'].includes(comparison), result.stderr)
    assert.equal(result.stdout.includes('VERIFIED'), result.status === 0)
  }
  await rm(path.join(root, 'packages.before'))
  await symlink(path.join(root, 'packages.after'), path.join(root, 'packages.before'))
  const unsafe = spawnSync('/bin/sh', ['-c', "missing=; dependencies=yes; comparison='='; " + fixture + command], { encoding: 'utf8' })
  assert.notEqual(unsafe.status, 0)
  const podman = buildFreebsdPodmanApplicationTask('magento', 42, execution)
  assert.match(podman.verifyRuntime, /io[.]intentaiops[.]owner/u)
  assert.match(podman.verifyRuntime, /podman exec/u)
  assert.doesNotMatch(podman.verifyRuntime, /pkg (?:install|add|delete)|\brm\b/u)
  validateCommandPlan({ ...podman.plan, commands: [{ id: 'verify-acquired-magento-runtime', command: podman.verifyRuntime, purpose: 'Verify the acquired runtime without repeating installation', risk: 'read', timeoutMs: 300000, executionMode: 'job', requiresSudo: true, dependsOn: [] }], revertCommands: [] }, rootExecutionPolicy({}), { requireRevert: false })
})

test('Home Assistant blocks public onboarding mutations on both aliases and initializes privately', () => {
  const built = buildCommonTask('home-assistant-freebsd', 42, { platform: 'freebsd', freebsdExecution: execution, docker: { preference: 'disabled' } })
  const config = built.plan.commands.find(item => item.id === 'configure-home-assistant').command
  assert.ok(config.includes('server_host: 127.0.0.1\n  server_port: 8123'))
  const pattern = config.match(/location ~ ([^ ]+) \{ return 403; \}/u)?.[1]
  assert.ok(pattern)
  const blocked = new RegExp(pattern)
  for (const path of ['/api/onboarding/users', '/homeassistant/api/onboarding/users', '/api/onboarding/core_config', '/homeassistant/api/onboarding/analytics']) assert.equal(blocked.test(path), true)
  for (const path of ['/api/onboarding', '/auth/token', '/api/', '/']) assert.equal(blocked.test(path), false)
  const initialize = built.plan.commands.find(item => item.id === 'initialize-home-assistant').command
  assert.ok(initialize.includes('http://127.0.0.1:8123/api/onboarding/users'))
  assert.ok(initialize.includes('http://127.0.0.1:8123/auth/token'))
  assert.ok(!initialize.includes('http://127.0.0.1:18115/'))
  assert.ok(built.plan.warnings.includes('FFmpeg/media integrations are not installed or validated by this route.'))
})

test('Home Assistant scopes the static XZ header fix to uv and preserves assembly builds', async t => {
  const built = buildCommonTask('home-assistant-freebsd', 42, { platform: 'freebsd', freebsdExecution: execution, docker: { preference: 'disabled' } })
  const command = built.plan.commands.find(item => item.id === 'install-home-assistant-application').command
  assert.match(command, /CFLAGS="\$CFLAGS -include \$uv_header" pip install[^;]+ 'uv==0[.]11[.]31'/u)
  assert.match(command, /LDSHARED="\$CC -pthread -shared -L\/usr\/local\/lib"/u)
  assert.doesNotMatch(command, /-Wno-implicit-function-declaration|--no-check-certificate/u)
  const cleanup = "rm -rf -- '/usr/local/lib/webminai-home-assistant-18115/tests'"
  assert.ok(command.indexOf(cleanup) > command.indexOf('sha256 -q'))
  assert.ok(command.indexOf(cleanup) > command.indexOf('tar -xzf'))
  assert.ok(command.includes("test ! -L '/usr/local/lib/webminai-home-assistant-18115/tests'"))
  assert.ok(command.indexOf(cleanup) < command.indexOf('python3.14 -m venv'))
  const header = command.match(/printf '(#ifndef __ASSEMBLER__[^']+)' > "\$uv_header"/u)?.[1]
  assert.equal(header, '#ifndef __ASSEMBLER__\n#include <sys/time.h>\n#endif\n')
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-uv-header-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'compat.h')
  await writeFile(file, header)
  const compiler = spawnSync('/bin/sh', ['-c', 'command -v cc'], { encoding: 'utf8' }).stdout.trim()
  const shared = path.join(root, 'link-probe.so')
  const link = spawnSync('/bin/sh', ['-c', 'set -eu; cc() { return 97; }; CC="$1"; LDSHARED="$CC -pthread -shared -L/usr/local/lib"; printf "int intent_link_probe(void){return 0;}\\n" | $LDSHARED -x c - -o "$2"', 'probe', compiler, shared], { encoding: 'utf8' })
  assert.equal(link.status, 0, link.stderr)
  assert.ok((await readFile(shared)).length > 0)
  await rm(shared)
  for (const [args, input] of [
    [['-std=c99', '-Werror=implicit-function-declaration', '-x', 'c', '-fsyntax-only', '-'], 'int main(void){struct timeval now; return gettimeofday(&now, 0);}\n'],
    [['-x', 'assembler-with-cpp', '-c', '-', '-o', '/dev/null'], '.text\n']
  ]) {
    const result = spawnSync('cc', ['-include', file, ...args], { input, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const start = command.indexOf('uv_header=$(mktemp')
  const end = command.indexOf('; pip install --disable-pip-version-check --no-input -r', start)
  assert.ok(start > 0 && end > start)
  const uv = command.slice(start, end).replaceAll('/var/lib/webminai/task-state/42-home-assistant-freebsd', root).replaceAll('"$CC"', 'cc')
  for (const status of [0, 13]) {
    const result = spawnSync('/bin/sh', ['-c', `set -eu; CFLAGS=; pip() { return ${status}; }; ${uv}`], { encoding: 'utf8' })
    assert.equal(result.status, status, result.stderr)
    assert.deepEqual(await readdir(root), ['compat.h'], 'Temporary compatibility headers are removed on success and failure')
  }
})

test('private build cache cleanup rejects symlinks before deletion and preserves evidence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-build-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = path.join(root, 'state')
  const outside = path.join(root, 'outside')
  for (const directory of [state, outside, path.join(state, 'cargo'), path.join(state, 'pip-cache')]) await mkdir(directory)
  await writeFile(path.join(outside, 'keep'), 'unrelated')
  await writeFile(path.join(state, 'application-build.saved'), 'evidence')
  await writeFile(path.join(state, 'credentials'), 'protected fixture')
  await writeFile(path.join(state, 'rust-private-ready'), '')
  await symlink(outside, path.join(state, 'rustup'))
  const built = buildFreebsdPodmanApplicationTask('odoo', 42, execution)
  const command = built.plan.commands.find(item => item.id === 'clean-podman-build-cache').command
  const encoded = command.slice(command.indexOf(' /bin/sh -c ') + ' /bin/sh -c '.length)
  const inner = encoded.slice(1, -1).replaceAll("'\\''", "'").replaceAll('/var/lib/webminai/task-state/42-odoo-freebsd', state)
  const run = () => spawnSync('/bin/sh', ['-c', 'stat() { if [ "$2" = "%u:%Lp" ]; then printf 0:700; else printf 0; fi; }; ' + inner], { encoding: 'utf8' })
  assert.notEqual(run().status, 0)
  assert.ok((await readdir(state)).includes('cargo'), 'Unsafe cache path blocks every deletion')
  await rm(path.join(state, 'rustup'))
  await mkdir(path.join(state, 'rustup'))
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual((await readdir(state)).sort(), ['application-build.saved', 'credentials'])
  assert.equal(await readFile(path.join(state, 'application-build.saved'), 'utf8'), 'evidence')
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'unrelated')
})

test('native web frontends proxy absolute asset and websocket paths without hiding the application root', () => {
  for (const [application, port] of [['odoo', 8069], ['home-assistant', 8123]]) {
    const built = buildCommonTask(`${application}-freebsd`, 42, { platform: 'freebsd', freebsdExecution: execution, docker: { preference: 'disabled' } })
    const config = built.plan.commands.find(command => command.id === `configure-${application}`).command
    assert.ok(config.includes('location = /__intentaiops-health'))
    assert.ok(config.includes(`location / { proxy_pass http://127.0.0.1:${port};`))
    assert.ok(config.includes('proxy_set_header Upgrade $http_upgrade'))
    assert.ok(config.includes('proxy_set_header Connection $connection_upgrade'))
    assert.ok(built.verifyApplied.includes('/__intentaiops-health'))
    assert.doesNotMatch(config, /location = \/ \{ default_type/u)
  }
})

for (const application of ['odoo', 'home-assistant', 'magento']) {
  test(`${application} Podman preserves native steps and isolates all package changes`, () => {
    const native = buildCommonTask(`${application}-freebsd`, 42, { platform: 'freebsd', freebsdExecution: execution, docker: { preference: 'disabled' } })
    const built = buildFreebsdPodmanApplicationTask(application, 42, execution)
    validateCommandPlan(built.plan, rootExecutionPolicy({}))
    for (const step of native.plan.commands) {
      const wrapped = built.plan.commands.find(item => item.id === `podman-${step.id}`)
      assert.ok(wrapped)
      assert.equal(wrapped.risk, step.risk)
      assert.equal(wrapped.timeoutMs, step.timeoutMs)
      assert.equal(wrapped.executionMode, 'job')
      assert.match(wrapped.command, /container inspect.*io.intentaiops.owner/u)
      assert.match(wrapped.command, /podman exec (?:--env WEBMINAI_PUBLIC_ADDRESS="\$public_address" )?intentaiops-/u)
      assert.ok(wrapped.command.endsWith("'"))
    }
    assert.deepEqual(built.plan.modifiedFiles, [`/var/db/webminai/podman-42-${application}`])
    assert.match(built.plan.commands.find(item => item.id === 'build-podman-application-base').command, /RUN chmod 0755 \/ &&/u)
    const cache = built.plan.commands.find(item => item.id === 'clean-podman-package-cache')
    assert.deepEqual(cache.dependsOn, [`podman-install-${application}-runtime`])
    assert.match(cache.command, /podman exec .*'pkg clean -a -y'$/u)
    const dependencies = built.plan.commands.find(item => item.id === 'prepare-podman-build-dependencies')
    if (application === 'magento') assert.equal(dependencies, undefined)
    else {
      assert.deepEqual(dependencies.dependsOn, [`podman-install-${application}-build-toolchain`])
      assert.match(dependencies.command, /FreeBSD-clibs-dev/u)
      assert.match(dependencies.command, /-fsyntax-only/u)
      const linker = built.plan.commands.find(item => item.id === 'verify-podman-build-linker')
      assert.deepEqual(linker.dependsOn, [dependencies.id])
      assert.match(linker.command, /FreeBSD-libcompiler_rt-dev/u)
      assert.match(linker.command, /mktemp/u)
      assert.match(linker.command, /-std=c[+][+]17/u)
      const libraries = built.plan.commands.find(item => item.id === 'prepare-podman-source-libraries')
      assert.deepEqual(libraries.dependsOn, [linker.id])
      for (const name of ['FreeBSD-audit-dev', 'FreeBSD-utilities-dev', 'FreeBSD-zlib-dev']) assert.ok(libraries.command.includes(name))
      if (application === 'odoo') assert.match(libraries.command, /pkg-config --exists libxml-2.0 libxslt/u)
      const systemLibraries = built.plan.commands.find(item => item.id === 'verify-podman-system-libraries')
      assert.deepEqual(systemLibraries.dependsOn, [libraries.id])
      assert.match(systemLibraries.command, /FreeBSD-libexecinfo-dev/u)
      assert.match(systemLibraries.command, /FreeBSD-runtime-dev/u)
      assert.match(systemLibraries.command, /-lutil -lkvm -lmemstat -lprocstat -ldevstat -lz/u)
      const openssl = built.plan.commands.find(item => item.id === 'verify-podman-openssl-development')
      assert.deepEqual(openssl.dependsOn, [systemLibraries.id])
      assert.match(openssl.command, /FreeBSD-openssl-dev/u)
      assert.match(openssl.command, /OPENSSL_init_ssl/u)
      assert.match(openssl.command, /pkg-config --cflags --libs openssl/u)
      assert.deepEqual(built.plan.commands.find(item => item.id === `podman-install-${application}-application`).dependsOn, [openssl.id])
      const clean = built.plan.commands.find(item => item.id === 'clean-podman-build-cache')
      assert.deepEqual(clean.dependsOn, [`podman-install-${application}-application`])
      assert.match(clean.command, /for name in cargo rustup pip-cache/u)
      assert.ok(clean.command.indexOf('test ! -L "$path"') < clean.command.indexOf('rm -rf --'))
      assert.doesNotMatch(clean.command, /rm[^;]*(?:application-build|credentials|\/usr\/local|\/root)/u)
      const next = application === 'odoo' ? 'podman-initialize-odoo-database' : 'podman-configure-home-assistant'
      assert.ok(built.plan.commands.find(item => item.id === next).dependsOn.includes(clean.id))
    }
    const create = built.plan.commands.find(item => item.id === 'create-podman-application').command
    if (application === 'odoo') {
      assert.match(create, /--annotation org.freebsd.jail.sysvshm=new/u)
      assert.match(create, /index .Config.Annotations "org.freebsd.jail.sysvshm"/u)
    } else assert.doesNotMatch(create, /--annotation/u)
    assert.doesNotMatch(create, /sysvshm=inherit|allow.sysvipc|--ipc[= ]host/u)
    assert.doesNotMatch(create, /--privileged|--network[= ]host|--device|--volume ['"]?\/dev\/|podman.sock/u)
    assert.match(create, /--volume '[^']+\/credentials:\/root\/[a-z_]+_credentials'/u)
    const remove = built.plan.revertCommands[0].command
    assert.doesNotMatch(built.verifyApplied, /podman exec/u)
    assert.match(built.verifyApplied, /curl/u)
    assert.ok(built.verifyApplied.includes(`podman port intentaiops-${application}-42 ${application === 'odoo' ? 18112 : application === 'home-assistant' ? 18115 : 18108}/tcp`))
    assert.match(built.verifyApplied, /--noproxy '\*' --connect-to "\$address:[0-9]+:10\.89\.[0-9]+\.3:[0-9]+"/u)
    assert.match(built.plan.commands.at(-1).purpose, /external reachability requires a client-side check/u)
    assert.equal(built.plan.commands.at(-1).id, 'verify-podman-published-http')
    assert.equal(built.plan.commands.at(-1).command, built.verifyApplied)
    if (application === 'magento') assert.match(built.plan.commands.find(item => item.id === 'podman-initialize-magento').command, /WEBMINAI_PUBLIC_ADDRESS/u)
    assert.ok(remove.indexOf('container inspect') < remove.indexOf('podman rm'))
    assert.ok(remove.indexOf('network inspect') < remove.indexOf('podman rm'))
    assert.ok(remove.indexOf('image inspect') < remove.indexOf('podman rm'))
    assert.doesNotMatch(remove, /pkg delete|pw userdel|\/usr\/local\/etc|podman (?:container |image |system )?prune/u)
    for (const command of [...built.plan.commands, ...built.plan.revertCommands, { command: built.verifyApplied }, { command: built.verifyReverted }]) {
      const result = spawnSync('/bin/sh', ['-n'], { input: command.command, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
  })

  test(`${application} selects Automatic only after target-specific qualification`, () => {
    for (const preference of ['auto', 'disabled', 'enabled']) {
      const built = buildCommonTask(`${application}-freebsd`, 42, { platform: 'freebsd', freebsdExecution: execution, docker: { preference, preferred: preference !== 'disabled' } })
      assert.equal(built.plan.commands[0].id === 'prepare-podman-application', preference !== 'disabled')
    }
  })
}

test('Automatic retains native applications on unqualified or unavailable Podman targets', () => {
  for (const context of [{ ...execution, freebsdVersion: '15.2-RELEASE' }, { ...execution, architecture: 'aarch64' }, { ...execution, docker: {} }, { ...execution, docker: { ready: true, hostIsContainer: true } }]) {
    for (const application of ['odoo', 'home-assistant', 'magento', 'n8n']) {
      const built = buildCommonTask(`${application}-freebsd`, 42, { platform: 'freebsd', freebsdExecution: context, docker: { preference: 'auto' } })
      assert.equal(built.plan.commands[0].id, `prepare-${application}`)
    }
  }
})

test('14.4 Automatic selects only its independently qualified applications', () => {
  for (const application of ['odoo', 'home-assistant', 'magento']) {
    for (const preference of ['auto', 'enabled', 'disabled']) {
      const built = buildCommonTask(`${application}-freebsd`, 42, { platform: 'freebsd', freebsdExecution: { ...execution, freebsdVersion: '14.4-RELEASE-p12' }, docker: { preference } })
      assert.equal(built.plan.commands[0].id === 'prepare-podman-application', preference !== 'disabled')
    }
  }
})

test('Podman applications reject untrusted names, unknown versions, nested jails and missing runtimes', () => {
  for (const [application, id, context] of [
    ['__proto__', 42, execution],
    ['odoo;true', 42, execution],
    ['odoo', '../42', execution],
    ['odoo', 42, { ...execution, platform: 'linux' }],
    ['odoo', 42, { ...execution, freebsdVersion: undefined }],
    ['odoo', 42, { ...execution, freebsdVersion: '14.3-RELEASE' }],
    ['odoo', 42, { ...execution, architecture: 'aarch64' }],
    ['odoo', 42, { ...execution, docker: { ready: true, hostIsContainer: true } }],
    ['odoo', 42, { ...execution, docker: {} }]
  ]) assert.throws(() => buildFreebsdPodmanApplicationTask(application, id, context))
  const older = buildFreebsdPodmanApplicationTask('odoo', 42, { ...execution, freebsdVersion: '14.4-RELEASE-p5' })
  assert.match(older.plan.commands[1].command, /freebsd-runtime:14[.]4/u)
})

test('Podman existence errors and occupied resources fail closed instead of authorizing cleanup', () => {
  const built = buildFreebsdPodmanApplicationTask('odoo', 42, execution)
  for (const status of [0, 1, 125]) {
    const result = spawnSync('/bin/sh', ['-c', `podman() { return ${status}; }; ${built.verifyReverted}; printf AUTHORIZED`], { encoding: 'utf8' })
    assert.equal(result.status === 0, status === 1)
    assert.equal(result.stdout.includes('AUTHORIZED'), status === 1)
  }
})

test('foreign labels and unavailable ownership inspection block command dispatch', () => {
  const command = buildFreebsdPodmanApplicationTask('odoo', 42, execution).plan.commands.find(item => item.id === 'podman-prepare-odoo').command
  const guard = command.slice(command.indexOf('test "$(podman container inspect'), command.indexOf('; podman exec'))
  assert.ok(guard.startsWith('test '))
  for (const [label, status] of [['expected', 0], ['foreign', 0], ['', 125]]) {
    const script = `set -eu; owner=expected; podman() { printf '%s' '${label}'; return ${status}; }; ${guard}; printf DISPATCHED`
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
    assert.equal(result.status === 0, label === 'expected')
    assert.equal(result.stdout.includes('DISPATCHED'), label === 'expected')
  }
})

test('Magento uses a validated published host address instead of its private jail address', () => {
  const native = buildCommonTask('magento-freebsd', 42, { platform: 'freebsd', freebsdExecution: execution, docker: { preference: 'disabled' } })
  const preflight = native.verifyApplied.slice(0, native.verifyApplied.indexOf('; curl'))
  for (const [address, valid] of [['192.168.122.31', true], ['256.0.0.1', false], ['1.2.3', false], ['1.2.3.0000', false], ['127.0.0.1; false', false]]) {
    const result = spawnSync('/bin/sh', ['-c', preflight + '; printf ACCEPTED'], { encoding: 'utf8', env: { ...process.env, WEBMINAI_PUBLIC_ADDRESS: address } })
    assert.equal(result.status === 0, valid)
    assert.equal(result.stdout.includes('ACCEPTED'), valid)
  }
})

test('native source acquisition retries transient downloads without dropping archive verification', () => {
  for (const application of ['odoo', 'home-assistant', 'magento']) {
    const built = buildCommonTask(`${application}-freebsd`, 42, { platform: 'freebsd', freebsdExecution: execution, docker: { preference: 'disabled' } })
    const acquisition = built.plan.commands.find(item => item.command.includes('curl --fail --location') && item.command.includes('https://github.com/'))
    assert.ok(acquisition)
    assert.match(acquisition.command, /--retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 30/u)
    assert.ok(acquisition.command.indexOf('sha256 -q') < acquisition.command.indexOf('tar -xzf'))
    assert.doesNotMatch(acquisition.command, /--insecure/u)
  }
})

test('reviewed container continuation reuses only the expected image, mounts, ports and network', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intentaiops-podman-'))
  try {
    await mkdir(path.join(directory, 'credentials'), { mode: 0o700 })
    await writeFile(path.join(directory, 'owner'), 'a'.repeat(64) + '\n', { mode: 0o600 })
    const built = buildFreebsdPodmanApplicationTask('odoo', 42, execution)
    const command = built.plan.commands.find(item => item.id === 'create-podman-application').command.replaceAll('/var/db/webminai/podman-42-odoo', directory)
    assert.match(command, /--restart always/u)
    for (const mismatch of ['', 'image', 'mount', 'port', 'network', 'privileged', 'ipc', 'restart']) {
      const mock = `
stat() {
  if [ "$2" = '%u' ]; then printf 0;
  elif [ "$3" = '${directory}/owner' ]; then printf '0:600';
  else printf '0:700'; fi
}
podman() {
  case "$1:$2" in
    network:exists|container:exists) return 0;;
    image:inspect)
      case "$4" in *Labels*) printf '%064d' 0 | tr 0 a;; *) printf image-id;; esac;;
    network:inspect)
      case "$4" in *Labels*) printf '%064d' 0 | tr 0 a;; *) printf '10.89.112.0/24 10.89.112.1';; esac;;
    container:inspect)
      case "$4" in
        *Labels*) printf '%064d' 0 | tr 0 a;;
        *Annotations*) if [ '${mismatch}' = ipc ]; then printf inherit; else printf new; fi;;
        *Privileged*) if [ '${mismatch}' = privileged ]; then printf true; else printf false; fi;;
        *RestartPolicy*) if [ '${mismatch}' = restart ]; then printf unless-stopped; else printf always; fi;;
        *Mounts*Source*) if [ '${mismatch}' = mount ]; then printf /foreign; else printf '${directory}/credentials'; fi;;
        *Mounts*Destination*) printf /root/odoo_credentials;;
        *HostPort*) if [ '${mismatch}' = port ]; then printf 1234; else printf 18112; fi;;
        *Networks*) if [ '${mismatch}' = network ]; then printf foreign; else printf 'intentaiops-odoo-42 10.89.112.3'; fi;;
        *len*) printf 1;;
        *Running*) printf true;;
        *Image*) if [ '${mismatch}' = image ]; then printf foreign; else printf image-id; fi;;
        *) return 125;;
      esac;;
    exec:--user) printf NONROOT_PROBED;;
    exec:intentaiops-odoo-42) printf ROOT_NORMALIZED;;
    *) printf UNEXPECTED_MUTATION >&2; return 125;;
  esac
}
`
      const result = spawnSync('/bin/sh', ['-c', mock + command], { encoding: 'utf8' })
      assert.equal(result.status === 0, mismatch === '', result.stderr)
      assert.equal(result.stdout.includes('ROOT_NORMALIZED'), mismatch === '')
      assert.equal(result.stdout.includes('NONROOT_PROBED'), mismatch === '')
      assert.doesNotMatch(result.stderr, /UNEXPECTED_MUTATION/u)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
