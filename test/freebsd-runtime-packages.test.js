import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCommonTask, commonTaskEligibility } from '../src/common-tasks.js'
import { validateCommandPlan } from '../src/plan-validator.js'
import { freebsdContainerImages } from '../src/freebsd-php-runtime.js'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { freebsdMariaDbReadyCommand } from '../src/freebsd-wordpress-task.js'
import { freebsdNginxSecurityCommand } from '../src/freebsd-nginx-security.js'
import { freebsdInstallMissingPackages, freebsdInstallCompilerIfMissing, freebsdCompilerEnvironment, freebsdSourceCompilerEnvironment, freebsdBuildLog } from '../src/freebsd-runtime-packages.js'

test('source builds select versioned LLVM archive tools without altering system tools', () => {
  for (const mode of ['system', 'llvm19', 'missing-archive']) {
    const fixture = `command() { case "$2" in cc|c++) printf '/usr/bin/%s' "$2"; return 0;; ar|ranlib|nm|strip|ld) if [ '${mode}' = system ]; then printf '/usr/bin/%s' "$2"; return 0; fi;; llvm-ar19|llvm-ranlib19|llvm-nm19|llvm-strip19|ld.lld19) if [ '${mode}' = llvm19 ]; then printf '/usr/local/bin/%s' "$2"; return 0; fi;; esac; return 1; }; `
    const result = spawnSync('/bin/sh', ['-c', 'set -eu; ' + fixture + freebsdSourceCompilerEnvironment() + '; printf "%s|%s|%s" "$AR" "$RANLIB" "$LD"'], { encoding: 'utf8' })
    if (mode === 'missing-archive') {
      assert.equal(result.status, 78)
      assert.match(result.stderr, /BUILD_ARCHIVER_UNAVAILABLE/u)
    } else {
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, mode === 'system' ? '/usr/bin/ar|/usr/bin/ranlib|/usr/bin/ld' : '/usr/local/bin/llvm-ar19|/usr/local/bin/llvm-ranlib19|/usr/local/bin/ld.lld19')
    }
  }
})

test('private build logs retain separate attempts, bounded error tails and child errexit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-freebsd-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = '/var/lib/webminai/task-state/9-odoo-freebsd'
  const failure = "i=0; while [ $i -lt 200 ]; do printf '%080d\\n' 0; i=$((i+1)); done; printf ACTUAL_COMPILER_ERROR >&2; false; printf UNEXPECTED_AFTER_FAILURE"
  const failed = spawnSync('/bin/sh', ['-c', freebsdBuildLog(state, failure).replaceAll(state, root)], { encoding: 'utf8' })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /ACTUAL_COMPILER_ERROR/u)
  assert.doesNotMatch(failed.stderr, /UNEXPECTED_AFTER_FAILURE/u)
  assert.ok(Buffer.byteLength(failed.stderr) < 4096)
  const passed = spawnSync('/bin/sh', ['-c', freebsdBuildLog(state, 'printf build-ok').replaceAll(state, root)], { encoding: 'utf8' })
  assert.equal(passed.status, 0, passed.stderr)
  assert.equal(passed.stdout, 'build-ok')
  const logs = await readdir(root)
  assert.equal(logs.length, 2)
  for (const log of logs) assert.equal((await stat(path.join(root, log))).mode & 0o777, 0o600)
  assert.ok((await Promise.all(logs.map(log => readFile(path.join(root, log), 'utf8')))).some(log => log.length > 16000 && log.includes('ACTUAL_COMPILER_ERROR') && !log.includes('UNEXPECTED_AFTER_FAILURE')))
  assert.throws(() => freebsdBuildLog('/tmp/../escape', 'true'))
  assert.throws(() => freebsdBuildLog(state, 'true\nINTENTAI_OPS_BUILD\nfalse'))
})

