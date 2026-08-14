import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { TerminalUi } from '../src/terminal-ui.js'

test('terminal editor submits with Enter, inserts Shift+Enter, and recalls history', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const editing = ui.editor('Task', { history: [{ request: 'old task' }] })

  input.emit('keypress', '', { name: 'up' })
  input.emit('keypress', '', { name: 'end' })
  input.emit('keypress', '', { name: 'return', shift: true })
  input.emit('keypress', 'next', { name: undefined })
  input.emit('keypress', '\r', { name: 'return' })

  assert.equal(await editing, 'old task\nnext')
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
})

test('terminal choices support left and right selection', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const choosing = ui.choose('History', [
    { label: 'New', value: 'new' },
    { label: 'Old', value: 'old' }
  ])
  input.emit('keypress', '', { name: 'right' })
  input.emit('keypress', '\r', { name: 'return' })
  assert.equal(await choosing, 'old')
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
})

test('searchable choices filter long host lists and page without rendering every host', async () => {
  const { input, output } = terminalPair()
  output.rows = 12
  const ui = new TerminalUi({ input, output })
  const hosts = Array.from({ length: 20 }, (_, index) => ({
    label: `host-${String(index).padStart(2, '0')}`,
    value: index
  }))
  const filtering = ui.searchChoose('Choose host', hosts)
  input.emit('keypress', '1', { name: '1' })
  input.emit('keypress', '2', { name: '2' })
  input.emit('keypress', '\r', { name: 'return' })
  assert.equal(await filtering, 12)
  assert.match(output.text, /Search: 12/)

  const paging = ui.searchChoose('Choose host', hosts)
  input.emit('keypress', '', { name: 'right' })
  input.emit('keypress', '\r', { name: 'return' })
  assert.equal(await paging, 5)
  assert.equal(input.isPaused(), true)
})

test('terminal multi-select toggles hosts and accepts them in display order', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const choosing = ui.multiChoose('Hosts', [
    { label: 'Alpha', value: 'alpha' },
    { label: 'Beta', value: 'beta' },
    { label: 'Gamma', value: 'gamma' }
  ])
  input.emit('keypress', ' ', { name: 'space' })
  input.emit('keypress', '', { name: 'down' })
  input.emit('keypress', '', { name: 'down' })
  input.emit('keypress', ' ', { name: 'space' })
  input.emit('keypress', '\r', { name: 'return' })
  assert.deepEqual(await choosing, ['alpha', 'gamma'])
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
})

test('secret input restores raw mode and paused stdin', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const secret = ui.secret('Secret')
  input.emit('data', Buffer.from('value\r'))
  assert.equal(await secret, 'value')
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
})

test('hidden multiline editor accepts pasted kubeconfig without rendering it', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const editing = ui.secretEditor('Paste Kubernetes kubeconfig')
  const kubeconfig = 'apiVersion: v1\nclusters:\n- name: production\n'
  input.emit('keypress', kubeconfig, { name: undefined })
  input.emit('keypress', '', { name: 'd', ctrl: true })

  assert.equal(await editing, kubeconfig.trim())
  assert.doesNotMatch(output.text, /apiVersion|production/)
  assert.match(output.text, /contents remain hidden/)
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
})

test('line prompts restore paused stdin', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const answer = ui.ask('Answer')
  input.emit('data', Buffer.from('yes\n'))
  assert.equal(await answer, 'yes')
  assert.equal(input.isPaused(), true)
})

test('terminal presentation helpers render readable status output without color', () => {
  const { input, output } = terminalPair()
  output.isTTY = false
  const ui = new TerminalUi({ input, output })
  ui.banner('Test console')
  ui.heading('Status')
  ui.line('State', 'ready')
  ui.info('info')
  ui.success('success')
  ui.warn('warning')
  ui.error('error')
  assert.match(output.text, /Intent AI Ops/)
  assert.match(output.text, /Test console/)
  assert.match(output.text, /State\s+ready/)
  assert.match(output.text, /INFO: info/)
  assert.match(output.text, /OK: success/)
  assert.match(output.text, /WARNING: warning/)
  assert.match(output.text, /ERROR: error/)
  assert.equal(ui.paint('cyan', 'plain'), 'plain')
})

