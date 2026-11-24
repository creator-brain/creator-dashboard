import test from 'node:test'
import assert from 'node:assert/strict'
import { makeMessage, summarizeThread, threadIdFromUrl } from '../server/gmail.js'

test('accepts only Gmail thread links', () => {
  assert.equal(threadIdFromUrl('https://mail.google.com/mail/u/0/#all/18c9b10f0a123456'), '18c9b10f0a123456')
  assert.equal(threadIdFromUrl('https://example.com/#all/18c9b10f0a123456'), '')
  assert.equal(threadIdFromUrl('https://mail.google.com/mail/u/0/#all/short'), '')
})

test('formats a safe threaded plain-text Gmail message', () => {
  const message = makeMessage({ from: 'creator@example.com', to: 'brand@example.com', subject: 'Re: Sample', body: 'Hello\nBrand', threadId: '18c9b10f0a123456', replyToId: '<first@example.com>', references: '<older@example.com>' })
  assert.equal(message.threadId, '18c9b10f0a123456')
  const mime = Buffer.from(message.raw, 'base64url').toString('utf8')
  assert.match(mime, /^From: creator@example.com$/m)
  assert.match(mime, /^To: brand@example.com$/m)
  assert.match(mime, /In-Reply-To: <first@example.com>/)
  assert.match(mime, /References: <older@example.com> <first@example.com>/)
  assert.ok(!mime.includes('\r\nBcc:'))
  const body = mime.split('\r\n\r\n')[1].replace(/\s/g, '')
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Hello\r\nBrand')
})

test('rejects invalid recipients and blank bodies', () => {
  assert.throws(() => makeMessage({ from: 'creator@example.com', to: 'bad', subject: 'Hello', body: 'Text' }), /valid recipient/)
  assert.throws(() => makeMessage({ from: 'creator@example.com', to: 'brand@example.com\r\nBcc: bad@example.com', subject: 'Hello', body: 'Text' }), /valid recipient/)
  assert.throws(() => makeMessage({ from: 'creator@example.com', to: 'brand@example.com', subject: 'Hello', body: ' ' }), /email body/)
})

test('extracts plain text and reply headers from a Gmail thread', () => {
  const body = Buffer.from('Hello from brand').toString('base64url')
  const result = summarizeThread({ id: 'thread1', messages: [{ id: 'm1', internalDate: '1000', labelIds: [], payload: { headers: [{ name: 'From', value: 'Brand <brand@example.com>' }, { name: 'Subject', value: 'Offer' }, { name: 'Message-ID', value: '<m1@example.com>' }], parts: [{ mimeType: 'text/plain', body: { data: body } }] } }] })
  assert.equal(result.messages[0].body, 'Hello from brand')
  assert.equal(result.messages[0].messageId, '<m1@example.com>')
  assert.equal(result.messages[0].sent, false)
})