test('native compiler selection supports minimal containers and preserves an existing system compiler', () => {
  for (const mode of ['system', 'llvm19', 'missing']) {
    const fixture = `command() { case "$2" in cc|c++) if [ '${mode}' = system ]; then printf '/usr/bin/%s' "$2"; return 0; fi;; clang19|clang++19) if [ '${mode}' = llvm19 ]; then printf '/usr/local/bin/%s' "$2"; return 0; fi;; esac; return 1; }; `
    const result = spawnSync('/bin/sh', ['-c', 'set -eu; ' + fixture + freebsdCompilerEnvironment() + '; printf "%s|%s|%s" "$CC" "$CXX" "$CARGO_TARGET_X86_64_UNKNOWN_FREEBSD_LINKER"'], { encoding: 'utf8' })
    if (mode === 'missing') {
      assert.equal(result.status, 78)
      assert.match(result.stderr, /BUILD_COMPILER_UNAVAILABLE/u)
    } else {
      assert.equal(result.status, 0, result.stderr)
      const compiler = mode === 'system' ? '/usr/bin/cc' : '/usr/local/bin/clang19'
      assert.equal(result.stdout.split('|')[0], compiler)
      assert.equal(result.stdout.split('|')[2], compiler)
    }
  }
  const existing = spawnSync('/bin/sh', ['-c', 'set -eu; command() { return 0; }; pkg() { exit 99; }; ' + freebsdInstallCompilerIfMissing()], { encoding: 'utf8' })
  assert.equal(existing.status, 0, 'A normal FreeBSD host must not acquire another compiler')
  assert.match(freebsdInstallCompilerIfMissing(), /for package in 'llvm19'/u)
})

