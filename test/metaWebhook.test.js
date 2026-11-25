import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { validWebhookSignature, webhookChallenge } from '../server/metaWebhook.js'

test('returns Meta challenge only for the configured verification token', () => {
  const request = { 'hub.mode': 'subscribe', 'hub.challenge': '1234567', 'hub.verify_token': 'long-random-token' }
  assert.equal(webhookChallenge(request, 'long-random-token'), '1234567')
  assert.equal(webhookChallenge(request, 'different-token'), null)
  assert.equal(webhookChallenge({ ...request, 'hub.mode': 'unsubscribe' }, 'long-random-token'), null)
  assert.equal(webhookChallenge(request, ''), null)
})

test('accepts only a valid signed Meta payload', () => {
  const body = Buffer.from('{"object":"instagram","entry":[]}')
  const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`
  assert.equal(validWebhookSignature(body, signature, 'app-secret'), true)
  assert.equal(validWebhookSignature(Buffer.from('{}'), signature, 'app-secret'), false)
  assert.equal(validWebhookSignature(body, signature, 'other-secret'), false)
  assert.equal(validWebhookSignature(body, 'sha256=bad', 'app-secret'), false)
  assert.equal(validWebhookSignature(body, '', 'app-secret'), false)
})