test('terminal confirm and pause accept empty or affirmative answers', async () => {
  const { input, output } = terminalPair()
  output.isTTY = false
  const ui = new TerminalUi({ input, output })
  const confirming = ui.confirm('Continue', true)
  input.emit('data', Buffer.from('\n'))
  assert.equal(await confirming, true)
  const pausing = ui.pause()
  input.emit('data', Buffer.from('\n'))
  await pausing
  assert.match(output.text, /Continue \[Y\/n\]/)
  assert.match(output.text, /Press Enter to continue/)
})

test('terminal arrow selection handles numeric shortcuts and cancellation', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const choosing = ui.choose('Actions', [
    { label: 'First', value: 'first' },
    { label: 'Second', value: 'second' }
  ])
  input.emit('keypress', '2', { name: '2' })
  assert.equal(await choosing, 'second')

  const cancelled = ui.choose('Actions', [{ label: 'Only', value: 'only' }])
  input.emit('keypress', '', { ctrl: true, name: 'c' })
  await assert.rejects(cancelled, /interrupted/)
  assert.equal(input.isRaw, false)
})

test('search selection supports empty results, filtering controls, and escape', async () => {
  const { input, output } = terminalPair()
  output.rows = 10
  const ui = new TerminalUi({ input, output })
  const choosing = ui.searchChoose('Hosts', [
    { label: 'alpha', value: 'alpha' },
    { label: 'beta', value: 'beta' }
  ])
  input.emit('keypress', 'z', { name: 'z' })
  input.emit('keypress', '', { name: 'backspace' })
  input.emit('keypress', 'b', { name: 'b' })
  input.emit('keypress', '', { ctrl: true, name: 'u' })
  input.emit('keypress', '', { name: 'end' })
  input.emit('keypress', '', { name: 'home' })
  input.emit('keypress', '', { name: 'escape' })
  assert.equal(await choosing, null)
  assert.match(output.text, /No matching hosts/)
})

test('non-interactive multi-select accepts all hosts', async () => {
  const { input, output } = terminalPair()
  input.isTTY = false
  output.isTTY = false
  const ui = new TerminalUi({ input, output })
  const choosing = ui.multiChoose('Hosts', [
    { label: 'alpha', value: 'alpha' },
    { label: 'beta', value: 'beta' }
  ])
  input.emit('data', Buffer.from('all\n'))
  assert.deepEqual(await choosing, ['alpha', 'beta'])
  assert.match(output.text, /Select comma-separated numbers, or all/)
})

test('editor supports cursor editing, delete, tab, and history navigation', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const editing = ui.editor('Task', { initialValue: 'ab', history: ['old'] })
  input.emit('keypress', '', { name: 'home' })
  input.emit('keypress', 'x', { name: 'x' })
  input.emit('keypress', '', { name: 'right' })
  input.emit('keypress', '', { name: 'delete' })
  input.emit('keypress', '', { name: 'tab' })
  input.emit('keypress', '', { name: 'up' })
  input.emit('keypress', '', { name: 'down' })
  input.emit('keypress', 'done', { name: undefined })
  input.emit('keypress', '\r', { name: 'return' })
  assert.equal(await editing, 'done')
  assert.match(output.text, /History/)
})

test('restoring input state resumes a stream that was already active', () => {
  const { input, output } = terminalPair()
  input.resume()
  const ui = new TerminalUi({ input, output })
  input.setRawMode(true)
  ui.restoreInputState({ isRaw: false, isPaused: false })
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), false)
})

test('raw key handler failures restore terminal input state', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const reading = ui.readRawKey(() => { throw new Error('broken handler') })
  input.emit('keypress', 'x', { name: 'x' })
  await assert.rejects(reading, /broken handler/)
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
})

test('disposing the UI restores its initial terminal state', () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  input.setRawMode(true)
  input.resume()
  ui.dispose()
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
})

test('disposing the UI always pauses a previously resumed terminal', () => {
  const { input, output } = terminalPair()
  input.resume()
  const ui = new TerminalUi({ input, output })
  input.setRawMode(true)
  ui.dispose()
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
})

test('terminal suspension gives an interactive child cooked and paused parent input', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  input.setRawMode(true)
  input.resume()
  let stateDuringOperation
  await ui.withTerminalSuspended(() => {
    stateDuringOperation = { isRaw: input.isRaw, isPaused: input.isPaused() }
  })
  assert.deepEqual(stateDuringOperation, { isRaw: false, isPaused: true })
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
})

test('terminal suspension releases an active raw reader', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const reading = ui.readRawKey(() => {})
  await ui.withTerminalSuspended(() => {})
  await assert.rejects(reading, /terminal input suspended/)
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
})