test('FreeBSD runtime acquisition reuses installed prerequisites rather than explicitly upgrading them', () => {
  const command = freebsdInstallMissingPackages(['python312', 'gmake', 'node22'])
  const selection = command.slice(0, command.indexOf('if [ -n'))
  for (const [fixture, expected] of [['pkg () { return 0; }; ', ''], ['pkg () { return 1; }; ', ' python312 gmake node22'], ['pkg () { [ "$3" = python312 ]; }; ', ' gmake node22']]) {
    const result = spawnSync('/bin/sh', ['-c', fixture + selection + 'printf "%s" "$missing_packages"'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, expected)
  }
  assert.throws(() => freebsdInstallMissingPackages(['python312;id']), /Invalid/u)
  assert.throws(() => freebsdInstallMissingPackages(['-f']), /Invalid/u)
})

test('FreeBSD nginx security keeps fixed packages and restricts fallback to a signed official catalogue', () => {
  const command = freebsdNginxSecurityCommand('/var/db/webminai/task-state/9-ghost')
  const fixture = "set -eu; pkg () { case \"$1\" in query) printf '%s' '1.30.6,3';; version) printf '=';; *) exit 99;; esac; }; "
  const result = spawnSync('/bin/sh', ['-c', fixture + command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  const unsupported = spawnSync('/bin/sh', ['-c', "set -eu; pkg () { case \"$1\" in query) printf '1.30.5,3';; version) printf '<';; *) exit 99;; esac; }; uname () { printf '14.4-RELEASE'; }; " + command], { encoding: 'utf8' })
  assert.equal(unsupported.status, 78)
  assert.match(unsupported.stderr, /NGINX_SECURITY_UPDATE_UNAVAILABLE/u)
  assert.match(command, /signature_type: "fingerprints"/u)
  assert.match(command, /PKG_DBDIR='[^']+\/nginx-security\/catalog'/u)
  assert.match(command, /fingerprints: "\/usr\/share\/keys\/pkg"/u)
  const configuration = spawnSync('/bin/sh', ['-c', command.split('\n').find(line => line.trim().startsWith('printf ')).split(' > ')[0]], { encoding: 'utf8' })
  assert.equal(configuration.status, 0, configuration.stderr)
  assert.ok(configuration.stdout.endsWith('}\n'), 'Repository configuration must end in a newline, not a literal backslash escape')
  assert.match(command, /pkg add -f "\$archive"/u)
  assert.ok(!command.includes('accept-missing'))
  assert.ok(!command.includes('/etc/pkg/'))
  assert.throws(() => freebsdNginxSecurityCommand('/tmp/evil;id'), /Invalid/u)
})

test('FreeBSD CLI records failed-install dependencies and removes only validated new package names', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-freebsd-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const plan = buildCommonTask('intent-ai-ops-freebsd', 9, { platform: 'freebsd', intentAiOpsInstallSource: { installerPath: '/tmp/fixture-installer', packageUrl: '/tmp/fixture.tgz' } }).plan
  const install = plan.commands[1].command
  const capture = install.slice(install.indexOf('if [ ! -e "$state/packages.before"'), install.indexOf('cp --'))
  const failed = spawnSync('/bin/sh', ['-c', "set -eu; pkg () { printf 'netdata\\npkg\\n'; }; " + capture + 'exit 7'], { env: { ...process.env, state: root }, encoding: 'utf8' })
  assert.equal(failed.status, 7, failed.stderr)
  assert.equal(await readFile(path.join(root, 'packages.before'), 'utf8'), 'netdata\npkg\n')
  assert.equal(await readFile(path.join(root, 'packages.after'), 'utf8'), 'netdata\npkg\n')
  await writeFile(path.join(root, 'packages.after'), 'libuv\nnetdata\nnode24\nnpm-node24\npkg\n')
  const rollback = plan.revertCommands[0].command
  const cleanup = rollback.slice(rollback.indexOf('test -s "$state/packages.before"'), rollback.indexOf('; fi; rm -rf -- "$state"'))
  await writeFile(path.join(root, 'pkg'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$REMOVED"\n', { mode: 0o700 })
  const environment = { ...process.env, state: root, REMOVED: path.join(root, 'removed'), PATH: root + path.delimiter + process.env.PATH }
  const result = spawnSync('/bin/sh', ['-c', 'set -eu; ' + cleanup], { env: environment, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(environment.REMOVED, 'utf8'), 'delete\n-y\nlibuv\nnode24\nnpm-node24\n')
  await rm(environment.REMOVED)
  await writeFile(path.join(root, 'packages.after'), 'bad;command\nnetdata\npkg\n')
  const invalid = spawnSync('/bin/sh', ['-c', 'set -eu; ' + cleanup], { env: environment, encoding: 'utf8' })
  assert.notEqual(invalid.status, 0)
  await assert.rejects(readFile(environment.REMOVED), { code: 'ENOENT' })
})

test('FreeBSD nginx fallback validates the archive and never fetches dependency packages', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-nginx-security-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const mock = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"
case "$1" in
  query) if [ "\${2:-}" = -F ]; then printf '%s\\n' "nginx-$FIXED_VERSION"; elif [ -f "$FIXTURE_ROOT/added" ]; then printf '%s\\n' "$FIXED_VERSION"; else printf '1.30.5,3\\n'; fi;;
  version) case "$3" in 1.30.5*) printf '<';; *) printf '=';; esac;;
  -o) case "$5" in
    update) :;;
    rquery) printf '%s\\n' "$FIXED_VERSION";;
    fetch) mkdir -p "$FIXTURE_ROOT/nginx-security/cache/All/Hashed"; touch "$FIXTURE_ROOT/nginx-security/cache/All/Hashed/nginx.pkg";;
    *) exit 99;;
  esac;;
  add) [ "\${FAIL_ADD:-no}" != yes ]; touch "$FIXTURE_ROOT/added";;
  *) exit 99;;
