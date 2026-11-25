import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'

test('Instagram inbox unlock gates reads and saves the selected inbox conversation to Notion', async t => {
  const account = { id: '12345', username: 'creator' }
  const pageId = 'a'.repeat(32)
  const conversationId = 'instagram-thread'
  const tracker = '8206590b-d48c-825b-ac32-07e2152ec3e1'
  const inboxKey = 'a'.repeat(64)
  const instagramField = 'Instagram Conversation ID'
  const page = {
    id: pageId, parent: { data_source_id: tracker },
    properties: {
      'Agency / Platform': { rich_text: [{ plain_text: 'Instagram' }] },
      Contact: { type: 'rich_text', rich_text: [{ plain_text: '@BrAnD' }] },
      [instagramField]: { type: 'rich_text', rich_text: [] },
    },
  }
  const thread = {
    id: conversationId, updated_time: '2026-11-21T17:00:00Z',
    participants: { data: [account, { id: '67890', username: 'brand' }] },
    messages: { data: [{ id: 'old', created_time: '2026-11-21T10:00:00Z', from: account, message: 'Hello' },
      { id: 'new', created_time: '2026-11-21T17:00:00Z', from: { id: '67890', username: 'brand' }, message: 'Thanks!' }] },
  }
  Object.assign(process.env, {
    VERCEL: '1', META_ACCESS_TOKEN: 'meta-token', META_IG_ACCOUNT_ID: account.id, META_INBOX_KEY: inboxKey,
    NOTION_TOKEN: 'notion-token',
  })
  const liveFetch = globalThis.fetch
  const stub = t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input)
    if (url.hostname === 'graph.facebook.com') {
      const path = url.pathname
      assert.equal(options.headers.Authorization, 'Bearer meta-token')
      if (path.endsWith('/12345/conversations')) {
        const after = url.searchParams.get('after')
        return Response.json({ data: [thread], paging: after ? {} : { next: 'next', cursors: { after: 'cursor' } } })
      }
      if (path.endsWith('/other-thread')) return Response.json({ participants: { data: [{ id: '999' }] } })
      if (path.endsWith('/wrong-brand')) return Response.json({ ...thread, participants: { data: [account, { id: '999', username: 'wrong' }] } })
      assert.ok(path.endsWith('/' + conversationId))
      return Response.json(thread)
    }
    if (url.pathname === '/v1/data_sources/' + tracker) return Response.json({ properties: page.properties })
    if (url.pathname === '/v1/data_sources/' + tracker + '/query') return Response.json({ results: [page] })
    assert.equal(url.pathname, '/v1/pages/' + pageId)
    if (options.method === 'PATCH') {
      Object.assign(page.properties, JSON.parse(options.body).properties)
      page.properties[instagramField].type = 'rich_text'
    }
    return Response.json(page)
  })
  const { default: app } = await import('../server/index.js')
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const request = (path, options) => liveFetch(origin + '/api/meta' + path, { redirect: 'manual', ...options })
  const cookie = (response, prefix) => response.headers.getSetCookie().find(value => value.startsWith(prefix)).split(';')[0]

  assert.equal((await request('/deals/' + pageId)).status, 401)
  assert.equal(stub.mock.callCount(), 0)
  const unlock = (key, requestOrigin = origin) => request('/unlock', {
    method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ key }),
  })
  assert.equal((await unlock(inboxKey, 'https://unrelated.example')).status, 403)
  assert.equal((await unlock('b'.repeat(64))).status, 401)
  assert.equal(stub.mock.callCount(), 0)
  const success = await unlock(inboxKey)
  assert.equal(success.status, 200)
  const session = cookie(success, 'cp_meta_inbox=')
  assert.ok(!session.includes('meta-token'))
  assert.ok(!session.includes(inboxKey))
  assert.match(success.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/i)
  const headers = { cookie: session, origin, 'content-type': 'application/json' }
  const forged = session.slice(0, -1) + (session.endsWith('A') ? 'B' : 'A')
  assert.equal((await request('/conversations', { headers: { cookie: forged } })).status, 401)
  assert.deepEqual(await (await request('/status', { headers })).json(), { configured: true, connected: true })
  const choices = await (await request('/conversations', { headers })).json()
  assert.equal(choices.conversations[0].username, 'brand')
  assert.equal(choices.after, 'cursor')
  assert.equal((await (await request('/conversations?after=cursor', { headers })).json()).after, '')
  const link = id => request('/deals/' + pageId + '/link', { headers, method: 'POST', body: JSON.stringify({ conversationId: id }) })
  assert.equal((await link('other-thread')).status, 403)
  assert.deepEqual(await (await request('/pending-links', { headers })).json(), { pending: [{ id: pageId, handle: 'brand' }] })
  page.properties.Contact.rich_text[0].plain_text = 'BrAnD'
  assert.deepEqual(await (await request('/pending-links', { headers })).json(), { pending: [{ id: pageId, handle: 'brand' }] })
  const autoLink = id => request('/deals/' + pageId + '/auto-link', { headers, method: 'POST', body: JSON.stringify({ conversationId: id }) })
  assert.equal((await autoLink('wrong-brand')).status, 409)
  assert.equal((await autoLink(conversationId)).status, 200)
  assert.equal(page.properties[instagramField].rich_text[0].text.content, conversationId)
  assert.equal(page.properties['Last Activity'].date.start, '2026-11-22')
  assert.deepEqual(await (await request('/pending-links', { headers })).json(), { pending: [] })
  assert.equal((await autoLink('wrong-brand')).status, 200)
  assert.equal(page.properties[instagramField].rich_text[0].text.content, conversationId)
  const { conversation } = await (await request('/deals/' + pageId, { headers })).json()
  assert.deepEqual(conversation.messages.map(message => message.id), ['new', 'old'])
  const locked = await request('/lock', { method: 'POST', headers })
  assert.equal(locked.status, 200)
  assert.match(locked.headers.get('set-cookie'), /^cp_meta_inbox=;/)
  process.env.META_INBOX_KEY = 'c'.repeat(64)
  assert.equal((await request('/deals/' + pageId, { headers })).status, 401)
  assert.equal((await request('/deals/' + pageId, { headers })).status, 401)
})
