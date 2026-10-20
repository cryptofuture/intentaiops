import test from 'node:test'
import assert from 'node:assert/strict'
import { updateTerminalColors } from '../web/terminal-colors.js'

test('terminal recolors existing light cells for dark themes without mutating their evidence', () => {
  const cells = []
  const renderer = { renderCellBackground: cell => cells.push(cell), renderCellText: cell => cells.push(cell) }
  const light = { foreground: '#111111', background: '#ffffff', red: '#ff0000' }
  const dark = { foreground: '#eeeeee', background: '#222222', red: '#ff3333' }
  const cell = { fg_r: 17, fg_g: 17, fg_b: 17, bg_r: 255, bg_g: 255, bg_b: 255, codepoint: 65 }
  updateTerminalColors(renderer, light, dark)
  renderer.renderCellBackground(cell)
  renderer.renderCellText(cell)
  assert.deepEqual(cells[0], { ...cell, fg_r: 238, fg_g: 238, fg_b: 238, bg_r: 34, bg_g: 34, bg_b: 34 })
  assert.deepEqual(cells[1], cells[0])
  assert.equal(cell.bg_r, 255)
  updateTerminalColors(renderer, light, light)
  renderer.renderCellText(cell)
  assert.deepEqual(cells[2], cell)
  const custom = { ...cell, fg_r: 12, fg_g: 34, fg_b: 56 }
  updateTerminalColors(renderer, light, dark)
  renderer.renderCellText(custom)
  assert.equal(cells[3].fg_r, 12)
})
