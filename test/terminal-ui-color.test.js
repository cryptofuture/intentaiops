import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { renderPlan, renderResults } from '../src/cli.js'
import { connectedHostActionOptions } from '../src/cli-display.js'
import { TerminalUi } from '../src/terminal-ui.js'

const ESC = String.fromCharCode(27)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'u')

test('semantic palette colors headings, states, severity, keys, and legacy tones', () => {
  const { input, output } = terminalPair()
  const ui = coloredUi(input, output)
  assert.equal(ui.paint('heading', 'Heading'), ansi('1;96', 'Heading'))
  assert.equal(ui.paint('success', 'active'), ansi('32', 'active'))
  assert.equal(ui.paint('warning', 'inactive'), ansi('33', 'inactive'))
  assert.equal(ui.paint('error', 'failed'), ansi('31', 'failed'))
  assert.equal(ui.paint('muted', 'not probed'), ansi('2', 'not probed'))
  assert.equal(ui.paint('green', 'legacy'), ansi('32', 'legacy'))
  ui.success('done')
  ui.warn('careful')
  ui.error('broken')
  ui.renderKeyHints([['Enter', 'open'], ['Esc', 'back']])
  assert.ok(output.text.includes(ansi('32', 'OK:')))
  assert.ok(output.text.includes(ansi('33', 'WARNING:')))
  assert.ok(output.text.includes(ansi('31', 'ERROR:')))
  assert.ok(output.text.includes(ansi('96', 'Enter')))
  assert.match(stripSgr(output.text), /Enter open \| Esc back/u)
})

test('status, risk, privilege, and fallback semantics use restrained styles', () => {
  const { input, output } = terminalPair()
  const ui = coloredUi(input, output)
  assert.equal(ui.statusStyle('active'), 'success')
  assert.equal(ui.statusStyle('inactive'), 'warning')
  assert.equal(ui.statusStyle('not probed'), 'muted')
  assert.equal(ui.statusStyle('connecting'), 'info')
  assert.equal(ui.statusStyle('revert_failed'), 'error')
  ui.line('Privilege', 'root')
  ui.line('Risk', 'high')
  ui.line('Root required', 'yes')
  ui.line('Effective administrator email', 'intentaiops@example.invalid (non-deliverable fallback)', 'warning')
  assert.ok(output.text.includes(ansi('33', 'root')))
  assert.ok(output.text.includes(ansi('1;91', 'high')))
  assert.ok(output.text.includes(ansi('33', 'yes')))
  assert.ok(output.text.includes(ansi('33', 'intentaiops@example.invalid (non-deliverable fallback)')))
})

test('NO_COLOR and non-TTY output disable all application SGR styling', () => {
  const first = terminalPair()
  const noColor = new TerminalUi({ ...first, env: { NO_COLOR: '1', TERM: 'xterm-256color' }, color: true })
  noColor.banner('Plain')
  noColor.success('active')
  assert.equal(SGR.test(first.output.text), false)

  const second = terminalPair()
  second.output.isTTY = false
  const nonTty = new TerminalUi({ ...second, env: { TERM: 'xterm-256color' }, color: true })
  nonTty.error('plain error')
  assert.equal(SGR.test(second.output.text), false)

  const detected = terminalPair()
  detected.output.getColorDepth = () => 8
  const automatic = new TerminalUi({ ...detected, env: { TERM: 'xterm-256color' } })
  assert.equal(automatic.paint('success', 'ready'), ansi('32', 'ready'))
})

test('styled tables retain visible widths and color only semantic cells', () => {
  const { input, output } = terminalPair()
  output.columns = 52
  const ui = coloredUi(input, output)
  const lines = ui.renderTable([
    { key: 'host', label: 'HOST', width: 20 },
    { key: 'state', label: 'STATUS', flex: 1, style: value => ui.statusStyle(value) }
  ], [
    { host: 'production-long-host-name', state: 'active' },
    { host: 'new-host', state: 'not probed' }
  ], { width: 52, selectedIndex: 0 })
  assert.ok(lines.every(line => Array.from(stripSgr(line)).length <= 52))
  assert.ok(lines.join('\n').includes(`${ESC}[1;96m`))
  assert.ok(lines.join('\n').includes(`${ESC}[2mnot probed`))
  assert.match(stripSgr(lines.join('\n')), /> production-long-hos…\s+active/u)
})

