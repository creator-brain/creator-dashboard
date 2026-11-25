import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'

test('Instagram OAuth gates reads and saves the selected inbox conversation to Notion', async t => {
  const account = { id: '12345', username: 'creator' }
  const pageId = 'a'.repeat(32)
  const conversationId = 'instagram-thread'
  const tracker = '8206590b-d48c-825b-ac32-07e2152ec3e1'
  const storage = new Map()
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
    VERCEL: '1', META_CLIENT_ID: 'app', META_CLIENT_SECRET: 'secret', META_CONFIG_ID: 'configuration',
    META_REDIRECT_URI: 'https://dashboard.example/api/meta/auth/callback', META_APP_ORIGIN: 'https://dashboard.example',
    META_IG_ACCOUNT_ID: account.id, META_SESSION_REDIS_URL: 'https://redis.example', META_SESSION_REDIS_TOKEN: 'storage-token',
    NOTION_TOKEN: 'notion-token',
  })
  const liveFetch = globalThis.fetch
  const stub = t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input)
    if (url.hostname === 'redis.example') {
      const [command, key, value] = JSON.parse(options.body)
      if (command === 'SET') storage.set(key, value)
      if (command === 'DEL') storage.delete(key)
      return Response.json({ result: command === 'GET' ? storage.get(key) || null : 'OK' })
    }
    if (url.hostname === 'graph.facebook.com') {
      const path = url.pathname
      if (path.endsWith('/oauth/access_token')) return Response.json({ access_token: 'meta-token' })
      assert.equal(options.headers.Authorization, 'Bearer meta-token')
      if (path.endsWith('/assigned_instagram_accounts')) return Response.json({ data: [account] })
      if (path.endsWith('/me')) return Response.json({ client_business_id: 'portfolio' })
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
  const wrongHost = await request('/auth/start')
  assert.equal(wrongHost.headers.get('location'), 'https://dashboard.example/api/meta/auth/start')
  assert.equal(wrongHost.headers.get('set-cookie'), null)
  process.env.META_REDIRECT_URI = `https://127.0.0.1:${server.address().port}/api/meta/auth/callback`
  const start = await request('/auth/start')
  const state = new URL(start.headers.get('location')).searchParams.get('state')
  const stateHeaders = { cookie: cookie(start, 'cp_meta_state=') }
  assert.equal((await request('/auth/callback?code=sample&state=bad', { headers: stateHeaders })).status, 400)
  assert.equal(stub.mock.callCount(), 0)
  const cancelled = await request('/auth/callback?error=access_denied&state=' + state, { headers: stateHeaders })
  assert.equal(cancelled.headers.get('location'), 'https://dashboard.example/?instagram=cancelled')
  assert.equal(stub.mock.callCount(), 0)
  const callback = await request('/auth/callback?code=sample&state=' + state, { headers: stateHeaders })
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.get('location'), 'https://dashboard.example/?instagram=connected')
  const session = cookie(callback, 'cp_meta_session=')
  assert.ok(!session.includes('meta-token'))
  const headers = { cookie: session, origin, 'content-type': 'application/json' }
  assert.deepEqual(await (await request('/status', { headers })).json(), { configured: true, connected: true, username: 'creator' })
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
  assert.equal((await request('/disconnect', { method: 'POST', headers })).status, 200)
  assert.equal((await request('/deals/' + pageId, { headers })).status, 401)
})
