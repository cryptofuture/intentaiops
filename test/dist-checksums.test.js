import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const distDirectory = path.join(projectRoot, 'dist')

test('dist SHA256SUMS covers every native plugin artifact', async () => {
  const entries = (await readdir(distDirectory))
    .filter(name => name === 'webminai.plugin' || name.startsWith('webminai.plugin-'))
    .sort()
  const manifest = await readFile(path.join(distDirectory, 'SHA256SUMS'), 'utf8')
  const checksums = new Map(manifest.trim().split('\n').map(line => {
    const match = /^([a-f0-9]{64}) {2}(webminai\.plugin(?:-[A-Za-z0-9._-]+)?)$/u.exec(line)
    assert.ok(match, `invalid SHA256SUMS line: ${line}`)
    return [match[2], match[1]]
  }))

  assert.deepEqual([...checksums.keys()].sort(), entries)
  for (const name of entries) {
    const binary = await readFile(path.join(distDirectory, name))
    assert.equal(createHash('sha256').update(binary).digest('hex'), checksums.get(name))
  }
})
