import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildCommonTask } from '../src/common-tasks.js'

test('Linux health withholds unstructured logs when journal access is unavailable', () => {
  const command = buildCommonTask('host-health-linux', 1, { platform: 'linux' }).plan.commands[0].command
  assert.doesNotMatch(command, /\/var\/log\/(messages|syslog)/)
  const result = spawnSync('/bin/sh', ['-c', 'journalctl () { return 1; }; systemctl () { return 0; }; dmesg () { return 0; }; ' + command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /recent-system-log: unavailable \(unfiltered traditional logs withheld\)/)
})

test('Linux health falls back to BusyBox process names without exposing arguments', () => {
  const command = buildCommonTask('host-health-linux', 1, { platform: 'linux' }).plan.commands.find(item => item.id === 'collect-health-activity').command
  assert.doesNotMatch(command, /ps aux|args|cmdline/)
  const mock = 'docker () { return 0; }; ps () { case "$*" in "-o pid,ppid,comm") printf "PID PPID COMMAND\\n1 0 init\\n";; *) return 1;; esac; }; '
  const result = spawnSync('/bin/sh', ['-c', mock + command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /1 0 init/)
  const unavailable = spawnSync('/bin/sh', ['-c', 'docker () { return 0; }; ps () { return 1; }; ' + command], { encoding: 'utf8' })
  assert.equal(unavailable.status, 0, unavailable.stderr)
  assert.match(unavailable.stdout, /process-snapshot: unavailable/)
})
