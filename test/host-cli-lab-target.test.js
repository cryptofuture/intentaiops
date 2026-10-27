import assert from 'node:assert/strict'
import test from 'node:test'
import { hostCliLabTarget } from '../scripts/host-cli-lab-target.js'

test('shared reviewed lab driver keeps Mac defaults and isolates Windows targets', () => {
  assert.deepEqual(hostCliLabTarget(['--task=moodle-macos']), { platform: 'macos', catalogId: 'moodle-macos', hostId: 'macos-lab' })
  assert.deepEqual(hostCliLabTarget(['--platform=windows', '--task=brave-windows']), { platform: 'windows', catalogId: 'brave-windows', hostId: 'windows-lab' })
  for (const argv of [[], ['--platform=linux', '--task=nginx-linux'], ['--platform=windows', '--task=moodle-macos'], ['--task=brave-windows', '--task=n8n-windows'], ['--platform=windows', '--platform=macos', '--task=brave-windows']]) assert.throws(() => hostCliLabTarget(argv))
})
