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
      { id: 'new', created_time: '2026-11-21T17:00:00Z', from: { id: '67890', username: 'brand' }, message: 'Thanks!',
        attachments: { data: [
          { image_data: { url: 'https://scontent.cdninstagram.com/image.jpg' } },
          { video_data: { url: 'https://video.fbcdn.net/video.mp4' } },
          { name: 'Brief.pdf', file_url: 'https://lookaside.fbsbx.com/file' },
          { image_data: { url: 'https://external.example/image.png' } },
          { file_url: 'javascript:alert(1)' },
        ] },
        shares: { data: [{ name: 'A Reel', url: 'https://www.instagram.com/reel/example/' }] },
      }] },
  }
  Object.assign(process.env, {
    VERCEL: '1', META_ACCESS_TOKEN: 'meta-token', META_IG_ACCOUNT_ID: account.id, META_INBOX_KEY: inboxKey,
    NOTION_TOKEN: 'notion-token',
  })
  const liveFetch = globalThis.fetch
  const sentReplies = []
  const day = 86_400_000
  const hour = 3_600_000
  const analyticsEnd = Math.floor(Date.now() / day) * day
  let insightsAllowed = true
  const cdnFiles = {
    'https://scontent.cdninstagram.com/image.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
    'https://lookaside.fbsbx.com/file': Buffer.from('%PDF-1.7 brief'),
  }
  const cdnRequests = []
  const stub = t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input)
    if (cdnFiles[url.href]) {
      cdnRequests.push(url.href)
      assert.equal(options?.headers?.Authorization, undefined)
      return new Response(cdnFiles[url.href])
    }
    if (url.hostname === 'graph.facebook.com') {
      const path = url.pathname
      assert.equal(options.headers.Authorization, 'Bearer meta-token')
      if (path === '/v27.0') {
        assert.equal(options.method, 'POST')
        const batch = JSON.parse(options.body.get('batch'))
        assert.ok(batch.length <= 30)
        return Response.json(batch.map((item, index) => {
          assert.equal(item.method, 'GET')
          const request = new URL(item.relative_url, 'https://graph.facebook.com/')
          if (/^\/1\d{2}\/insights$/.test(request.pathname)) {
            assert.equal(insightsAllowed, true)
            assert.equal(request.searchParams.get('metric'), 'likes,comments,shares,saved,reach')
            assert.equal(request.searchParams.get('period'), 'lifetime')
            const id = request.pathname.split('/')[1]
            const values = {
              shares: id === '102' ? 500 : id === '101' ? 3 : 0,
              saved: id === '101' ? 5 : 0,
              reach: id === '104' ? 0 : id === '102' ? 2000 : 100,
            }
            return { code: 200, body: JSON.stringify({ data: Object.entries(values).map(([name, value]) => ({ name, values: [{ value }] })) }) }
          }
          assert.equal(request.pathname, '/12345/insights')
          assert.equal(request.searchParams.get('metric_type'), 'total_value')
          assert.equal(Number(request.searchParams.get('until')) - Number(request.searchParams.get('since')), 86400)
          const metric = request.searchParams.get('metric')
          if (metric === 'likes,comments,shares,saves') {
            const values = { likes: index, comments: 1, shares: 2, saves: 3 }
            if (index === 1) delete values.saves
            return { code: 200, body: JSON.stringify({ data: Object.entries(values).map(([name, value]) => ({ name, total_value: { value } })) }) }
          }
          assert.equal(metric, 'views')
          if (index === 1) return null
          return { code: 200, body: JSON.stringify({ data: [{ name: 'views', total_value: { value: index * 10 } }] }) }
        }))
      }
      if (path.endsWith('/12345')) {
        if (url.searchParams.get('fields') === 'username,followers_count,follows_count,media_count') {
          return Response.json({ username: 'creator', followers_count: 420, follows_count: 32, media_count: 20 })
        }
        assert.match(url.searchParams.get('fields'), /media\.limit\(3\)/)
        return Response.json({ username: 'creator', profile_picture_url: 'https://example.com/profile.png', followers_count: 420, follows_count: 32, media_count: 17, media: { data: [
          { id: 'one', media_type: 'IMAGE', timestamp: '2026-11-19T00:00:00Z', permalink: 'https://www.instagram.com/p/one/', media_url: 'https://example.com/one.png' },
          { id: 'two', media_type: 'VIDEO', timestamp: '2026-11-21T00:00:00Z', permalink: 'https://www.instagram.com/reel/two/', thumbnail_url: 'https://example.com/two.png' },
          { id: 'untrusted', permalink: 'https://example.com/not-an-instagram-post' },
        ] } })
      }
      if (path.endsWith('/12345/media')) {
        const post = (id, daysAgo, likes, comments, publishHour = 0) => ({
          id, timestamp: new Date(analyticsEnd - daysAgo * day + publishHour * hour).toISOString(), like_count: likes, comments_count: comments,
          permalink: 'https://www.instagram.com/p/example/', media_type: id === '105' ? 'VIDEO' : 'IMAGE',
          media_product_type: id === '105' ? 'REELS' : 'FEED',
        })
        if (url.searchParams.get('after') === 'media-next') {
          return Response.json({ data: [post('102', 10, 60, 3, 22), post('103', 4, undefined, 4)] })
        }
        return Response.json({
          data: [
            post('104', 91, 500, 40), post('101', 1, 40, 2), post('105', 0, 500, 40),
            ...Array.from({ length: 15 }, (_, index) => post(String(110 + index), 100 + index, 0, 0)),
          ],
          paging: { cursors: { after: 'media-next' }, next: 'https://example.com/untrusted-paging-host' },
        })
      }
      if (path.endsWith('/12345/insights')) {
        if (!insightsAllowed) return Response.json({ error: { code: 200 } }, { status: 403 })
        assert.equal(url.searchParams.get('metric_type'), 'total_value')
        const names = url.searchParams.get('metric').split(',')
        const days = (Number(url.searchParams.get('until')) - Number(url.searchParams.get('since'))) / 86400
        if (names.includes('reach') && days > 30) return Response.json({ error: { code: 100 } }, { status: 400 })
        const breakdown = (dimension, results) => ({ breakdowns: [{
          dimension_keys: [dimension], results: results.map(([label, value]) => ({ dimension_values: [label], value })),
        }] })
        const totals = {
          views: { value: days * 100 },
          total_interactions: { value: days * 10 },
          likes: { value: days * 2 }, comments: { value: days }, shares: { value: 0 }, saves: { value: 0 },
          reach: { value: 600 },
          accounts_engaged: { value: 100 },
          profile_links_taps: { value: days },
          follows_and_unfollows: days === 30
            ? breakdown('follow_type', [['FOLLOWER', 7], ['NON_FOLLOWER', 9]])
            : { value: 7, ...breakdown('follow_type', [['FOLLOWER', 5], ['NON_FOLLOWER', 2]]) },
          follower_demographics: breakdown('age', [['25-34', 140]]),
        }
        return Response.json({ data: names.map(name => ({ name, total_value: totals[name] })) })
      }
      if (path.endsWith('/12345/stories')) {
        return Response.json({ data: [{ id: '201', timestamp: new Date().toISOString(), media_type: 'IMAGE' }] })
      }
      if (path.endsWith('/201/insights')) {
        assert.equal(insightsAllowed, true)
        return url.searchParams.get('breakdown') ? Response.json({ data: [{
          name: 'navigation', total_value: { value: 3, breakdowns: [{
            dimension_keys: ['story_navigation_action_type'], results: [{ dimension_values: ['TAP_FORWARD'], value: 3 }],
          }] },
        }] }) : Response.json({ data: [{ name: 'views', values: [{ value: 26 }] }] })
      }
      if (/\/1\d{2}\/insights$/.test(path)) {
        assert.equal(insightsAllowed, true)
        const metrics = url.searchParams.get('metric')
        if (metrics.includes('ig_reels_avg_watch_time')) {
          assert.equal(path.endsWith('/105/insights'), true)
          return Response.json({ data: [{ name: 'ig_reels_avg_watch_time', values: [{ value: 3400 }] }] })
        }
        assert.equal(metrics, 'views,reposts,total_interactions')
        return Response.json({ data: [{ name: 'views', values: [{ value: 100 }] }, { name: 'reposts', values: [{ value: 0 }] }] })
      }
      if (path.endsWith('/12345/messages')) {
        assert.equal(options.method, 'POST')
        const payload = JSON.parse(options.body)
        sentReplies.push(payload)
        if (payload.message.text === 'Late reply') return Response.json({ error: { code: 10, error_subcode: 2534022, fbtrace_id: 'sample-trace' } }, { status: 400 })
        return Response.json({ message_id: 'sent-message' })
      }
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
  assert.deepEqual(await (await request('/scorecard')).json(), { scorecard: null })
  assert.deepEqual(await (await request('/analytics')).json(), { configured: true, analytics: null })
  assert.equal((await request('/analytics/daily-views')).status, 401)
  assert.equal((await request('/analytics?days=10')).status, 400)
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
  const { scorecard } = await (await request('/scorecard', { headers })).json()
  assert.equal(scorecard.followers, 420)
  assert.equal(scorecard.following, 32)
  assert.equal(scorecard.postCount, 17)
  assert.equal(scorecard.photo, 'https://example.com/profile.png')
  assert.deepEqual(scorecard.posts.map(post => post.id), ['two', 'one'])
  assert.equal(scorecard.posts[0].image, 'https://example.com/two.png')
  const analyticsFor = async days => (await (await request('/analytics?days=' + days, { headers })).json()).analytics
  const sevenDays = await analyticsFor(7)
  assert.deepEqual(sevenDays.account, { platform: 'instagram', username: 'creator', followers: 420, following: 32, posts: 20, likes: null })
  assert.equal(sevenDays.views, 700)
  assert.equal(sevenDays.netFollowers, 3)
  assert.equal(sevenDays.followerChange30Days, -2)
  assert.equal(sevenDays.postCount, 2)
  assert.equal(sevenDays.measuredPosts, 1)
  assert.equal(sevenDays.engagement, 50)
  assert.equal(sevenDays.weekly[0].engagement, 21)
  const until = new Date(analyticsEnd).toISOString().slice(0, 10)
  assert.equal((await request('/analytics?section=profile', { headers })).status, 400)
  assert.equal((await request('/analytics?until=invalid', { headers })).status, 400)
  const callsBeforeSummary = stub.mock.callCount()
  const { analytics: summary } = await (await request(`/analytics?days=7&section=account&until=${until}`, { headers })).json()
  assert.equal(summary.views, sevenDays.views)
  assert.equal(summary.followers, sevenDays.followers)
  assert.equal(summary.featuredPosts, undefined)
  assert.ok(stub.mock.calls.slice(callsBeforeSummary).every(({ arguments: [input] }) => {
    const path = new URL(input).pathname
    return path === '/v27.0/12345' || path === '/v27.0/12345/insights'
  }))
  const { analytics: content } = await (await request(`/analytics?days=7&section=content&until=${until}`, { headers })).json()
  assert.equal(content.postsByWeek[summary.weekly[0].start], sevenDays.weekly[0].posts)
  assert.deepEqual(content.featuredPosts, sevenDays.featuredPosts)
  const { weekdays, windows } = sevenDays.reachByPublishingTime
  assert.deepEqual(weekdays.map(bucket => bucket.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  const singaporeWeekday = new Date(analyticsEnd - 9 * day).getUTCDay()
  assert.ok(weekdays[(singaporeWeekday + 6) % 7].reach >= 2000)
  assert.equal(weekdays.reduce((reach, bucket) => reach + bucket.reach, 0), 3800)
  assert.deepEqual(windows.map(bucket => bucket.reach), [0, 2000, 1800, 0, 0, 0])
  assert.deepEqual(windows[1], { startHour: 4, endHour: 8, reach: 2000, posts: 1 })
  const { daily } = await (await request('/analytics/daily-views?days=90', { headers })).json()
  assert.equal(daily.length, 90)
  assert.equal(new Set(daily.map(day => day.date)).size, 90)
  assert.equal(daily.at(-1).date, sevenDays.end)
  assert.equal(daily[0].views, 0)
  assert.equal(daily[1].views, null)
  assert.equal(daily[2].views, 20)
  assert.equal(daily[30].views, 0)
  const { daily: engagementDays } = await (await request('/analytics/daily-engagement?days=7', { headers })).json()
  assert.equal(engagementDays.length, 7)
  assert.deepEqual(engagementDays.map(day => day.engagement), [6, null, 8, 9, 10, 11, 12])
  assert.equal(engagementDays.at(-1).date, sevenDays.end)
  assert.equal((await request('/analytics/daily-unknown', { headers })).status, 400)
  const ninetyDays = await analyticsFor(90)
  assert.equal(ninetyDays.views, 9000)
  assert.equal(ninetyDays.netFollowers, 39)
  assert.equal(ninetyDays.followerChange30Days, -2)
  assert.equal(ninetyDays.weekly.at(-1).netFollowers, 3)
  assert.deepEqual(ninetyDays.accountMetrics, { uniqueAccountDays: 30, reach: 600, accountsEngaged: 100, profileLinkTaps: 90, interactions: 900, follows: 65, unfollows: 26 })
  assert.deepEqual(ninetyDays.demographics.age, [{ label: '25-34', value: 140 }])
  assert.equal(ninetyDays.stories[0].insights.views, 26)
  assert.deepEqual(ninetyDays.stories[0].actions, [{ label: 'TAP_FORWARD', value: 3 }])
  assert.equal(ninetyDays.postCount, 3)
  assert.equal(ninetyDays.weekly.length, 13)
  assert.equal(ninetyDays.featuredPosts.top.length, 15)
  assert.deepEqual(ninetyDays.featuredPosts.top.slice(0, 4).map(post => post.id), ['102', '105', '104', '101'])
  assert.deepEqual(sevenDays.featuredPosts.top, ninetyDays.featuredPosts.top)
  assert.deepEqual(sevenDays.reachByPublishingTime, ninetyDays.reachByPublishingTime)
  assert.equal(ninetyDays.featuredPosts.recent.length, 15)
  assert.deepEqual(ninetyDays.featuredPosts.recent.slice(0, 3).map(post => post.id), ['105', '101', '103'])
  assert.ok(ninetyDays.featuredPosts.recent.every((post, index, posts) =>
    index === 0 || Date.parse(posts[index - 1].date) >= Date.parse(post.date)))
  assert.equal(ninetyDays.featuredPosts.top[0].insights.views, 100)
  assert.equal(ninetyDays.featuredPosts.top[0].insights.reposts, 0)
  assert.equal(ninetyDays.featuredPosts.top[0].engagements, 563)
  assert.equal(ninetyDays.featuredPosts.top[1].insights.ig_reels_avg_watch_time, 3400)
  assert.equal(ninetyDays.featuredPosts.top[2].engagementRate, null)
  assert.equal(ninetyDays.featuredPosts.recent[1].engagementRate, 50)
  assert.equal(ninetyDays.featuredPosts.recent[2].likes, null)
  assert.equal(ninetyDays.featuredPosts.recent[2].engagements, null)
  insightsAllowed = false
  const limited = await analyticsFor(30)
  assert.equal(limited.views, null)
  assert.equal(limited.netFollowers, null)
  assert.equal(limited.followerChange30Days, null)
  assert.equal(limited.insightsPermissionDenied, true)
  assert.equal(limited.postCount, 3)
  assert.equal(limited.featuredPosts.top.length, 0)
  assert.ok(limited.reachByPublishingTime.weekdays.every(bucket => bucket.posts === 0))
  assert.equal(limited.featuredPosts.recent[0].likes, 500)
  assert.equal(limited.featuredPosts.recent[0].insights, undefined)
  assert.equal(limited.stories[0].insights, undefined)
  const choices = await (await request('/conversations', { headers })).json()
  assert.equal(choices.conversations[0].username, 'brand')
  assert.equal(choices.after, 'cursor')
  assert.equal((await (await request('/conversations?after=cursor', { headers })).json()).after, '')
  const link = id => request('/deals/' + pageId + '/link', { headers, method: 'POST', body: JSON.stringify({ conversationId: id }) })
  assert.equal((await link('other-thread')).status, 403)
  assert.deepEqual(await (await request('/pending-links', { headers })).json(), { pending: [{ id: pageId, handle: 'brand' }] })
  page.properties.Contact.rich_text[0].plain_text = 'BrAnD'
  assert.deepEqual(await (await request('/pending-links', { headers })).json(), { pending: [{ id: pageId, handle: 'brand' }] })
  page.properties.Contact.rich_text = []
  page.properties[instagramField].rich_text = [{ plain_text: '@BrAnD' }]
  assert.deepEqual(await (await request('/deals/' + pageId, { headers })).json(), { conversation: null, contactHandle: 'brand' })
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
  assert.deepEqual(conversation.messages[0].media.map(({ type, name, preview }) => ({ type, name, preview })), [
    { type: 'image', name: '', preview: true },
    { type: 'video', name: '', preview: true },
    { type: 'pdf', name: 'Brief.pdf', preview: false },
    { type: 'image', name: '', preview: false },
    { type: 'share', name: 'A Reel', preview: false },
  ])
  const media = (messageId, index, options = { headers }) => request(`/deals/${pageId}/messages/${messageId}/media/${index}`, options)
  assert.equal((await media('new', 0, {})).status, 401)
  assert.equal((await media('missing', 0)).status, 404)
  assert.equal((await media('new', 9)).status, 404)
  assert.equal((await media('new', 'x')).status, 400)
  const image = await media('new', 0)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/jpeg')
  assert.match(image.headers.get('content-disposition'), /^inline;/)
  assert.match(image.headers.get('content-security-policy'), /sandbox/)
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), cdnFiles['https://scontent.cdninstagram.com/image.jpg'])
  const brief = await media('new', 2)
  assert.equal(brief.headers.get('content-type'), 'application/pdf')
  assert.match(brief.headers.get('content-disposition'), /^inline; filename="Brief\.pdf"/)
  const external = await media('new', 3)
  assert.equal(external.status, 302)
  assert.equal(external.headers.get('location'), 'https://external.example/image.png')
  const share = await media('new', 4)
  assert.equal(share.status, 302)
  assert.equal(share.headers.get('location'), 'https://www.instagram.com/reel/example/')
  assert.deepEqual(cdnRequests, ['https://scontent.cdninstagram.com/image.jpg', 'https://lookaside.fbsbx.com/file'])
  const reply = (text, id = conversationId) => request('/deals/' + pageId + '/send', {
    headers, method: 'POST', body: JSON.stringify({ conversationId: id, text, recipient: 'ignored' }),
  })
  assert.equal((await reply('Wrong conversation', 'other-thread')).status, 409)
  assert.equal((await reply(' ')).status, 400)
  assert.deepEqual(sentReplies, [])
  const send = await reply('Thanks for the brief!')
  assert.equal(send.status, 200)
  const payload = await send.json()
  assert.equal(payload.message.id, 'sent-message')
  assert.equal(payload.message.outgoing, true)
  assert.deepEqual(sentReplies, [{ recipient: { id: '67890' }, message: { text: 'Thanks for the brief!' } }])
  thread.messages.data.find(message => message.id === 'new').created_time = new Date(Date.now() - 14 * 3600_000).toISOString()
  const late = await reply('Late reply')
  assert.equal(late.status, 409)
  assert.match((await late.json()).error, /Meta error 10\/2534022, reference sample-trace.*latest incoming DM.*within the last 24 hours/)
  for (let i = 0; i < 10; i++) thread.messages.data.push({ id: 'extra-' + i, created_time: '2026-11-20T10:00:00Z' })
  const recent = await (await request('/deals/' + pageId, { headers })).json()
  assert.equal(recent.conversation.messages.length, 10)
  assert.equal(recent.conversation.messages[0].id, 'new')
  const locked = await request('/lock', { method: 'POST', headers })
  assert.equal(locked.status, 200)
  assert.match(locked.headers.get('set-cookie'), /^cp_meta_inbox=;/)
  process.env.META_INBOX_KEY = 'c'.repeat(64)
  assert.equal((await request('/deals/' + pageId, { headers })).status, 401)
  assert.equal((await request('/deals/' + pageId, { headers })).status, 401)
})
