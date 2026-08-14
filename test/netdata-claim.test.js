import assert from 'node:assert/strict'
import test from 'node:test'
import { parseClaimingInput, validateClaimDetails } from '../src/netdata-claim.js'

const token = 'A'.repeat(48)
const room = '34ca9c79-2354-4300-b90f-29575e338f02'

test('claiming parser extracts a generated kickstart command without executing it', () => {
  const input = `curl https://get.netdata.cloud/kickstart.sh > /tmp/netdata-kickstart.sh && sh /tmp/netdata-kickstart.sh --nightly-channel --claim-token ${token} --claim-rooms ${room} --claim-url https://app.netdata.cloud`
  assert.deepEqual(parseClaimingInput(input), {
    claimToken: token,
    claimUrl: 'https://app.netdata.cloud',
    roomIds: room,
    missing: []
  })
})

test('claiming parser accepts Docker, Helm, and claiming-details formats', () => {
  const docker = `-e NETDATA_CLAIM_TOKEN=${token} -e NETDATA_CLAIM_URL=https://app.netdata.cloud -e NETDATA_CLAIM_ROOMS=${room}`
  assert.equal(parseClaimingInput(docker).claimToken, token)
  const helm = `--set parent.claiming.token=${token} --set parent.claiming.rooms=${room}`
  assert.deepEqual(parseClaimingInput(helm).missing, ['claim URL'])
  const details = `Claim Token\n${token}\nClaim URL\nhttps://app.netdata.cloud\nRoom IDs\n${room}`
  assert.deepEqual(parseClaimingInput(details).missing, [])
})

test('claiming parser reports missing data and rejects conflicts', () => {
  assert.deepEqual(parseClaimingInput(token).missing, ['claim URL', 'room IDs'])
  assert.throws(() => parseClaimingInput(`--claim-token ${token} --claim-token ${'B'.repeat(48)}`), /conflicting claim token/)
})

test('claim details require a secret-shaped token, HTTPS URL, and UUID rooms', () => {
  assert.deepEqual(validateClaimDetails({ claimToken: token, claimUrl: 'https://app.netdata.cloud/', roomIds: room }), {
    claimToken: token,
    claimUrl: 'https://app.netdata.cloud',
    roomIds: room
  })
  assert.throws(() => validateClaimDetails({ claimToken: 'short', claimUrl: 'https://app.netdata.cloud', roomIds: room }), /claim token/)
  assert.throws(() => validateClaimDetails({ claimToken: token, claimUrl: 'http://app.netdata.cloud', roomIds: room }), /HTTPS/)
  assert.throws(() => validateClaimDetails({ claimToken: token, claimUrl: 'https://user:pass@app.netdata.cloud', roomIds: room }), /must not contain credentials/)
  assert.throws(() => validateClaimDetails({ claimToken: token, claimUrl: 'https://app.netdata.cloud', roomIds: 'not-a-room' }), /UUIDs/)
})
