import assert from 'node:assert/strict'
import test from 'node:test'
import { startExecutionHeartbeat } from '../src/execution-heartbeat.js'

for (const mode of ['normal', 'delay', 'clock-change', 'lost', 'report-failed']) {
  test(`execution heartbeat records ${mode} without reclaiming ownership or replaying work`, t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let wall = 100000
    t.mock.method(Date, 'now', () => wall)
    let monotonic = 0
    t.mock.method(performance, 'now', () => monotonic)
    let renewals = 0
    const events = []
    const lost = new Error('execution ownership expired or changed')
    const heartbeat = startExecutionHeartbeat({
      renewExecution (host, task, owner) {
        assert.deepEqual([host, task, owner], ['host', 42, 'private-owner'])
        renewals++
        if (['lost', 'report-failed'].includes(mode)) throw lost
      },
      appendProgress (host, task, event) {
        if (mode === 'report-failed') throw new Error('storage unavailable')
        events.push(event)
      }
    }, 'host', 42, 'private-owner')
    monotonic = mode === 'delay' ? 35000 : 10000
    wall += mode === 'delay' ? 35000 : mode === 'clock-change' ? 70000 : 10000
    t.mock.timers.tick(10000)
    assert.equal(renewals, 1)
    if (['lost', 'report-failed'].includes(mode)) {
      assert.throws(() => heartbeat.check(), error => error === lost)
      t.mock.timers.tick(10000)
      assert.equal(renewals, 1)
      assert.throws(() => heartbeat.check(), error => error === lost)
    } else heartbeat.check()
    assert.equal(events.length, ['normal', 'report-failed'].includes(mode) ? 0 : 1)
    if (mode === 'delay') assert.equal(events[0].elapsedMs, 35000)
    if (mode === 'clock-change') assert.equal(events[0].wallClockDeltaMs, 60000)
    assert.ok(!JSON.stringify(events).includes('private-owner'))
    heartbeat.stop()
    t.mock.timers.tick(10000)
    assert.equal(renewals, 1)
  })
}
