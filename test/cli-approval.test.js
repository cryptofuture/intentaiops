import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseApprovalMode, parseAiRequest } from '../src/cli.js'

test('one confirmation approves the complete displayed command list', async () => {
  const prompts = []
  const ui = {
    async confirm (prompt, defaultValue) {
      prompts.push({ prompt, defaultValue })
      return true
    }
  }
  const commands = [{ id: 'one' }, { id: 'two' }]
  assert.equal(await chooseApprovalMode(ui, commands), 'all')
  assert.deepEqual(prompts, [{ prompt: 'Execute all 2 commands exactly as shown?', defaultValue: false }])
})

test('a leading question mark selects consultation mode', () => {
  assert.deepEqual(parseAiRequest('? should nginx use a container?'), {
    consultation: true,
    question: 'should nginx use a container?',
    storedRequest: '? should nginx use a container?'
  })
  assert.deepEqual(parseAiRequest('  install nginx  '), {
    consultation: false,
    request: 'install nginx'
  })
  assert.equal(parseAiRequest('?').question, '')
})

test('declining bulk approval preserves per-command review', async () => {
  const answers = [false, true]
  const defaults = []
  const ui = { async confirm (prompt, defaultValue) { defaults.push(defaultValue); return answers.shift() } }
  assert.equal(await chooseApprovalMode(ui, [{ id: 'one' }]), 'each')
  assert.deepEqual(defaults, [false, false])
})

test('declining both approval modes cancels execution', async () => {
  const ui = { async confirm () { return false } }
  assert.equal(await chooseApprovalMode(ui, [{ id: 'one' }]), null)
})
