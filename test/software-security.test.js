import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { applicationSecurityReport, assessRuntimeVersion, parseSecurityEvidence, PHP_FIXED, NEXT_FIXED, recordApplicationSecurity, securityRemediationInstructions } from '../src/software-security.js'
import { softwareSecurityCommand } from '../src/software-security-collector.js'
import { auditCatalogSecurity, catalogSecurityInventory, matchesAdvisoryRange } from '../src/catalog-security-audit.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { validateWindowsPlan } from '../src/planner-platform-policy.js'

test('PHP and Next.js branch floors reject earlier patches without treating unknown versions as safe', () => {
  for (const [name, floors] of [['php', PHP_FIXED], ['next', NEXT_FIXED]]) {
    for (const fixed of Object.values(floors)) {
      const parts = fixed.split('.').map(Number)
      assert.equal(assessRuntimeVersion(name, fixed).status, 'meets_tracked_floor')
      assert.equal(assessRuntimeVersion(name, [...parts.slice(0, 2), parts[2] - 1].join('.')).status, 'potentially_vulnerable')
    }
    for (const version of ['latest', '^8.4.27', '8.4.27RC1', '8.4.27-rc.1', '8.4.27-dev', '99.1.0', '', null]) assert.equal(assessRuntimeVersion(name, version).status, 'unknown')
  }
  assert.equal(assessRuntimeVersion('php', '7.4.33').status, 'potentially_vulnerable')
  assert.equal(assessRuntimeVersion('php', '8.2.34-1+deb12u1').status, 'potentially_vulnerable')
  assert.equal(assessRuntimeVersion('next', '13.5.0').fixedVersion, '14.2.35')
  assert.equal(assessRuntimeVersion('react', '19.0.0').status, 'not_applicable')
})

test('RSC checks include follow-up fixes rather than stopping at the original RCE patch', () => {
  for (const name of ['react-server-dom-webpack', 'react-server-dom-parcel', 'react-server-dom-turbopack']) {
    for (const version of ['19.0.1', '19.1.2', '19.2.1', '19.2.3']) assert.equal(assessRuntimeVersion(name, version).status, 'potentially_vulnerable')
    for (const version of ['19.0.4', '19.1.5', '19.2.4']) assert.equal(assessRuntimeVersion(name, version).status, 'meets_tracked_floor')
  }
})

test('security evidence accepts bounded allowlisted versions, not raw logs or secrets', () => {
  const evidence = stdout => [{ id: 'audit-software-security', status: 'completed', result: { stdout } }]
  const result = parseSecurityEvidence(evidence('password=SECRET\nINTENT_SECURITY_PHP host-cli 8.4.26\nINTENT_SECURITY_NPM runtime next 15.5.0\nINTENT_SECURITY_PHP SECRET 8.4.26\nINTENT_SECURITY_END'))
  assert.equal(result.complete, true)
  assert.equal(result.observations.length, 2)
  assert.doesNotMatch(JSON.stringify(result), /SECRET/u)
  assert.equal(parseSecurityEvidence(evidence('x'.repeat(32769))).complete, false)
  assert.equal(parseSecurityEvidence([{ id: 'audit-software-security', status: 'completed', result: { stdout: 'INTENT_SECURITY_END', stdoutTruncated: true } }]).complete, false)
  const report = applicationSecurityReport('moodle-windows', evidence('INTENT_SECURITY_PHP host-cli 8.4.26\nINTENT_SECURITY_END'))
  assert.match(report.answer, /ATTENTION/u)
  assert.match(report.answer, /session.upload_progress.enabled=0/u)
  assert.match(report.answer, /not a substitute/u)
  assert.equal(applicationSecurityReport('host-health-windows'), null)
})

test('every host platform includes an explicitly reviewed read-only security step after installation', () => {
  for (const platform of ['linux', 'freebsd', 'macos', 'windows']) {
    const built = buildCommonTask(`intent-ai-ops-${platform}`, 123, { platform })
    const step = built.plan.commands.at(-1)
    assert.equal(step.id, 'audit-software-security')
    assert.equal(step.risk, 'read')
    assert.deepEqual(step.dependsOn, built.plan.commands.slice(0, -1).map(command => command.id))
    assert.ok(step.source)
    assert.doesNotMatch(step.command, /https?:\/\/|Invoke-WebRequest|curl |npm install|pnpm install/u)
    if (platform === 'windows') validateWindowsPlan({ ...built.plan, commands: [{ ...step, dependsOn: [] }], revertCommands: [] }, { webminaiExecution: { commands: {} } }, 'Inspect versions', { requireRevert: false })
    else assert.equal(spawnSync('/bin/sh', ['-n'], { input: step.command, encoding: 'utf8' }).status, 0)
  }
  assert.doesNotMatch(softwareSecurityCommand('freebsd', 'wordpress'), /\bdocker(?:-compose)?\s/u)
})

