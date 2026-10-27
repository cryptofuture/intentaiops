import assert from 'node:assert/strict'

export function hostCliLabTarget (argv) {
  const flags = argv.filter(value => value.startsWith('--platform='))
  assert.ok(flags.length <= 1, 'Duplicate platform option')
  const platform = flags[0]?.slice(11) ?? 'macos'
  assert.ok(['macos', 'windows'].includes(platform), 'Unsupported lab platform')
  const tasks = argv.filter(value => value.startsWith('--task='))
  assert.equal(tasks.length, 1, 'One catalog task is required')
  const catalogId = tasks[0].slice(7)
  assert.match(catalogId, new RegExp(`^[a-z0-9-]+-${platform}$`, 'u'))
  return { platform, catalogId, hostId: `${platform}-lab` }
}
