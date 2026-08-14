import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../scripts/freebsd-vm-lab.sh', import.meta.url))
const removeScript = fileURLToPath(new URL('../scripts/remove-freebsd-vm-lab.sh', import.meta.url))
const nativePluginBuild = fileURLToPath(new URL('../scripts/build-native-plugin.sh', import.meta.url))

test('FreeBSD VM lab is valid Bash and defines guarded snapshot-based VMs', () => {
  execFileSync('bash', ['-n', script])
  execFileSync('bash', ['-n', removeScript])

  const output = execFileSync('bash', [script, 'matrix'], { encoding: 'utf8' })
  const rows = output.trim().split('\n').slice(1)
  assert.equal(rows.length, 2)
  assert.match(output, /FreeBSD 14\.4-RELEASE/)
  assert.match(output, /FreeBSD 15\.1-RELEASE/)
  assert.match(output, /BASIC-CLOUDINIT-ufs\.qcow2\.xz/)

  const source = readFileSync(script, 'utf8')
  assert.match(source, /download\.freebsd\.org\/releases\/VM-IMAGES/)
  assert.match(source, /qemu-system-x86 qemu-utils/)
  assert.match(source, /verify_archive/)
  assert.match(source, /cloud-localds/)
  assert.match(source, /locked: false/)
  assert.match(source, /sudo: ALL=\(ALL\) NOPASSWD:ALL/)
  assert.match(source, /\/var\/db\/webminai-lab-ready/)
  assert.doesNotMatch(source, /\/var\/lib\/cloud\/instance\/boot-finished/)
  assert.match(source, /snapshot-create-as/)
  assert.match(source, /snapshot-revert/)
  assert.match(source, /refusing to modify unmarked domain/)
  assert.match(source, /refusing to remove unmarked VM artifacts/)
  assert.match(source, /StrictHostKeyChecking=accept-new/)
  assert.match(source, /--docker-forwarding/)
  assert.match(source, /net\.ipv4\.ip_forward=1/)
  assert.match(source, /iptables -C FORWARD -i "\$docker_interface" -o "\$libvirt_bridge" -j ACCEPT/)
  assert.match(source, /--ctstate RELATED,ESTABLISHED/)

  const cleanupSource = readFileSync(removeScript, 'utf8')
  assert.match(cleanupSource, /freebsd-vm-lab\.sh" destroy --yes/)
})

test('FreeBSD release plugin builds enforce the oldest supported ABI', () => {
  const source = readFileSync(nativePluginBuild, 'utf8')
  assert.match(source, /uname -K/u)
  assert.match(source, /oldest supported FreeBSD major \(14\.x\)/u)
  assert.match(source, /backward-compatible static libc syscalls/u)
})