test('terminal layout primitives wrap, truncate, align, stack, and avoid ANSI styling', () => {
  const { input, output } = terminalPair()
  output.columns = 48
  output.rows = 16
  const ui = new TerminalUi({ input, output })
  assert.deepEqual(ui.terminalSize(), { width: 48, height: 16 })
  assert.deepEqual(ui.wrapText('alpha beta\r\nsupercalifragilistic', 8), ['alpha', 'beta', 'supercal', 'ifragili', 'stic'])
  assert.deepEqual(ui.wrapText(null, -1), [''])
  assert.equal(ui.truncateText('abcdefgh', 5), 'abcd…')
  assert.equal(ui.truncateText(undefined, 0), '')
  ui.separator({ width: 8 })
  const columns = ui.renderColumns([
    { title: 'LEFT', lines: ['one'], width: 18 },
    { title: 'RIGHT', lines: ['two'], flex: 1 }
  ], { width: 48, verticalSeparator: true })
  assert.match(columns.join('\n'), /LEFT\s+\| RIGHT/)
  const stacked = ui.renderColumns([
    { title: 'LEFT', lines: ['one'] },
    { title: 'RIGHT', lines: ['two'] }
  ], { width: 20, stacked: true })
  assert.deepEqual(stacked, ['LEFT', 'one', '', 'RIGHT', 'two'])
  const table = ui.renderTable([
    { key: 'host', label: 'HOST', width: 10 },
    { key: 'state', label: 'STATE', flex: 1 }
  ], [{ host: 'a-very-long-host-id', state: null }], { width: 30, selectedIndex: 0 })
  assert.match(table.join('\n'), /> a-very-lo…/)
  const compactTable = ui.renderTable([
    { key: 'one', label: 'ONE', width: 20 },
    { key: 'two', label: 'TWO', width: 20 },
    { key: 'three', label: 'THREE', width: 20 }
  ], [{ one: 'alpha', two: 'beta', three: 'gamma' }], { width: 12 })
  assert.ok(compactTable.every(line => Array.from(line).length <= 12))
  ui.renderKeyHints(['Enter open', '/ search'], { width: 20 })
  assert.equal(hasSgr(output.text), false)
})

test('searchable split selector searches safe rows and updates selected details', async () => {
  const { input, output } = terminalPair()
  output.columns = 130
  output.rows = 24
  const ui = new TerminalUi({ input, output })
  const selecting = ui.searchableSplitChoose({
    title: 'Dashboard',
    summaryLines: ['Hosts: 2'],
    actions: [{ label: 'Browse hosts', value: 'browse', focusRows: true }, { label: 'Quit', value: 'quit' }],
    rows: [
      { value: 'alpha', label: 'alpha root@one.test', searchText: 'alpha root@one.test active', detail: 'Host: alpha' },
      { value: 'beta', label: 'beta admin@two.test', searchText: 'beta admin@two.test inactive', detail: 'Host: beta' }
    ],
    rowSearchText: row => row.searchText,
    renderRow: row => row.label,
    renderDetails: row => row ? [row.detail] : [],
    footerHints: ['Tab pane', '/ search']
  })
  input.emit('keypress', '', { name: 'tab' })
  input.emit('keypress', '', { name: 'down' })
  assert.match(output.text, /Host: beta/)
  input.emit('keypress', '/', { name: undefined })
  input.emit('keypress', 'a', { name: 'a' })
  input.emit('keypress', 'd', { name: 'd' })
  input.emit('keypress', 'm', { name: 'm' })
  input.emit('keypress', 'i', { name: 'i' })
  input.emit('keypress', 'n', { name: 'n' })
  assert.match(output.text, /Search: admin\s+1 of 2 hosts/)
  input.emit('keypress', '\r', { name: 'return' })
  input.emit('keypress', '\r', { name: 'return' })
  assert.deepEqual(await selecting, { type: 'row', value: 'beta' })
  assert.match(output.text, /ACTIONS.*\| HOSTS \[current\]/s)
  assert.equal(hasSgr(output.text), false)
})

