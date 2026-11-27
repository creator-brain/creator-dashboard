import test from 'node:test'
import assert from 'node:assert/strict'
import { currentMessageText, gmailThreadUrl, makeMessage, replyDetails, summarizeThread, threadIdFromUrl } from '../server/gmail.js'
import { threadMessageLinks } from '../src/messageLinks.js'

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
  assert.equal(result.messages[0].outgoing, false)
})

test('identifies outgoing Gmail messages from the connected address or Sent label', () => {
  const thread = summarizeThread({ messages: [
    { payload: { headers: [{ name: 'From', value: 'Creator <Creator@example.com>' }] } },
    { labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'Alias <alias@example.com>' }] } },
    { payload: { headers: [{ name: 'From', value: 'Brand <brand@example.com>' }, { name: 'To', value: 'creator@example.com' }] } },
  ] }, 'creator@example.com')
  assert.deepEqual(thread.messages.map(message => message.outgoing), [true, true, false])
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

test('reports web links and attached files on the current Gmail message', () => {
  const html = '<p>Read the <a href="https://brand.example/brief?one=1&amp;two=2"><b>campaign brief</b></a>.</p>' +
    '<p><a href="javascript:alert(1)">Unsafe</a></p><div class="gmail_quote"><a href="https://brand.example/older">Old brief</a></div>'
  const encode = value => Buffer.from(value).toString('base64url')
  const part = (mimeType, body, filename = '') => ({ mimeType, body, filename })
  const { messages: [mail] } = summarizeThread({ messages: [{ id: 'm1', payload: { parts: [
    { parts: [part('text/plain', { data: encode('Read the campaign brief.') }), part('text/html', { data: encode(html) })] },
    part('application/pdf', { size: 42, attachmentId: 'secret-provider-id' }, 'Brief.pdf'),
    part('application/octet-stream', { size: 5_000_000, attachmentId: 'large-id' }, 'Rate Card.PDF'),
    part('image/png', { size: 25, attachmentId: 'image-id' }, 'logo.png'),
    { ...part('image/png', { size: 10, attachmentId: 'signature-id' }, 'signature.png'),
      headers: [{ name: 'Content-Disposition', value: 'inline; filename="signature.png"' }] },
  ] } }] })
  assert.equal(mail.body, 'Read the campaign brief.')
  assert.deepEqual(mail.links, [{ url: 'https://brand.example/brief?one=1&two=2', label: 'campaign brief' }])
  assert.deepEqual(mail.pdfs, [
    { name: 'Brief.pdf', index: 0, size: 42, downloadable: true },
    { name: 'Rate Card.PDF', index: 1, size: 5_000_000, downloadable: false },
  ])
  assert.deepEqual(mail.attachments, [
    { name: 'Brief.pdf', index: 0, size: 42, downloadable: true, mimeType: 'application/pdf' },
    { name: 'Rate Card.PDF', index: 1, size: 5_000_000, downloadable: false, mimeType: 'application/pdf' },
    { name: 'logo.png', index: 2, size: 25, downloadable: true, mimeType: 'image/png' },
  ])
  assert.ok(!JSON.stringify(mail).includes('secret-provider-id'))
})

