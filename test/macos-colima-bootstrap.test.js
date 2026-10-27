import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readlink, unlink, lstat } from 'node:fs/promises'
import { buildMacosColimaBootstrapTask } from '../src/macos-colima-bootstrap-task.js'
import { runProcess } from '../src/process-runner.js'

test('an existing empty Homebrew baseline is not collected again', async t => {
  const directory = await mkdtemp('/tmp/icolima-empty-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(`${directory}/formulae.before`, '')
  const built = buildMacosColimaBootstrapTask(106, { runtimeUser: 'mac', runtimeHome: '/Users/mac', brewPath: '/usr/local/bin/brew', brewPrefix: '/usr/local' })
  const command = built.plan.commands.find(command => command.id === 'capture-colima-baseline').command.replaceAll('/var/db/webminai/task-state/106-macos-colima', directory)
  const result = await runProcess('/bin/sh', ['-c', command], { timeoutMs: 2000 })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(await readFile(`${directory}/formulae.before`, 'utf8'), '')
})

test('existing stopped Colima profile starts without sizing overrides and rollback preserves sibling profiles', async t => {
  const directory = await mkdtemp('/tmp/icolima-')
  const home = `${directory}/home`
  const state = `${directory}/state`
  const bin = `${directory}/bin`
  for (const path of [state, bin, `${home}/.colima/default`, `${home}/.colima/unrelated`]) await mkdir(path, { recursive: true })
  for (const name of ['default-profile.existed', 'colima-home.existed']) await writeFile(`${state}/${name}`, '')
  await writeFile(`${home}/.colima/unrelated/protected`, 'preserve')
  await writeFile(`${bin}/docker`, `#!/bin/sh\n[ "$1" != info ] || [ -f '${directory}/started' ]\n`, { mode: 0o700 })
  await writeFile(`${bin}/colima`, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${directory}/calls'\nif [ "$1" = start ]; then touch '${directory}/started'; fi\n`, { mode: 0o700 })
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`${home}/.colima/default/docker.sock`, resolve) })
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  const built = buildMacosColimaBootstrapTask(106, { runtimeUser: 'mac', runtimeHome: '/Users/mac', brewPath: '/usr/local/bin/brew', brewPrefix: '/usr/local' })
  const adapt = command => command.replaceAll('/var/db/webminai/task-state/106-macos-colima', state).replaceAll('/Users/mac', home).replaceAll('/usr/local/bin', bin).replaceAll('/usr/local/sbin', bin).replaceAll("/usr/bin/su -l 'mac' -c", '/bin/sh -c')
  const started = await runProcess('/bin/sh', ['-c', adapt(built.plan.commands.find(command => command.id === 'start-colima').command)], { timeoutMs: 3000 })
  assert.equal(started.code, 0, started.stderr)
  assert.equal(await readFile(`${directory}/calls`, 'utf8'), 'start\n')
  const reverted = await runProcess('/bin/sh', ['-c', adapt(built.plan.revertCommands.find(command => command.id === 'remove-task-colima').command)], { timeoutMs: 3000 })
  assert.equal(reverted.code, 0, reverted.stderr)
  assert.equal(await readFile(`${directory}/calls`, 'utf8'), 'start\nstop\n')
  assert.equal(await readFile(`${home}/.colima/unrelated/protected`, 'utf8'), 'preserve')
})

