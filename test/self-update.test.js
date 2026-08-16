import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  PACKAGE_CHECKSUM_URL,
  PACKAGE_UPDATE_URL,
  POSIX_UPDATE_URL,
  updateIntentAiOps,
  WINDOWS_UPDATE_URL
} from '../src/self-update.js'

const posixInstaller = '#!/bin/sh\nINTENTAI_OPS_PACKAGE_URL=https://example.test/package.tgz\n'
const windowsInstaller = "$ErrorActionPreference = 'Stop'\n$env:INTENTAI_OPS_PACKAGE_URL = 'test'\n"
const packageBytes = Buffer.from('verified package fixture')

test('self-update verifies the package and runs the POSIX bootstrap with the local archive', async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'intentaiops-update-test-'))
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const requests = []
  let invocation
  const result = await updateIntentAiOps({
    platform: 'linux',
    temporaryRoot,
    fetchInstaller: successfulFetcher(posixInstaller, requests),
    runInstaller: async (command, args, environment) => {
      invocation = {
        command,
        environment,
        source: await readFile(args[0], 'utf8'),
        package: await readFile(environment.INTENTAI_OPS_PACKAGE_URL)
      }
      return 0
    }
  })

  assert.deepEqual(requests, [POSIX_UPDATE_URL, PACKAGE_UPDATE_URL, PACKAGE_CHECKSUM_URL])
  assert.equal(invocation.command, 'sh')
  assert.equal(invocation.source, posixInstaller)
  assert.deepEqual(invocation.package, packageBytes)
  assert.match(invocation.environment.INTENTAI_OPS_PACKAGE_URL, /intent-ai-ops\.tgz$/u)
  assert.deepEqual(result, { url: POSIX_UPDATE_URL, packageUrl: PACKAGE_UPDATE_URL })
  assert.deepEqual(await readdir(temporaryRoot), [])
})

test('self-update uses the Windows PowerShell bootstrap and verified local archive', async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'intentaiops-update-test-'))
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const requests = []
  let invocation
  await updateIntentAiOps({
    platform: 'win32',
    temporaryRoot,
    fetchInstaller: successfulFetcher(windowsInstaller, requests),
    runInstaller: async (command, args, environment) => {
      invocation = {
        command,
        args,
        source: await readFile(args.at(-1), 'utf8'),
        package: await readFile(environment.INTENTAI_OPS_PACKAGE_URL)
      }
      return 0
    }
  })

  assert.deepEqual(requests, [WINDOWS_UPDATE_URL, PACKAGE_UPDATE_URL, PACKAGE_CHECKSUM_URL])
  assert.equal(invocation.command, 'powershell.exe')
  assert.deepEqual(invocation.args.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
  assert.equal(invocation.source, windowsInstaller)
  assert.deepEqual(invocation.package, packageBytes)
})

test('self-update rejects HTTP errors and invalid installers', async () => {
  await assert.rejects(updateIntentAiOps({
    fetchInstaller: async () => ({ ok: false, status: 404 })
  }), /HTTP 404/u)
  await assert.rejects(updateIntentAiOps({
    fetchInstaller: successfulFetcher('#!/bin/sh\n')
  }), /installer failed validation/u)
})

test('self-update rejects malformed and mismatched package checksums', async () => {
  await assert.rejects(updateIntentAiOps({
    fetchInstaller: successfulFetcher(posixInstaller, [], { checksum: 'not-a-checksum\n' })
  }), /checksum has an invalid format/u)
  await assert.rejects(updateIntentAiOps({
    fetchInstaller: successfulFetcher(posixInstaller, [], { checksum: `${'0'.repeat(64)}  intent-ai-ops.tgz\n` })
  }), /SHA-256 verification failed/u)
})

test('self-update propagates a failed installer after checksum verification', async () => {
  await assert.rejects(updateIntentAiOps({
    fetchInstaller: successfulFetcher(posixInstaller),
    runInstaller: async () => 9
  }), /exited with code 9/u)
})

function successfulFetcher (installer, requests = [], { checksum = packageChecksum(packageBytes) } = {}) {
  return async (url, options) => {
    requests.push(url)
    assert.deepEqual(options, { redirect: 'follow' })
    const bytes = url === PACKAGE_UPDATE_URL
      ? packageBytes
      : url === PACKAGE_CHECKSUM_URL
        ? Buffer.from(checksum)
        : Buffer.from(installer)
    return { ok: true, status: 200, arrayBuffer: async () => bytes }
  }
}

function packageChecksum (bytes) {
  return `${createHash('sha256').update(bytes).digest('hex')}  intent-ai-ops.tgz\n`
}
