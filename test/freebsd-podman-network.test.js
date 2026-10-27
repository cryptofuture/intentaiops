import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { buildCommonTask } from '../src/common-tasks.js'

const mocks = `
stat () { case "$2" in %u) printf '0\\n';; *) printf '0:0:644\\n';; esac; }
route () { printf 'interface: vtnet0\\n'; }
sha256 () { shift; openssl dgst -sha256 -r "$@" | awk '{print $1}'; }
podman () { if [ -f "$PF_ROOT/containers" ]; then cat "$PF_ROOT/containers"; fi; }
pfctl () {
  case "$1" in
    -s) case "$2" in info) if [ -f "$PF_ROOT/enabled" ]; then printf 'Status: Enabled\\n'; else printf 'Status: Disabled\\n'; fi;; Tables) printf 'cni-nat\\n';; esac;;
    -sr) :;;
    -sn) if [ -f "$PF_ROOT/rules" ]; then cat "$PF_ROOT/rules"; fi;;
    -nf) test -f "$2";;
    -f) cp "$2" "$PF_ROOT/rules";;
    -e) touch "$PF_ROOT/enabled";;
    -d) rm -f "$PF_ROOT/enabled";;
    *) return 1;;
  esac
}
`

async function fixture (t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-pf-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rc = '# existing host configuration\nhostname="fixture"\n'
  await writeFile(path.join(root, 'rc.conf'), rc)
  const built = buildCommonTask('podman-freebsd', 99, { platform: 'freebsd', freebsdExecution: { platform: 'freebsd', docker: { installSupported: true } } })
  const execute = id => {
    const command = [...built.plan.commands, ...built.plan.revertCommands].find(command => command.id === id).command
      .replaceAll('/var/db/webminai/task-state/99-freebsd-podman', root + '/state')
      .replaceAll('/etc/pf.conf', root + '/pf.conf')
      .replaceAll('/etc/rc.conf', root + '/rc.conf')
      .replaceAll('/etc/.intentaiops-pf.', root + '/.pf.')
    return spawnSync('/bin/sh', ['-c', mocks + '\n' + command], { env: { ...process.env, PF_ROOT: root }, encoding: 'utf8' })
  }
  return { root, rc, execute }
}

test('fresh Podman NAT setup restores exact rc.conf and removes only owned policy', async t => {
  const { root, rc, execute } = await fixture(t)
  const created = execute('configure-podman-network')
  assert.equal(created.status, 0, created.stderr)
  assert.match(await readFile(path.join(root, 'pf.conf'), 'utf8'), /nat on vtnet0 inet from <cni-nat>/u)
  assert.equal(existsSync(path.join(root, 'enabled')), true)
  assert.match(await readFile(path.join(root, 'rc.conf'), 'utf8'), /pf_enable="YES"/u)
  const restored = execute('restore-podman-network')
  assert.equal(restored.status, 0, restored.stderr)
  assert.equal(await readFile(path.join(root, 'rc.conf'), 'utf8'), rc)
  assert.equal(existsSync(path.join(root, 'pf.conf')), false)
  assert.equal(existsSync(path.join(root, 'enabled')), false)
})

test('existing valid PF policy is preserved without claiming ownership', async t => {
  const { root, execute } = await fixture(t)
  const original = '# operator-managed policy\n'
  await writeFile(path.join(root, 'pf.conf'), original)
  await writeFile(path.join(root, 'enabled'), '')
  await writeFile(path.join(root, 'rules'), 'nat-anchor "cni-rdr/*"\nrdr-anchor "cni-rdr/*"\n')
  const result = execute('configure-podman-network')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(path.join(root, 'state/pf-created')), false)
  assert.equal(await readFile(path.join(root, 'pf.conf'), 'utf8'), original)
  assert.equal(execute('restore-podman-network').status, 0)
  assert.equal(existsSync(path.join(root, 'enabled')), true)
})

test('unconfigured existing PF policy requires review instead of replacement', async t => {
  const { root, execute } = await fixture(t)
  await writeFile(path.join(root, 'pf.conf'), '# existing policy\n')
  const result = execute('configure-podman-network')
  assert.equal(result.status, 78)
  assert.match(result.stderr, /PODMAN_NETWORK_REVIEW_REQUIRED/u)
  assert.equal(await readFile(path.join(root, 'pf.conf'), 'utf8'), '# existing policy\n')
  assert.equal(existsSync(path.join(root, 'enabled')), false)
})

test('PF rollback refuses modified configuration, changed runtime rules and active containers', async t => {
  for (const target of ['pf.conf', 'rc.conf', 'rules', 'containers', 'state/pf-rc.conf.before']) {
    await t.test(target, async t => {
      const { root, execute } = await fixture(t)
      const created = execute('configure-podman-network')
      assert.equal(created.status, 0, created.stderr)
      await writeFile(path.join(root, target), 'operator changed this\n')
      const restored = execute('restore-podman-network')
      assert.equal(restored.status, 78, restored.stderr)
      assert.equal(existsSync(path.join(root, 'enabled')), true)
      assert.equal(existsSync(path.join(root, 'pf.conf')), true)
    })
  }
})