test('the native collector runs only version/manifest reads and produces usable warnings', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-security-'))
  try {
    await writeFile(path.join(root, 'php'), '#!/bin/sh\nprintf 8.4.26\n', { mode: 0o700 })
    const result = spawnSync('/bin/sh', ['-c', softwareSecurityCommand('linux', 'intent-ai-ops')], { env: { PATH: root + ':/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /INTENT_SECURITY_PHP host-cli-php 8.4.26/u)
    const report = applicationSecurityReport('intent-ai-ops-linux', [{ id: 'audit-software-security', status: 'completed', result: { stdout: result.stdout } }])
    assert.equal(report.observations[0].status, 'potentially_vulnerable')
    assert.equal(report.complete, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('security recommendations persist without AI calls or remote mutations', () => {
  const progress = []
  const admin = { appendTaskProgress: (...args) => progress.push(args), consult: () => assert.fail('Security reporting must be deterministic') }
  const report = recordApplicationSecurity({ admin, serverId: 'host', task: { id: 12, catalogId: 'ghost-linux' }, results: [] })
  assert.equal(progress[0][2].type, 'security_report')
  assert.match(report.answer, /unknown/u)
})

test('remediation uses allowlisted evidence, rejects incomplete evidence and checks the latest assessment', () => {
  const result = (id, stdout, status = 'completed') => ({ id, status, result: { stdout } })
  const old = result('audit-software-security', 'INTENT_SECURITY_PHP container-012345abcdef 8.4.23\nSECRET=discard\nINTENT_SECURITY_END')
  const instructions = securityRemediationInstructions([old])
  assert.match(instructions, /8.4.27/u)
  assert.match(instructions, /recreate only affected services/u)
  assert.match(instructions, /vendor backports/u)
  assert.doesNotMatch(instructions, /SECRET/u)
  assert.throws(() => securityRemediationInstructions([]), /incomplete/u)
  assert.throws(() => securityRemediationInstructions([old, result('audit-software-security-012345abcdef', 'INTENT_SECURITY_END', 'failed')]), /incomplete/u)
  assert.throws(() => securityRemediationInstructions([old, result('audit-software-security-012345abcdef', 'INTENT_SECURITY_PHP container-012345abcdef 8.4.27\nINTENT_SECURITY_END')]), /No actionable/u)
  assert.throws(() => securityRemediationInstructions([old, result('audit-software-security-catalog-012345abcdef', 'INTENT_SECURITY_PHP container-012345abcdef 8.4.27\nINTENT_SECURITY_END')]), /No actionable/u)
})

test('catalog audit covers every application on all five targets without asserting installed security', () => {
  const rows = catalogSecurityInventory()
  assert.equal(rows.length, 76)
  assert.deepEqual(new Set(rows.map(row => row.platform)), new Set(['linux', 'freebsd', 'macos', 'windows', 'kubernetes']))
  assert.ok(rows.every(row => row.verdict === 'needs_validation' && row.severity === null))
  for (const platform of ['linux', 'freebsd', 'macos', 'windows', 'kubernetes']) assert.ok(rows.find(row => row.catalogId === `moodle-${platform}`).declaredPins.some(pin => pin.startsWith('php:8.4.27-fpm-bookworm@sha256:')))
})

test('public advisory ranges distinguish bounded comparisons from unsupported selectors', () => {
  assert.equal(matchesAdvisoryRange('2.33.7', '>= 2.0.0, < 2.34.0'), true)
  assert.equal(matchesAdvisoryRange('2.34.0', '>= 2.0.0, < 2.34.0'), false)
  assert.equal(matchesAdvisoryRange('2.4.8-p5', '<= 2.4.8-p3'), false)
  for (const range of ['*', '^2.0.0', '>= 2.0.0 || < 1.0.0', 'malformed']) assert.equal(matchesAdvisoryRange('2.1.0', range), null)
})

test('online audit treats missing feeds and matching source pins as unresolved candidates, never approvals', async () => {
  const calls = []
  const report = await auditCatalogSecurity({
    online: true,
    fetchImpl: async (url, options) => {
      calls.push(url)
      assert.equal(new URL(url).hostname, 'api.github.com')
      assert.equal(options.redirect, 'error')
      if (!url.includes('n8n-io/n8n')) return new Response('', { status: 404 })
      if (url.endsWith('/latest')) return Response.json({ tag_name: 'n8n@2.34.0', prerelease: false })
      return Response.json([{ ghsa_id: 'GHSA-aaaa-bbbb-cccc', vulnerabilities: [{ package: { name: 'n8n' }, vulnerable_version_range: '>= 2.0.0, < 2.34.0' }] }])
    }
  })
  assert.equal(report.entries.find(row => row.catalogId === 'n8n-linux').findings.length, 1)
  assert.equal(report.entries.find(row => row.catalogId === 'wordpress-linux').vendor.release, null)
  assert.ok(calls.length < report.entries.length)
  assert.ok(report.entries.every(row => row.verdict === 'needs_validation'))
})
