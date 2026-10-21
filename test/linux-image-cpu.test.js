import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { linuxX86V2ImageProfile } from '../src/linux-image-cpu.js'

test('image selection requires known capabilities on every x86 CPU', () => {
  const flags = 'cx16 lahf_lm popcnt pni sse4_1 sse4_2 ssse3'
  for (const [architecture, contents, expected] of [
    ['x86_64', `flags : ${flags}\n`, 'standard'],
    ['x86_64', `flags : ${flags.replace('sse4_2', '')}\n`, 'compat'],
    ['amd64', `flags : ${flags}\nflags : cx16\n`, 'compat'],
    ['x86_64', 'processor : 0\n', null],
    ['x86_64', null, null],
    ['aarch64', '', 'standard'],
    ['unknown', '', null]
  ]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'image-cpu-'))
    try {
      const file = path.join(directory, 'cpuinfo')
      if (contents !== null) writeFileSync(file, contents)
      const result = spawnSync('/bin/sh', ['-c', `uname () { printf '${architecture}'; }; ${linuxX86V2ImageProfile().replaceAll('/proc/cpuinfo', file)}`], { encoding: 'utf8' })
      assert.equal(result.status === 0, expected !== null, architecture + ': ' + result.stderr)
      assert.equal(result.stdout.trim(), expected ?? '')
      if (expected === null) assert.match(result.stderr, /CPU_FEATURES_UNAVAILABLE/u)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})
