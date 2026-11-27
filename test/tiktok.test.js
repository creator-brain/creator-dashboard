import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { get } from 'node:http'
import { test } from 'node:test'
import { combinedAudience, creatorAccount } from '../src/analytics.js'

test('TikTok signs in, rotates its refresh token, and returns normalized analytics', async t => {
  const liveFetch = globalThis.fetch
  const redirectUri = 'https://dashboard.example/api/tiktok/auth/callback'
  Object.assign(process.env, {
    VERCEL: '1',
    TIKTOK_CLIENT_KEY: 'sample-client',
    TIKTOK_CLIENT_SECRET: 'sample-secret',
    TIKTOK_COOKIE_KEY: Buffer.alloc(32, 7).toString('base64url'),
    TIKTOK_REDIRECT_URI: redirectUri,
  })
  const scopes = 'user.info.basic,user.info.stats,video.list'
  let loopbackChallenge
  const calls = []
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://open.tiktokapis.com')
    calls.push(url.pathname)
    if (url.pathname === '/v2/oauth/token/') {
      assert.equal(options.body.get('client_key'), 'sample-client')
      assert.equal(options.body.get('client_secret'), 'sample-secret')
      if (options.body.get('grant_type') === 'authorization_code') {
        assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded')
        if (options.body.get('code') === 'rejected-code') {
          return Response.json({ error: 'invalid_request', error_description: 'Redirect_uri did not match.', log_id: 'TIKTOKREF123' })
        }
        assert.equal(options.body.get('code'), 'sample-code')
        assert.equal(options.body.get('redirect_uri'), process.env.TIKTOK_REDIRECT_URI)
        const verifier = options.body.get('code_verifier')
        if (loopbackChallenge) assert.equal(createHash('sha256').update(verifier).digest('hex'), loopbackChallenge)
        else assert.equal(verifier, null)
        return Response.json({ scope: scopes, access_token: 'first-access', refresh_token: 'first-refresh', expires_in: 1, refresh_expires_in: 600 })
      }
      assert.equal(options.body.get('refresh_token'), 'first-refresh')
      return Response.json({ access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600, refresh_expires_in: 600 })
    }
    if (url.pathname === '/v2/oauth/revoke/') {
      assert.equal(options.body.get('token'), 'next-access')
      return new Response(null)
    }
    assert.equal(options.headers.Authorization, 'Bearer next-access')
    if (url.pathname === '/v2/user/info/') {
      return Response.json({
        data: { user: { display_name: 'Creator', follower_count: 20, following_count: 8, likes_count: 130, video_count: 1 } },
        error: { code: 'ok' },
      })
    }
    assert.equal(url.pathname, '/v2/video/list/')
    assert.equal(JSON.parse(options.body).max_count, 15)
    return Response.json({
      data: { videos: [{
        id: '123456', create_time: 1795620000, title: 'Video title', share_url: 'https://www.tiktok.com/@creator/video/123456',
        cover_image_url: 'https://example.com/cover.png', view_count: 1000, like_count: 30, comment_count: 0, share_count: 2,
      }] },
      error: { code: 'ok' },
    })
  })
  const { default: app } = await import('../server/index.js')
  delete process.env.TIKTOK_APP_ORIGIN
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const request = (path, options) => liveFetch(origin + '/api/tiktok' + path, { redirect: 'manual', ...options })
  const cookie = (response, prefix) => response.headers.getSetCookie().find(value => value.startsWith(prefix)).split(';')[0]

  assert.deepEqual(await (await request('/analytics')).json(), {
    configured: true, connected: false, authorizeUrl: 'https://dashboard.example/api/tiktok/auth/start', analytics: null,
  })
  const handoff = await request('/auth/start')
  assert.equal(handoff.status, 400)
  assert.equal(handoff.headers.get('set-cookie'), null)
  const authorization = await new Promise((resolve, reject) => {
    const connection = get(origin + '/api/tiktok/auth/start', { headers: { host: 'dashboard.example' } }, response => {
      const headers = new Headers()
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        headers.append(response.rawHeaders[index], response.rawHeaders[index + 1])
      }
      response.resume()
      resolve({ headers })
    })
    connection.on('error', reject)
  })
  const login = new URL(authorization.headers.get('location'))
  assert.equal(login.origin, 'https://www.tiktok.com')
  assert.equal(login.searchParams.get('scope'), scopes)
  assert.match(authorization.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/i)
  const state = login.searchParams.get('state')
  const pending = cookie(authorization, 'cp_tiktok_state=')
  const opts = { headers: { cookie: pending } }
  assert.equal((await request('/auth/callback?state=' + '0'.repeat(32) + '&code=sample-code', opts)).status, 400)
  assert.equal(calls.length, 0)
  const rejected = await request('/auth/callback?state=' + state + '&code=rejected-code', opts)
  assert.equal(rejected.status, 502)
  assert.equal(rejected.headers.get('referrer-policy'), 'no-referrer')
  assert.match((await rejected.json()).error, /rejected the callback URL.*invalid_request.*TIKTOKREF123/)
  const callback = await request('/auth/callback?state=' + state + '&code=sample-code', opts)
  assert.equal(callback.headers.get('location'), '/?analytics=tiktok#overview')
  const response = await request('/analytics', { headers: { cookie: cookie(callback, 'cp_tiktok_session=') } })
  const refreshed = cookie(response, 'cp_tiktok_session=')
  const data = await response.json()
  assert.equal(data.connected, true)
  assert.equal(data.analytics.account.followers, 20)
  assert.deepEqual(data.analytics.posts[0].metrics, { views: 1000, reach: null, likes: 30, comments: 0, shares: 2, saves: null, clicks: null })
  assert.equal(combinedAudience([data.analytics.account, creatorAccount('instagram', { followers: 100 })]), 120)
  assert.equal(combinedAudience([data.analytics.account, creatorAccount('instagram', {})]), null)
  assert.ok(!JSON.stringify(data).includes('next-access'))
  assert.ok(!refreshed.includes('next-refresh'))
  assert.equal((await request('/disconnect', { method: 'POST', headers: { cookie: refreshed, origin: 'https://other.example' } })).status, 403)
  assert.equal((await request('/disconnect', { method: 'POST', headers: { cookie: refreshed, origin } })).status, 200)
  assert.equal(calls.at(-1), '/v2/oauth/revoke/')

  process.env.TIKTOK_REDIRECT_URI = origin + '/api/tiktok/auth/callback'
  process.env.TIKTOK_APP_ORIGIN = 'http://127.0.0.1:5173'
  assert.equal((await request('/auth/start')).status, 503)
  delete process.env.VERCEL
  assert.equal((await (await request('/status')).json()).authorizeUrl, origin + '/api/tiktok/auth/start')
  const local = await request('/auth/start')
  const desktopLogin = new URL(local.headers.get('location'))
  assert.equal(desktopLogin.searchParams.get('redirect_uri'), process.env.TIKTOK_REDIRECT_URI)
  assert.equal(desktopLogin.searchParams.get('code_challenge_method'), 'S256')
  loopbackChallenge = desktopLogin.searchParams.get('code_challenge')
  assert.match(loopbackChallenge, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(local.headers.get('set-cookie'), /; Secure/i)
  const localCallback = await request('/auth/callback?state=' + desktopLogin.searchParams.get('state') + '&code=sample-code', {
    headers: { cookie: cookie(local, 'cp_tiktok_state=') },
  })
  assert.equal(localCallback.headers.get('location'), 'http://127.0.0.1:5173/?analytics=tiktok#overview')
})