for (const mode of ['missing', 'preexisting', 'changed', 'install-fails', 'arm64', 'fresh']) {
  test(`Colima plugin ownership and dependency rollback: ${mode}`, async t => {
    const directory = await mkdtemp('/tmp/icolima-plugins-')
    t.after(() => rm(directory, { recursive: true, force: true }))
    const home = `${directory}/home`
    const state = `${directory}/state`
    const bin = `${directory}/bin`
    const plugins = `${home}/.docker/cli-plugins`
    for (const path of [state, bin, plugins]) await mkdir(path, { recursive: true })
    const before = mode === 'fresh' ? '' : 'colima\ndocker\ndocker-compose\n'
    await writeFile(`${state}/formulae.before`, before)
    await writeFile(`${directory}/packages`, before)
    await writeFile(`${bin}/su`, '#!/bin/sh\n[ "$1" = -l ] && [ "$2" = mac ] && [ "$3" = -c ] && [ "$#" = 4 ] || exit 1\nexec /bin/sh -c "$4"\n', { mode: 0o755 })
    if (mode === 'arm64') await writeFile(`${bin}/uname`, '#!/bin/sh\nprintf "arm64\\n"\n', { mode: 0o755 })
    for (const name of ['docker-compose', 'docker-buildx']) {
      await mkdir(`${directory}/prefix/${name}/bin`, { recursive: true })
      await writeFile(`${directory}/prefix/${name}/bin/${name}`, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    await writeFile(`${bin}/brew`, `#!/bin/sh
set -eu
case "$1" in
  install) printf '%s\\n' "$*" >> '${directory}/installs'; for formula do :; done; ${mode === 'install-fails' ? '[ "$formula" != docker-buildx ] || exit 7;' : ''} printf '%s\\n' "$formula" >> '${directory}/packages';;
  list) if [ "$#" = 3 ]; then grep -Fxq "$3" '${directory}/packages'; else cat '${directory}/packages'; fi;;
  --prefix) printf '${directory}/prefix/%s\\n' "$2";;
  uninstall) [ "$HOMEBREW_NO_AUTOREMOVE" = 1 ] || exit 91; sed "/^$3$/d" '${directory}/packages' > '${directory}/packages.next'; mv '${directory}/packages.next' '${directory}/packages';;
  *) exit 1;;
esac
`, { mode: 0o755 })
    await symlink(`${directory}/protected-compose`, `${plugins}/docker-compose`)
    if (mode === 'preexisting') await writeFile(`${plugins}/docker-buildx`, 'protected-buildx', { mode: 0o755 })
    const built = buildMacosColimaBootstrapTask(106, { runtimeUser: 'mac', runtimeHome: '/Users/mac', brewPath: '/usr/local/bin/brew', brewPrefix: '/usr/local' })
    const adapt = command => command.replaceAll('/var/db/webminai/task-state/106-macos-colima', state).replaceAll('/Users/mac', home).replaceAll('/usr/local/bin', bin).replaceAll('/usr/local/sbin', bin).replaceAll('/usr/bin/su', `${bin}/su`)
    const installed = await runProcess('/bin/sh', ['-c', adapt(built.plan.commands.find(command => command.id === 'install-colima-toolchain').command)], { timeoutMs: 3000 })
    assert.equal(installed.code, mode === 'install-fails' ? 7 : 0, installed.stderr)
    assert.equal(await readlink(`${plugins}/docker-compose`), `${directory}/protected-compose`)
    const additions = mode === 'fresh' ? 'colima\ndocker\ndocker-buildx\ndocker-compose\ngo\n' : mode === 'arm64' ? 'docker-buildx\n' : mode === 'install-fails' ? 'go\n' : 'docker-buildx\ngo\n'
    assert.equal(await readFile(`${state}/formulae.added`, 'utf8'), additions)
    const installs = await readFile(`${directory}/installs`, 'utf8')
    if (mode === 'arm64') assert.equal(installs, 'install docker-buildx\n')
    else assert.match(installs, /install --build-from-source go/u)
    if (mode === 'fresh') assert.match(installs, /install --build-from-source colima\n/u)
    else assert.doesNotMatch(installs, /install[^\n]*(?:colima|docker-compose)(?:\n|$)/u)
    if (mode === 'changed') {
      await unlink(`${plugins}/docker-buildx`)
      await symlink(`${directory}/changed-buildx`, `${plugins}/docker-buildx`)
    }
    const reverted = await runProcess('/bin/sh', ['-c', adapt(built.plan.revertCommands.find(command => command.id === 'restore-homebrew-formulae').command)], { timeoutMs: 3000 })
    if (mode === 'changed') {
      assert.notEqual(reverted.code, 0)
      assert.equal(await readlink(`${plugins}/docker-buildx`), `${directory}/changed-buildx`)
      assert.match(await readFile(`${directory}/packages`, 'utf8'), /docker-buildx/u)
    } else {
      assert.equal(reverted.code, 0, reverted.stderr)
      assert.equal(await readFile(`${directory}/packages`, 'utf8'), before)
      if (mode === 'preexisting') assert.equal(await readFile(`${plugins}/docker-buildx`, 'utf8'), 'protected-buildx')
      else await assert.rejects(lstat(`${plugins}/docker-buildx`), { code: 'ENOENT' })
    }
    assert.equal(await readlink(`${plugins}/docker-compose`), `${directory}/protected-compose`)
  })
}