esac
`
  await writeFile(path.join(root, 'pkg'), mock, { mode: 0o700 })
  const command = freebsdNginxSecurityCommand('/var/db/webminai/task-state/9-nginx').replaceAll('/var/db/webminai/task-state/9-nginx', root)
  const fixture = 'set -eu; uname () { case "$1" in -r) printf 15.1-RELEASE;; -m) printf amd64;; esac; }; '
  const environment = { ...process.env, FIXTURE_ROOT: root, FIXED_VERSION: '1.30.6_3,3', PATH: root + path.delimiter + process.env.PATH }
  const result = spawnSync('/bin/sh', ['-c', fixture + command], { env: environment, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const calls = await readFile(path.join(root, 'calls'), 'utf8')
  assert.match(calls, /fetch -y -U -s -r IntentNginxSecurity/u)
  assert.ok(!calls.includes('--dependencies'))
  assert.ok(!calls.includes('install '))
  await rm(path.join(root, 'added'))
  await symlink('Hashed/nginx.pkg', path.join(root, 'nginx-security/cache/All/nginx.pkg'))
  const alias = spawnSync('/bin/sh', ['-c', fixture + command], { env: environment, encoding: 'utf8' })
  assert.equal(alias.status, 0, alias.stderr)
  await rm(path.join(root, 'added'))
  const extra = path.join(root, 'nginx-security/cache/All/Hashed/other.pkg')
  await writeFile(extra, '')
  const ambiguous = spawnSync('/bin/sh', ['-c', fixture + command], { env: environment, encoding: 'utf8' })
  assert.equal(ambiguous.status, 78)
  assert.match(ambiguous.stderr, /NGINX_PACKAGE_AMBIGUOUS/u)
  await assert.rejects(readFile(path.join(root, 'added')), { code: 'ENOENT' })
  await rm(extra)
  await writeFile(path.join(root, 'calls'), '')
  const malformed = spawnSync('/bin/sh', ['-c', fixture + command], { env: { ...environment, FIXED_VERSION: 'bad;version' }, encoding: 'utf8' })
  assert.equal(malformed.status, 78)
  assert.match(malformed.stderr, /NGINX_SECURITY_VERSION_INVALID/u)
  assert.ok(!(await readFile(path.join(root, 'calls'), 'utf8')).includes('fetch '))
  const rejected = spawnSync('/bin/sh', ['-c', fixture + command], { env: { ...environment, FAIL_ADD: 'yes' }, encoding: 'utf8' })
  assert.equal(rejected.status, 1)
  await assert.rejects(readFile(path.join(root, 'added')), { code: 'ENOENT' })
})

test('FreeBSD database readiness waits for the application account over final TCP service', () => {
  const command = freebsdMariaDbReadyCommand('reviewed-app', 'reviewed_db', '10.89.104.2')
  const fixture = 'set -eu; calls=0; jot () { printf \'1\\n2\\n3\\n\'; }; sleep () { :; }; podman () { case "$*" in *db_root_password*) return 0;; *"--protocol=TCP -h10.89.104.2 -ureviewed_db reviewed_db"*) calls=$((calls + 1)); test "$calls" -ge 3;; *) return 99;; esac; }; '
  const result = spawnSync('/bin/sh', ['-c', fixture + command + '; printf "%s" "$calls"'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '3')
  const unavailable = spawnSync('/bin/sh', ['-c', fixture.replace('test "$calls" -ge 3', 'false') + command], { encoding: 'utf8' })
  assert.equal(unavailable.status, 1)
  assert.throws(() => freebsdMariaDbReadyCommand('bad;id', 'db', '10.89.104.2'), /Invalid catalog/u)
  for (const app of ['joomla', 'drupal', 'prestashop', 'moodle', 'nextcloud']) {
    const built = buildCommonTask(`${app}-freebsd`, 9, { platform: 'freebsd', freebsdExecution: { platform: 'freebsd', freebsdVersion: '14.4-RELEASE-p12', docker: { ready: true } } })
    assert.ok(built.plan.commands.some(command => command.command.includes('mariadb --protocol=TCP')))
    assert.ok(built.plan.commands.every(command => !command.command.includes('mariadb -uroot -e "SELECT 1"')))
  }
})

test('FreeBSD Drupal retains installer errors privately instead of disclosing raw diagnostics', () => {
  const built = buildCommonTask('drupal-freebsd', 9, { platform: 'freebsd', freebsdExecution: { platform: 'freebsd', freebsdVersion: '14.4-RELEASE-p12', docker: { ready: true } } })
  const command = built.plan.commands.find(command => command.id === 'deploy-drupal').command
  assert.ok(command.includes('umask 077; if ! podman exec'))
  assert.ok(command.includes("2>'/root/drupal_credentials/install.stderr'"))
  assert.ok(command.includes("rm -f -- '/root/drupal_credentials/install.stderr'"))
  assert.ok(!command.includes('cat /root/drupal_credentials/install.stderr'))
})

test('WordPress image ownership uses installed PHP rather than absent base chown', () => {
  const built = buildCommonTask('wordpress-freebsd', 9, { platform: 'freebsd', freebsdExecution: { platform: 'freebsd', freebsdVersion: '14.4-RELEASE-p12', docker: { ready: true } } })
  const command = built.plan.commands.find(command => command.id === 'build-wordpress-image').command
  assert.ok(command.includes('php -r'))
  assert.ok(command.includes('RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)'))
  assert.ok(command.includes('$path->isLink() || !chown('))
  assert.ok(command.includes('!chgrp($path->getPathname(), 0)'))
  assert.ok(!command.includes('chown -R'))
})

test('known low-memory FreeBSD hosts cannot prepare n8n deployment', () => {
  const options = { platform: 'freebsd', freebsdExecution: { platform: 'freebsd', memoryBytes: 2147483648 } }
  assert.equal(commonTaskEligibility('n8n-freebsd', options).eligible, false)
  assert.throws(() => buildCommonTask('n8n-freebsd', 9, options), /INSUFFICIENT_MEMORY/u)
  options.freebsdExecution.memoryBytes = 4294967296
  assert.equal(commonTaskEligibility('n8n-freebsd', options).eligible, true)
})

test('Podman rollback ownership excludes upgraded pre-existing packages', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-freebsd-packages-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'packages.before'), 'netdata=2.0\npkg=2.7\n')
  await writeFile(path.join(root, 'packages.after'), 'netdata=2.1\npkg=2.8\npodman=5.8\n')
  const built = buildCommonTask('podman-freebsd', 9, { platform: 'freebsd', freebsdExecution: { platform: 'freebsd', docker: { installSupported: true } } })
  const command = built.plan.commands.find(command => command.id === 'install-podman-suite').command
  const delta = command.split('> "$state/packages.after"; ')[1].split('; if ! mount')[0]
  const result = spawnSync('/bin/sh', ['-c', delta], { env: { ...process.env, state: root }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(path.join(root, 'packages.added'), 'utf8'), 'podman\n')
  const storage = built.plan.commands.find(command => command.id === 'configure-podman-storage')
  assert.ok(storage.command.includes('_usr_local_etc_containers.existed'))
  assert.ok(storage.command.includes('_var_db_containers.existed'))
  assert.ok(storage.command.includes('driver = "vfs"'))
  assert.ok(storage.command.includes('/var/db/containers/vfs-storage'))
  assert.deepEqual(built.plan.commands.find(command => command.id === 'configure-podman-network').dependsOn, [storage.id])
  assert.deepEqual(built.plan.commands.find(command => command.id === 'verify-podman-suite').dependsOn, ['configure-podman-network'])
})

test('FreeBSD 14.4 uses compatible runtime images without changing 15.1 image identities', () => {
  const older = freebsdContainerImages({ freebsdVersion: '14.4-RELEASE-p8|14.4-RELEASE-p12' })
  assert.equal(older.base, 'ghcr.io/freebsd/freebsd-runtime:14.4')
  const current = freebsdContainerImages({ freebsdVersion: '15.1-RELEASE-p2' })
  assert.equal(current.base, 'ghcr.io/freebsd/freebsd-notoolchain:15.1')
  assert.notEqual(older.php, current.php)
  assert.notEqual(older.database, current.database)
  assert.notEqual(older.wordpress, current.wordpress)
  for (const version of ['14.2-RELEASE', '14.3-RELEASE', '15.0-RELEASE', 'unknown']) assert.throws(() => freebsdContainerImages({ freebsdVersion: version }), /reviewed/u)
  for (const application of ['wordpress', 'woocommerce', 'joomla', 'drupal', 'prestashop', 'moodle', 'nextcloud']) {
    const plan = buildCommonTask(application + '-freebsd', 9, { platform: 'freebsd', freebsdExecution: { platform: 'freebsd', freebsdVersion: '14.4-RELEASE-p8', docker: { ready: true } } }).plan
    validateCommandPlan(plan, { executionIdentity: 'root' })
    const commands = plan.commands.map(command => command.command).join('\n')
    assert.ok(commands.includes('FROM ' + older.base), application)
    assert.ok(commands.includes('image: ' + older.database), application)
    assert.ok(commands.includes('image: ' + (['wordpress', 'woocommerce'].includes(application) ? older.wordpress : older.php)), application)
    assert.ok(!commands.includes('notoolchain:15.1'), application)
  }
})

test('FreeBSD native runtime requests stay within versioned package families while permitting repository patch updates', () => {
  const cases = [
    ['n8n', ['node24', 'npm-node24'], /major === 24/u],
    ['ghost', ['node22', 'npm-node22', 'mysql80-server'], /major === 22/u],
    ['odoo', ['python312', 'postgresql17-server'], /sys\.version_info\[:2\] == \(3, 12\)/u],
    ['home-assistant', ['python314', 'py314-sqlite3'], /sys\.version_info >= \(3, 14, 2\)/u],
    ['magento', ['php84', 'php84-composer', 'mariadb114-server', 'opensearch219', 'valkey8'], /PHP_VERSION_ID >= 80400 && PHP_VERSION_ID < 80500/u]
  ]
  for (const [application, families, guard] of cases) {
    const plan = buildCommonTask(application + '-freebsd', 9, { platform: 'freebsd', freebsdExecution: { platform: 'freebsd' } }).plan
    validateCommandPlan(plan, { executionIdentity: 'root' })
    const command = plan.commands.find(item => item.id === `install-${application}-runtime`).command
    if (['ghost', 'home-assistant'].includes(application)) assert.equal(plan.commands.find(item => item.id === `install-${application}-runtime`).timeoutMs, 3600000)
    const packages = [...command.match(/for package in ([^;]+); do/u)[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
    for (const family of families) assert.ok(packages.includes(family), family)
    assert.ok(packages.every(name => !/-[0-9]+[.]/u.test(name)), 'Do not hard-pin removed runtime patch packages')
    assert.match(command, guard)
    if (application === 'odoo') {
      assert.ok(!packages.includes('py312-pip'), 'Use the venv pip supplied by Python ensurepip, not a global pip package')
      const acquisition = plan.commands.find(item => item.id === 'install-odoo-application').command
      assert.ok(acquisition.includes('python3.12 -m venv'))
      assert.ok(acquisition.includes("CARGO_HOME='/var/lib/webminai/task-state/9-odoo-freebsd/cargo' CARGO_BUILD_JOBS=1"))
    }
    if (application === 'ghost') assert.ok(command.indexOf('pkg update -f;') < command.indexOf('pkg install -y'))
    if (application === 'ghost') {
      assert.ok(plan.commands[0].command.includes('pw usershow mysqlrouter'))
      assert.ok(plan.commands[0].command.includes('$kind-mysqlrouter-created'))
      const rollback = plan.revertCommands[0].command
      assert.ok(rollback.includes('user-mysqlrouter-created'))
      assert.ok(rollback.includes('if [ "$router_user" = yes ]; then pw userdel mysqlrouter'))
      assert.ok(rollback.includes('if [ "$router_group" = yes ]; then pw groupdel mysqlrouter'))
    }
    if (['n8n', 'ghost'].includes(application)) {
      const acquisition = plan.commands.find(item => item.id === `install-${application}-application`).command
      assert.ok(acquisition.includes('--network-family-autoselection-attempt-timeout=2000'))
      if (application === 'n8n') {
        const resolution = plan.commands.find(item => item.id === 'resolve-n8n-dependencies').command
        assert.deepEqual(plan.commands.find(item => item.id === 'install-n8n-application').dependsOn, ['resolve-n8n-dependencies'])
        assert.ok(resolution.includes('install --package-lock-only --ignore-scripts --save-exact'))
        assert.ok(acquisition.includes('ci --ignore-scripts --prefer-offline'))
        assert.ok(acquisition.includes('--max-old-space-size=1536'))
        assert.ok(acquisition.includes('npm_config_foreground_scripts=true npm_config_jobs=1 MAKEFLAGS=-j1'))
        assert.ok(acquisition.indexOf('--max-old-space-size=1536') < acquisition.indexOf('npm --prefix'))
        assert.ok(resolution.includes('allowScripts:{sqlite3:true}'))
        const manifest = resolution.split('node -e ')[1].split('; npm --prefix')[0]
        let written
        runInNewContext(manifest.slice(1, -1).replaceAll("'\\''", "'"), {
          require: name => {
            assert.equal(name, 'node:fs')
            return { writeFileSync: (file, text) => { assert.equal(file, '/usr/local/lib/webminai-n8n-18109/package.json'); written = JSON.parse(text) } }
          }
        })
        assert.equal(written.private, true)
        assert.equal(written.dependencies.n8n, '2.33.7')
        assert.deepEqual(written.allowScripts, { sqlite3: true })
        assert.ok(!acquisition.includes('dangerously-allow-all-scripts'))
        assert.ok(resolution.indexOf('INSUFFICIENT_MEMORY') < resolution.indexOf('rm -rf'))
        assert.ok(resolution.indexOf("rm -rf -- '/usr/local/lib/webminai-n8n-18109/node_modules'") < resolution.indexOf('npm --prefix'))
        assert.ok(resolution.includes("test ! -L '/usr/local/lib/webminai-n8n-18109/node_modules'"))
        assert.ok(resolution.indexOf('test ! -e') < resolution.indexOf('rm -rf'))
        assert.ok(!acquisition.includes("rm -f -- '/usr/local/lib/webminai-n8n-18109/package-lock.json'"))
        const lockCheck = acquisition.split('node -e ')[1].split('; npm --prefix')[0]
        const manifestFixture = { private: true, dependencies: { n8n: '2.33.7' }, allowScripts: { sqlite3: true } }
        const lockFixture = { lockfileVersion: 3, packages: { '': { dependencies: { n8n: '2.33.7' } }, 'node_modules/n8n': { version: '2.33.7' } } }
        for (const change of [null, 'manifest-version', 'lock-version', 'extra-script', 'extra-dependency']) {
          const root = structuredClone(manifestFixture)
          const lock = structuredClone(lockFixture)
          if (change === 'manifest-version') root.dependencies.n8n = '^2.33.7'
          if (change === 'lock-version') lock.packages['node_modules/n8n'].version = '2.33.8'
          if (change === 'extra-script') root.allowScripts.unreviewed = true
          if (change === 'extra-dependency') root.dependencies.unreviewed = '1.0.0'
          const check = () => runInNewContext(lockCheck.slice(1, -1).replaceAll("'\\''", "'"), {
            require: name => {
              assert.equal(name, 'node:fs')
              return { readFileSync: file => JSON.stringify(file.endsWith('/package-lock.json') ? lock : root) }
            }
          })
          if (change) assert.throws(check, /N8N_LOCK_MISMATCH/u)
          else assert.doesNotThrow(check)
        }
        assert.ok(!acquisition.includes('--build-from-source'))
        assert.ok(acquisition.indexOf('npm rebuild sqlite3 --no-audit') < acquisition.indexOf('node -e "require(\'sqlite3\')"'))
        assert.ok(acquisition.includes('--prefer-offline --maxsockets=8 --fetch-retries=4'))
        assert.ok(acquisition.includes('INSUFFICIENT_MEMORY'))
        assert.ok(acquisition.indexOf('sysctl -n hw.physmem') < acquisition.indexOf('npm --prefix'))
        const guard = acquisition.slice(acquisition.indexOf('set -eu; memory='), acquisition.indexOf('test -f'))
        for (const [bytes, status] of [[2147483648, 78], [4294967296, 0]]) {
          const result = spawnSync('/bin/sh', ['-c', `sysctl () { printf '%s\\n' '${bytes}'; }; ${guard} printf guard-passed`], { encoding: 'utf8' })
          assert.equal(result.status, status, result.stderr)
          if (status === 78) {
            assert.match(result.stderr, /INSUFFICIENT_MEMORY/u)
            assert.equal(result.stdout, '')
          } else assert.equal(result.stdout, 'guard-passed')
        }
      }
    }
    if (application === 'magento') {
      for (const family of ['11[.]4[.]', '2[.]19[.]', '8[.]1[.]', '2[.]10[.]']) assert.ok(command.includes(family))
    }
  }
})
