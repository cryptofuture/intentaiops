import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../scripts/lxd-test-lab.sh', import.meta.url))
const removeScript = fileURLToPath(new URL('../scripts/lxd-test-lab-remove-all.sh', import.meta.url))

test('LXD test lab script is valid Bash and defines nine unique SSH hosts', () => {
  execFileSync('bash', ['-n', script])
  execFileSync('bash', ['-n', removeScript])
  const output = execFileSync('bash', [script, 'matrix'], { encoding: 'utf8' })
  const rows = output.trim().split('\n').slice(1)
  assert.equal(rows.length, 9)
  assert.equal(new Set(rows.map(row => row.trim().split(/\s+/).at(-1))).size, 9)
  assert.match(output, /ubuntu:24\.04/)
  assert.match(output, /images:debian\/13\/cloud/)
  assert.match(output, /images:alpine\/3\.23\/cloud/)
  assert.doesNotMatch(output, /centos/i)

  const source = readFileSync(script, 'utf8')
  assert.ok(source.indexOf('install -d -m 0755 /run/sshd') < source.indexOf('sshd -t'))
  assert.match(source, /zypper --non-interactive install openssh openssh-server/)
  assert.match(source, /usermod --password NP/)
  assert.match(source, /lxc config set "\$name" --project "\$LXD_PROJECT" limits\.memory "\$MEMORY_LIMIT"/)
})