test('colored dashboard keeps focused and remembered selections distinct', async () => {
  const { input, output } = terminalPair()
  output.columns = 130
  output.rows = 24
  const ui = coloredUi(input, output)
  const choosing = ui.searchableSplitChoose({
    title: 'Main dashboard',
    summaryLines: [
      'Data directory: /tmp/webminai',
      ui.styleTokens('Hosts: 1 | Stage 2 desired: 1 active / 0 inactive', [
        { text: '1 active', style: 'success' },
        { text: '0 inactive', style: 'muted' }
      ]),
      ui.styleToken('Default administrator email: intentaiops@example.invalid', 'intentaiops@example.invalid', 'warning')
    ],
    actions: [{ label: 'Browse/search hosts', value: 'browse', focusRows: true }, { label: 'Quit', value: 'quit' }],
    rows: [{ value: 'alpha', label: 'alpha root@example.test [not probed]', searchText: 'alpha not probed', runtime: 'not probed' }],
    renderRow: row => ui.styleToken(row.label, row.runtime, ui.statusStyle(row.runtime)),
    renderDetails: () => ['Host: alpha', 'Runtime: not probed'],
    footerHints: [['Tab', 'pane'], ['Enter', 'open'], ['/', 'search']]
  })
  assert.ok(output.text.includes(`${ESC}[1;96m> Browse/search hosts`))
  assert.ok(output.text.includes(`${ESC}[33mintentaiops@example.invalid`))
  input.emit('keypress', '', { name: 'tab' })
  assert.ok(output.text.includes(`${ESC}[1;96m> alpha root@example.test`))
  assert.match(stripSgr(output.text), /ACTIONS.*HOSTS.*HOST DETAILS/su)
  input.emit('keypress', '', { name: 'escape' })
  assert.equal(await choosing, null)
})

test('connected-host rendering emphasizes focus, status, privilege, and destructive action', async () => {
  const { input, output } = terminalPair()
  output.columns = 110
  const ui = coloredUi(input, output)
  const actions = connectedHostActionOptions({
    status: { capabilities: { platform: { os: 'linux' } } },
    dockerPreference: 'auto'
  })
  const choosing = ui.splitChoose({
    title: 'Host: production',
    actions,
    details: ['SSH: connected', 'Privilege: root', 'Netdata: installed', 'Intent AI Ops plugin: v1.4.0 (current)', 'Stage 2 health: active'],
    footerHints: [['Enter', 'open'], ['Esc', 'disconnect']]
  })
  assert.ok(output.text.includes(`${ESC}[1;96m> Refresh status`))
  assertStyledFragment(output.text, '1;91', 'Remove plugin and Intent AI Ops')
  assertStyledFragment(output.text, '33', 'root')
  assertStyledFragment(output.text, '32', 'connected')
  assert.match(stripSgr(output.text), /HOST ACTIONS.*HOST STATUS/su)
  input.emit('keypress', '', { name: 'escape' })
  assert.equal(await choosing, null)
})

test('plan commands and raw result streams are never recolored', () => {
  const { input, output } = terminalPair()
  const ui = coloredUi(input, output)
  const command = 'printf "redirection > file" | sed "s/x/y/"'
  const stdout = 'raw stdout value'
  const stderr = 'raw stderr value'
  renderPlan(ui, {
    summary: 'Test plan',
    changeOverview: 'No-op test',
    requiresConfirmation: true,
    modifiedFiles: [],
    warnings: [],
    commands: [{ id: 'one', purpose: 'test', risk: 'high', timeoutMs: 1000, requiresSudo: true, command }],
    revertCommands: []
  })
  renderResults(ui, [{ id: 'one', status: 'failed', result: { stdout, stderr } }])
  assert.ok(output.text.includes(`${command}\n`))
  assert.ok(output.text.includes(`${stdout}\n`))
  assert.ok(output.text.includes(`${stderr}\n`))
  assert.doesNotMatch(command, SGR)
  assert.ok(output.text.includes(ansi('36', 'stdout')))
  assert.ok(output.text.includes(ansi('31', 'stderr')))
  assert.ok(output.text.includes(ansi('1;91', 'high')))
})

function stripSgr (value) {
  return String(value).replace(new RegExp(SGR.source, 'gu'), '')
}

function ansi (code, value) {
  return `${ESC}[${code}m${value}${ESC}[0m`
}

function assertStyledFragment (value, code, fragment) {
  const start = value.indexOf(`${ESC}[${code}m`)
  assert.notEqual(start, -1)
  const end = value.indexOf(`${ESC}[0m`, start)
  assert.ok(value.slice(start, end).includes(fragment))
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
  output.rows = 24
  output.text = ''
  output.write = value => { output.text += value }
  return { input, output }
}

function coloredUi (input, output) {
  return new TerminalUi({ input, output, env: { TERM: 'xterm-256color' }, color: true })
}