test('collects named and plain links across all messages without repeating destinations', () => {
  const links = threadMessageLinks([
    { body: 'See https://brand.example/brief and example.com/schedule.' },
    { body: 'See https://brand.example/brief#timing and https://brand.example/brief again.' },
    { links: [
      { url: 'https://BRAND.example:443/brief', label: 'Campaign brief' },
      { url: 'https://brand.example/brief', label: 'The same brief' },
      { url: 'javascript:alert(1)', label: 'Unsafe link' },
    ] },
  ])
  assert.deepEqual(links, [
    { url: 'https://brand.example/brief', label: 'Campaign brief' },
    { url: 'http://example.com/schedule', label: 'example.com/schedule' },
    { url: 'https://brand.example/brief#timing', label: 'https://brand.example/brief#timing' },
  ])
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

test('downloads attachments only from the Gmail thread linked to the deal', async t => {
  const pageId = 'a'.repeat(32)
  const threadId = '18c9b10f0a123456'
  const pdf = Buffer.from('%PDF-1.7\nSample\n%%EOF')
  const sourceFetch = globalThis.fetch
  const attachmentRequests = []
  Object.assign(process.env, {
    VERCEL: '1',
    GMAIL_CLIENT_ID: 'test-client',
    GMAIL_CLIENT_SECRET: 'test-secret',
    GMAIL_COOKIE_KEY: Buffer.alloc(32, 9).toString('base64url'),
    GMAIL_REDIRECT_URI: 'https://example.com/api/gmail/auth/callback',
    GMAIL_APP_ORIGIN: 'https://example.com',
    NOTION_TOKEN: 'test-notion',
  })
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input)
    if (url.hostname === 'oauth2.googleapis.com') {
      return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh' })
    }
    if (url.hostname === 'api.notion.com') {
      return Response.json({
        parent: { data_source_id: '8206590b-d48c-825b-ac32-07e2152ec3e1' },
        properties: { 'Gmail Thread': { url: 'https://mail.google.com/mail/u/0/#all/' + threadId } },
      })
    }
    assert.equal(url.hostname, 'gmail.googleapis.com')
    assert.equal(options.headers.Authorization, 'Bearer test-access')
    if (url.pathname.endsWith('/attachments/external')) {
      attachmentRequests.push(url.pathname)
      return Response.json({ data: pdf.toString('base64url') })
    }
    return Response.json({
      threadId: url.pathname.endsWith('/outside') ? 'other-thread' : threadId,
      payload: { parts: [
        { mimeType: 'application/pdf', filename: 'Brief.pdf', body: { size: pdf.length, attachmentId: 'external' } },
        { mimeType: 'application/pdf', filename: 'Inline.pdf', body: { size: pdf.length, data: pdf.toString('base64url') } },
        { mimeType: 'application/pdf', filename: 'Large.pdf', body: { size: 5_000_000, attachmentId: 'large' } },
        { mimeType: 'text/html', filename: 'brief.html', body: { data: Buffer.from('<h1>Brief</h1>').toString('base64url') } },
      ] },
    })
  })

  const { once } = await import('node:events')
  const { default: app } = await import('../server/index.js')
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const request = (path, cookie) => sourceFetch(origin + '/api' + path, { redirect: 'manual', headers: cookie ? { cookie } : {} })
  const cookieFrom = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(name + '=')).split(';')[0]
  const attachment = (id, index, cookie) => request(`/deals/${pageId}/gmail/messages/${id}/pdfs/${index}`, cookie)

  assert.equal((await attachment('message', 0)).status, 401)
  const start = await request('/gmail/auth/start')
  const state = new URL(start.headers.get('location')).searchParams.get('state')
  const auth = await request(`/gmail/auth/callback?state=${state}&code=test-code`, cookieFrom(start, 'cp_gmail_state'))
  const session = cookieFrom(auth, 'cp_gmail_session')
  assert.equal((await attachment('outside', 0, session)).status, 404)
  assert.equal(attachmentRequests.length, 0)
  const download = await attachment('message', 0, session)
  assert.equal(download.status, 200)
  assert.match(download.headers.get('content-disposition'), /attachment; filename=Brief\.pdf/)
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf)
  assert.deepEqual(Buffer.from(await (await attachment('message', 1, session)).arrayBuffer()), pdf)
  const large = await attachment('message', 2, session)
  assert.equal(large.status, 302)
  assert.equal(large.headers.get('location'), 'https://mail.google.com/mail/u/0/#all/message')
  const file = await request(`/deals/${pageId}/gmail/messages/message/attachments/3`, session)
  assert.equal(file.status, 200)
  assert.equal(file.headers.get('content-type'), 'application/octet-stream')
  assert.match(file.headers.get('content-disposition'), /attachment; filename=brief\.html/)
  assert.equal(await file.text(), '<h1>Brief</h1>')
  assert.equal(attachmentRequests.length, 1)
})
