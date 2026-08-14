import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))

function run (entrypoint, args = ['--help']) {
  const env = { ...process.env }
  delete env.VAULT_TEST
  delete env.SSH_HOST_1
  delete env.WEBMINAI_KUBECONFIG
  return spawnSync(process.execPath, [path.join(root, entrypoint), ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 10000
  })
}

test('primary CLI help is ordinary non-interactive output', () => {
  const result = run('bin/intentaiops.js')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage: intentaiops/u)
  assert.match(result.stdout, /https:\/\/intentaiops\.top/u)
  assert.equal(result.stderr, '')
})

test('legacy webminai executable remains a compatible alias', () => {
  const result = run('bin/webminai.js')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage: intentaiops/u)
  assert.equal(result.stderr, '')
})

for (const [entrypoint, expected] of [
  ['scripts/validate-multi-host-nginx.js', /WEBMINAI_TEST_HOSTS/u],
  ['scripts/validate-remote-tasks.js', /--task=ID/u],
  ['scripts/validate-kubernetes-stage2.js', /activate\|test\|revert\|deactivate\|all/u],
  ['scripts/validate-kubernetes-common-tasks.js', /list\|all\|run <catalog-id>\|revert <catalog-id>/u],
  ['scripts/validate-package-install-remote.js', /--host=SERVER_ID/u],
  ['scripts/validate-intent-ai-ops-common-task.js', /--host=macos-15\|windows-11/u]
]) {
  test(`${entrypoint} exposes non-mutating help without live credentials`, () => {
    const result = run(entrypoint)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, expected)
    assert.equal(result.stderr, '')
  })
}

test('Kubernetes validator rejects an unknown action before opening a cluster connection', () => {
  const result = run('scripts/validate-kubernetes-stage2.js', ['unknown'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage: validate-kubernetes-stage2\.js/u)
})

test('POSIX bootstrap exposes non-mutating help', () => {
  const result = spawnSync('sh', [path.join(root, 'scripts/install.sh'), '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /private Node\.js 24 runtime/u)
})