test('searchable split selector handles search escape, resize, narrow fallback, and quit', async () => {
  const { input, output } = terminalPair()
  output.columns = 60
  output.rows = 18
  const ui = new TerminalUi({ input, output })
  const selecting = ui.searchableSplitChoose({
    title: 'Dashboard',
    actions: [{ label: 'Browse hosts', value: 'browse', focusRows: true }],
    rows: [{ value: 'alpha', searchText: 'alpha', label: 'alpha' }],
    renderRow: row => row.label,
    renderDetails: row => [`Host: ${row?.value ?? 'none'}`],
    footerHints: ['q quit']
  })
  input.emit('keypress', '', { name: 'tab' })
  input.emit('keypress', '/', { name: undefined })
  input.emit('keypress', 'z', { name: 'z' })
  assert.match(output.text, /No hosts match "z"/)
  input.emit('keypress', '', { name: 'escape' })
  input.emit('keypress', '', { name: 'escape' })
  output.columns = 100
  output.emit('resize')
  input.emit('keypress', 'q', { name: 'q' })
  assert.deepEqual(await selecting, { type: 'quit' })
  assert.match(output.text, /ACTIONS\n/)
  assert.equal(input.isRaw, false)
})

test('connected split selector redraws on resize and returns actions', async () => {
  const { input, output } = terminalPair()
  output.columns = 100
  const ui = new TerminalUi({ input, output })
  const choosing = ui.splitChoose({
    title: 'Host: alpha',
    actions: [{ label: 'Refresh status', value: 'refresh' }, { label: 'Disconnect', value: 'back' }],
    details: ['SSH: connected'],
    footerHints: ['Enter open']
  })
  output.columns = 64
  output.emit('resize')
  input.emit('keypress', '', { name: 'down' })
  input.emit('keypress', '\r', { name: 'return' })
  assert.equal(await choosing, 'back')
  assert.match(output.text, /HOST ACTIONS/)
  assert.match(output.text, /HOST STATUS/)
})

test('searchable detail selector filters rows and updates the detail preview', async () => {
  const { input, output } = terminalPair()
  output.columns = 110
  const ui = new TerminalUi({ input, output })
  const choosing = ui.searchableDetailChoose({
    title: 'Task history',
    rows: [
      { value: 1, label: '#1 WordPress', searchText: 'wordpress completed', detail: 'Status: completed' },
      { value: 2, label: '#2 nginx', searchText: 'nginx failed', detail: 'Status: failed' }
    ],
    renderRow: row => row.label,
    renderDetails: row => [row.detail],
    resultLabel: 'tasks'
  })
  input.emit('keypress', '', { name: 'down' })
  assert.match(output.text, /Status: failed/)
  input.emit('keypress', '/', { name: undefined })
  input.emit('keypress', 'w', { name: 'w' })
  assert.match(output.text, /1 of 2 tasks/)
  input.emit('keypress', '', { name: 'return' })
  input.emit('keypress', '', { name: 'return' })
  assert.equal(await choosing, 1)
  assert.equal(input.isRaw, false)
})

test('searchable multi-select searches, toggles, selects all, clears, and preserves option order', async () => {
  const { input, output } = terminalPair()
  const ui = new TerminalUi({ input, output })
  const choosing = ui.searchableMultiChoose('Select hosts', [
    { value: 'alpha', label: 'alpha root@alpha.test active', searchText: 'alpha root@alpha.test active linux' },
    { value: 'beta', label: 'beta root@beta.test inactive', searchText: 'beta root@beta.test inactive windows' }
  ])
  input.emit('keypress', '/', { name: undefined })
  input.emit('keypress', 'w', { name: 'w' })
  assert.match(output.text, /1 of 2 hosts/)
  input.emit('keypress', '', { name: 'return' })
  input.emit('keypress', ' ', { name: 'space' })
  input.emit('keypress', 'a', { name: 'a' })
  input.emit('keypress', 'n', { name: 'n' })
  input.emit('keypress', 'a', { name: 'a' })
  input.emit('keypress', '', { name: 'return' })
  assert.deepEqual(await choosing, ['alpha', 'beta'])
  assert.equal(input.isRaw, false)
})

function hasSgr (value) {
  return value.includes(`${String.fromCharCode(27)}[` + '31m') || new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'u').test(value)
}

function terminalPair () {
  const input = new EventEmitter()
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = value => { input.isRaw = value }
  let paused = true
  input.isPaused = () => paused
  input.resume = () => { paused = false }
  input.pause = () => { paused = true }
  const output = new EventEmitter()
  output.isTTY = true
  output.columns = 80
  output.text = ''
  output.write = value => { output.text += value }
  return { input, output }
}
