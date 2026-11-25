import test from 'node:test'
import assert from 'node:assert/strict'
import { currentMessageText, gmailThreadUrl, makeMessage, replyDetails, summarizeThread, threadIdFromUrl } from '../server/gmail.js'

test('accepts only Gmail thread links', () => {
  assert.equal(threadIdFromUrl('https://mail.google.com/mail/u/0/#all/18c9b10f0a123456'), '18c9b10f0a123456')
  assert.equal(threadIdFromUrl('https://example.com/#all/18c9b10f0a123456'), '')
  assert.equal(threadIdFromUrl('http://mail.google.com/mail/u/0/#all/18c9b10f0a123456'), '')
  assert.equal(threadIdFromUrl('https://mail.google.com/mail/u/0/#all/short'), '')
  assert.equal(threadIdFromUrl('18c9b10f0a123456'), '18c9b10f0a123456')
  assert.equal(threadIdFromUrl(gmailThreadUrl('18c9b10f0a123456')), '18c9b10f0a123456')
  assert.equal(threadIdFromUrl('https://mail.google.com/mail/?authuser=creator%40example.com#all/thread-f:1234567890123456789'), BigInt('1234567890123456789').toString(16))
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

test('includes a PDF attachment in the threaded MIME message', () => {
  const bytes = Buffer.from('%PDF-1.7\nexample')
  const message = makeMessage({ from: 'creator@example.com', to: 'brand@example.com', subject: 'Re: Brief', body: 'Attached is the PR kit.', threadId: '18c9b10f0a123456', replyToId: '<first@example.com>', attachments: [{ name: 'PR kit.pdf', type: 'application/pdf', data: bytes.toString('base64') }] })
  const mime = Buffer.from(message.raw, 'base64url').toString('utf8')
  assert.equal(message.threadId, '18c9b10f0a123456')
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="cp_[a-f\d]+"/)
  assert.match(mime, /Content-Disposition: attachment; filename="PR kit.pdf"; filename\*=UTF-8''PR%20kit.pdf/)
  assert.match(mime, /In-Reply-To: <first@example.com>/)
  assert.ok(mime.includes(bytes.toString('base64')))
})

test('rejects oversized and malformed attachments', () => {
  const base = { from: 'creator@example.com', to: 'brand@example.com', subject: 'Brief', body: 'Here it is.' }
  assert.throws(() => makeMessage({ ...base, attachments: [{ name: 'large.pdf', data: Buffer.alloc(2.5 * 1024 * 1024 + 1).toString('base64') }] }), /2.5 MB/)
  assert.throws(() => makeMessage({ ...base, attachments: [{ name: 'fake.pdf', data: 'not base64' }] }), /Invalid attachment/)
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

test('keeps the full body of an HTML-only email as safe text', () => {
  const body = Buffer.from('<p>Hi &amp; welcome</p><p>Brief attached.</p><script>ignore()</script>').toString('base64url')
  const thread = summarizeThread({ id: 'thread1', messages: [{ id: 'm1', payload: { mimeType: 'text/html', body: { data: body } } }] })
  assert.equal(thread.messages[0].body, 'Hi & welcome\nBrief attached.')
})

test('shows only the newly written part of a reply', () => {
  const body = 'Hi, the revised brief is attached.\nPlease confirm the posting date.\n\nOn Mon, 23 Nov 2026 at 10:00, Brand <brand@example.com> wrote:\n> Earlier email\n> Older details'
  assert.equal(currentMessageText(body), 'Hi, the revised brief is attached.\nPlease confirm the posting date.')
  const thread = summarizeThread({ id: 'thread1', messages: [{ id: 'm1', payload: { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } } }] })
  assert.equal(thread.messages[0].body, 'Hi, the revised brief is attached.\nPlease confirm the posting date.')
})

test('removes Outlook and Gmail HTML quoted history without trimming a standalone email', () => {
  assert.equal(currentMessageText('Current update\n\nFrom: Brand <brand@example.com>\nSent: Monday\nSubject: Old\nOld body'), 'Current update')
  const html = '<div>Current update and the new deliverables.</div><div class="gmail_quote"><div>Old reply</div></div>'
  const thread = summarizeThread({ id: 'thread1', messages: [{ id: 'm1', payload: { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } } }] })
  assert.equal(thread.messages[0].body, 'Current update and the new deliverables.')
  assert.equal(currentMessageText('Current update\n> One quoted line used as an example'), 'Current update\n> One quoted line used as an example')
})

test('fills a reply from the latest conversation and external participant', () => {
  const thread = { messages: [
    { from: 'Brand <brand@example.com>', to: 'creator@example.com', subject: 'Collaboration', messageId: '<one@example.com>', references: '', sent: false },
    { from: 'creator@example.com', to: 'Brand <brand@example.com>', subject: 'Collaboration', messageId: '<two@example.com>', references: '<one@example.com>', sent: true },
    { from: 'creator@example.com', to: 'brand@example.com', subject: 'Collaboration', messageId: '', draft: true },
  ] }
  assert.deepEqual(replyDetails(thread, 'creator@example.com'), { to: 'brand@example.com', subject: 'Collaboration', replyToId: '<two@example.com>', references: '<one@example.com>' })
})
