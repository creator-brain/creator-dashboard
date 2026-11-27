import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { INSTAGRAM_MESSAGE_LIMIT, INSTAGRAM_REPLY_LIMIT } from '../src/model.js'
import { contentMetrics, creatorAccount } from '../src/analytics.js'

const graph = 'https://graph.facebook.com/v27.0'
const sessionCookie = 'cp_meta_inbox'
const sessionSeconds = 7 * 24 * 60 * 60
const failure = (message, status) => Object.assign(new Error(message), { status })
const cookieOptions = req => ({ httpOnly: true, sameSite: 'strict', secure: Boolean(process.env.VERCEL) || req.secure, path: '/api/meta' })
const readSession = req => req.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(sessionCookie + '='))?.slice(sessionCookie.length + 1)
const digest = value => createHash('sha256').update(value).digest()
const matches = (left, right) => timingSafeEqual(digest(left), digest(right))

export const validConversationId = value => typeof value === 'string' && /^[\w=-]{1,512}$/.test(value)

export function instagramConfigured() {
  const { META_ACCESS_TOKEN, META_IG_ACCOUNT_ID, META_INBOX_KEY } = process.env
  return Boolean(META_ACCESS_TOKEN && /^\d+$/.test(META_IG_ACCOUNT_ID || '') && /^[a-f0-9]{64}$/i.test(META_INBOX_KEY || ''))
}

function signature(payload) {
  const signingKey = createHmac('sha256', process.env.META_INBOX_KEY).update('collab-pipeline:instagram-inbox:v1').digest()
  return createHmac('sha256', signingKey)
    .update(JSON.stringify([process.env.META_IG_ACCOUNT_ID, digest(process.env.META_ACCESS_TOKEN).toString('hex'), payload]))
    .digest('base64url')
}

function metaErrorReference(error) {
  const codes = [error?.code, error?.error_subcode].filter(Number.isInteger).join('/')
  const trace = typeof error?.fbtrace_id === 'string' && /^[\w-]{4,96}$/.test(error.fbtrace_id) ? error.fbtrace_id : ''
  const details = [codes && `Meta error ${codes}`, trace && `reference ${trace}`].filter(Boolean)
  return details.length ? ` (${details.join(', ')})` : ''
}

async function graphRequest(path, params, token, payload) {
  const url = `${graph}${path}?${new URLSearchParams(params)}`
  const unknownDelivery = 'Instagram didn’t confirm delivery. Refresh the conversation before trying again.'
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}),
    redirect: 'error', signal: AbortSignal.timeout(8000),
  }).catch(() => { throw failure(payload ? unknownDelivery : 'Could not reach Instagram. Try again.', 502) })
  const data = await response.json().catch(() => null)
  if (data?.error?.code === 190 && token) throw failure('The Meta access token expired or was revoked. Update it on the server.', 401)
  if (payload) {
    const reference = metaErrorReference(data?.error)
    if (data?.error?.error_subcode === 2534022 || /outside.*(?:window|allowed time)/i.test(data?.error?.message || '')) {
      throw Object.assign(failure(`Meta rejected this reply as outside its allowed window${reference}.`, 409), { instagramWindowRejected: true })
    }
    if (data?.error?.error_subcode === 2534037) {
      throw failure(`Meta says this app does not control the conversation${reference}. Reply in Instagram or check Conversation Routing in Meta Business Suite.`, 409)
    }
    if (response.status >= 500 || !data || (response.ok && !data.error && !data.message_id)) throw failure(unknownDelivery, 502)
    if (!response.ok || data.error) throw failure(`Instagram rejected the reply${reference}. Check messaging access or try replying in Instagram.`, 502)
  }
  if (!response.ok || !data || data.error) {
    throw Object.assign(failure('Meta could not complete the Instagram request. Check the account and messaging permissions.', 502), {
      metaCode: data?.error?.code,
    })
  }
  return data
}

export function instagramSession(req) {
  if (!instagramConfigured()) return null
  const cookie = readSession(req)
  if (!cookie || !/^\d{10}\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(cookie)) return null
  const [expires, nonce, provided] = cookie.split('.')
  if (Number(expires) <= Math.floor(Date.now() / 1000) || !matches(provided, signature(expires + '.' + nonce))) return null
  return { token: process.env.META_ACCESS_TOKEN, account: { id: process.env.META_IG_ACCOUNT_ID } }
}

export async function instagramUnlock(req, res) {
  if (!instagramConfigured()) throw failure('Instagram server setup is required.', 503)
  const key = req.body?.key
  if (typeof key !== 'string' || key.length !== 64 || !matches(key, process.env.META_INBOX_KEY)) {
    throw failure('Incorrect Instagram inbox key.', 401)
  }
  const accountId = process.env.META_IG_ACCOUNT_ID
  await graphRequest(`/${accountId}/conversations`, { platform: 'instagram', fields: 'id', limit: '1' }, process.env.META_ACCESS_TOKEN)
  const payload = `${Math.floor(Date.now() / 1000) + sessionSeconds}.${randomBytes(16).toString('hex')}`
  res.cookie(sessionCookie, payload + '.' + signature(payload), { ...cookieOptions(req), maxAge: sessionSeconds * 1000 })
  res.json({ configured: true, connected: true })
}

export function instagramLock(req, res) {
  res.clearCookie(sessionCookie, cookieOptions(req)).json({ connected: false })
}

function httpsUrl(value, instagramOnly = false) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    if (instagramOnly && !['instagram.com', 'www.instagram.com'].includes(url.hostname)) return ''
    return url.href
  } catch { return '' }
}

function postPreview(post) {
  return {
    id: post.id,
    type: post.media_type,
    date: post.timestamp,
    url: httpsUrl(post.permalink, true),
    image: httpsUrl(post.media_type === 'VIDEO' ? post.thumbnail_url : post.media_url),
  }
}

export async function instagramScorecard(session) {
  const profile = await graphRequest(`/${session.account.id}`, {
    fields: 'username,profile_picture_url,followers_count,follows_count,media_count,media.limit(3){id,media_type,media_url,thumbnail_url,permalink,timestamp}',
  }, session.token)
  const posts = (profile.media?.data || [])
    .filter(post => post.id && httpsUrl(post.permalink, true))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 3)
  return {
    username: profile.username || '',
    photo: httpsUrl(profile.profile_picture_url),
    followers: profile.followers_count ?? null,
    following: profile.follows_count ?? null,
    postCount: profile.media_count ?? null,
    posts: posts.map(postPreview),
  }
}

const dayMs = 86_400_000
const sum = values => values.reduce((total, value) => total + value, 0)
const count = value => Number.isFinite(value) && value >= 0
const dateKey = time => new Date(time).toISOString().slice(0, 10)

function analyticsRanges(start, end, size) {
  const ranges = []
  for (let until = end; until > start;) {
    const since = Math.max(start, until - size * dayMs)
    ranges.unshift({ since, until })
    until = since
  }
  return ranges
}

async function* analyticsMediaPages(session, edge, fields) {
  const seenCursors = new Set()
  let after
  do {
    const page = await graphRequest(`/${session.account.id}/${edge}`, { fields, limit: '100', ...(after ? { after } : {}) }, session.token)
    yield page.data || []
    after = page.paging?.next ? page.paging?.cursors?.after : undefined
    if (page.paging?.next && (!after || seenCursors.has(after))) throw failure('Meta returned an invalid Instagram media cursor.', 502)
    if (after) seenCursors.add(after)
  } while (after)
}

async function analyticsMedia(session) {
  const posts = new Map()
  const fields = 'id,timestamp,like_count,comments_count,caption,media_type,media_product_type,media_url,thumbnail_url,permalink'
  for await (const page of analyticsMediaPages(session, 'media', fields)) {
    for (const post of page) {
      const time = Date.parse(post.timestamp)
      if (!post.id || !Number.isFinite(time)) continue
      const likes = count(post.like_count) ? post.like_count : null
      const comments = count(post.comments_count) ? post.comments_count : null
      posts.set(post.id, {
        ...postPreview(post), time, likes, comments, reel: post.media_product_type === 'REELS',
        caption: post.caption?.trim().slice(0, 140) || '',
      })
    }
  }
  return [...posts.values()]
}

async function readInsights(session, id, params) {
  try {
    const result = await graphRequest(`/${id}/insights`, params, session.token)
    return { metrics: new Map((result.data || []).map(row => [row.name, row])) }
  } catch (error) {
    if (error.status === 401) throw error
    return { metrics: new Map(), permissionDenied: error.metaCode === 10 || (error.metaCode >= 200 && error.metaCode < 300) }
  }
}

function accountInsightParams(metric, { since, until }, breakdown) {
  return {
    metric, period: 'day', metric_type: 'total_value', since: since / 1000, until: until / 1000,
    ...(breakdown ? { breakdown } : {}),
  }
}

function accountInsights(session, metric, range, breakdown) {
  return readInsights(session, session.account.id, accountInsightParams(metric, range, breakdown))
}

async function graphInsightsBatch(session, requests) {
  const batch = requests.map(({ id, params }) => ({
    method: 'GET',
    relative_url: `${id}/insights?${new URLSearchParams(params)}`,
  }))
  const response = await fetch(graph, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
    body: new URLSearchParams({ batch: JSON.stringify(batch), include_headers: 'false' }),
    redirect: 'error', signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  const results = await response?.json().catch(() => null)
  if (results?.error?.code === 190) throw failure('The Meta access token expired or was revoked. Update it on the server.', 401)
  if (!response?.ok || !Array.isArray(results)) throw failure('Could not load Instagram Insights. Try again.', 502)
  return requests.map((_, index) => {
    const reply = results[index]
    let body
    try { body = JSON.parse(reply?.body) } catch { /* Meta may omit incomplete responses. */ }
    if (body?.error?.code === 190) throw failure('The Meta access token expired or was revoked. Update it on the server.', 401)
    return new Map((reply?.code === 200 && Array.isArray(body?.data) ? body.data : []).map(row => [row.name, row]))
  })
}

const engagementMetrics = ['likes', 'comments', 'shares', 'saves']

async function dailyMetricBatch(session, ranges, metric) {
  const fields = metric === 'views' ? 'views' : engagementMetrics.join(',')
  const results = await graphInsightsBatch(session, ranges.map(range => ({
    id: session.account.id, params: accountInsightParams(fields, range),
  })))
  return ranges.map(({ since }, index) => ({
    date: dateKey(since),
    [metric]: metric === 'views' ? metricValue(results[index].get('views')) : accountEngagement(results[index]),
  }))
}

export async function instagramDailyMetric(session, days, metric) {
  const until = Math.floor(Date.now() / dayMs) * dayMs
  const batches = analyticsRanges(until - days * dayMs, until, 30)
  const results = await Promise.allSettled(batches.map(({ since, until }) =>
    dailyMetricBatch(session, analyticsRanges(since, until, 1), metric)))
  const expired = results.find(result => result.status === 'rejected' && result.reason.status === 401)
  if (expired) throw expired.reason
  if (results.every(result => result.status === 'rejected')) throw results[0].reason
  return results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value
    const { since, until } = batches[index]
    return analyticsRanges(since, until, 1).map(day => ({ date: dateKey(day.since), [metric]: null }))
  })
}

function metricValue(row) {
  const value = row?.total_value?.value ?? row?.values?.[0]?.value
  return count(value) ? value : null
}

function breakdownValues(row, dimension) {
  const results = row?.total_value?.breakdowns?.find(item => item.dimension_keys?.[0] === dimension)?.results
  return (results || []).flatMap(({ dimension_values: [label] = [], value }) =>
    typeof label === 'string' && count(value) ? [{ label, value }] : [])
}

function followerChange(total) {
  const rows = breakdownValues(total, 'follow_type')
  if (!rows.length && metricValue(total) !== 0) return null
  let follows = 0, unfollows = 0
  for (const { label, value } of rows) {
    if (label === 'FOLLOWER') follows += value
    else if (label === 'NON_FOLLOWER') unfollows += value
    else if (value !== 0) return null
  }
  return { follows, unfollows, net: follows - unfollows }
}

async function audienceDemographics(session) {
  const dimensions = ['age', 'gender', 'country', 'city']
  const groups = await Promise.all(dimensions.map(async dimension => {
    const result = await readInsights(session, session.account.id, {
      metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value',
      timeframe: 'this_month', breakdown: dimension,
    })
    return breakdownValues(result.metrics.get('follower_demographics'), dimension).sort((a, b) => b.value - a.value)
  }))
  return Object.fromEntries(dimensions.map((dimension, index) => [dimension, groups[index]]))
}

async function mediaInsights(session, id, names, breakdown) {
  return (await readInsights(session, id, { metric: names, period: 'lifetime', ...(breakdown ? { breakdown } : {}) })).metrics
}

async function analyticsStories(session, permissionDenied) {
  const stories = new Map()
  try {
    for await (const page of analyticsMediaPages(session, 'stories', 'id,timestamp,media_type,media_url,thumbnail_url,permalink')) {
      for (const story of page) {
        if (/^\d+$/.test(story.id) && Number.isFinite(Date.parse(story.timestamp))) stories.set(story.id, postPreview(story))
      }
    }
  } catch (error) {
    if (error.status === 401) throw error
    return null
  }
  return Promise.all([...stories.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map(async story => {
    if (permissionDenied) return story
    const [metrics, navigation] = await Promise.all([
      mediaInsights(session, story.id, 'views,reach,replies,shares'),
      mediaInsights(session, story.id, 'navigation', 'story_navigation_action_type'),
    ])
    const actions = navigation.get('navigation')
    return {
      ...story,
      insights: Object.fromEntries([...metrics, ['navigation', actions]].map(([name, row]) => [name, metricValue(row)])),
      actions: breakdownValues(actions, 'story_navigation_action_type'),
    }
  }))
}

function engagementTotal(values) {
  return values.every(count) ? sum(values) : null
}

function accountEngagement(metrics) {
  return engagementTotal(engagementMetrics.map(name => metricValue(metrics.get(name))))
}

async function postEngagement(session, posts, permissionDenied) {
  const insightsById = new Map()
  if (!permissionDenied) {
    const eligible = posts.filter(post => /^\d+$/.test(post.id))
    for (let offset = 0; offset < eligible.length; offset += 60) {
      await Promise.all([eligible.slice(offset, offset + 30), eligible.slice(offset + 30, offset + 60)].filter(batch => batch.length).map(async batch => {
        const metric = 'likes,comments,shares,saved,reach'
        const results = await graphInsightsBatch(session, batch.map(({ id }) => ({
          id, params: { metric, period: 'lifetime' },
        }))).catch(error => {
          if (error.status === 401) throw error
          return []
        })
        results.forEach((metrics, index) => insightsById.set(batch[index].id, metrics))
      }))
    }
  }
  return posts.map(post => {
    const metrics = insightsById.get(post.id)
    const { likes, comments, shares, saves: saved, reach } = contentMetrics({
      likes: metricValue(metrics?.get('likes')) ?? post.likes,
      comments: metricValue(metrics?.get('comments')) ?? post.comments,
      shares: metricValue(metrics?.get('shares')),
      saves: metricValue(metrics?.get('saved')),
      reach: metricValue(metrics?.get('reach')),
    })
    const engagements = engagementTotal([likes, comments, shares, saved])
    const engagementRate = engagements !== null && reach > 0 ? engagements / reach * 100 : null
    return { ...post, likes, comments, shares, saved, reach, engagements, engagementRate }
  })
}

async function analyticsPosts(session, media, permissionDenied) {
  const measured = await postEngagement(session, media, permissionDenied)
  const top = measured.filter(post => post.engagements !== null)
    .sort((a, b) => b.engagements - a.engagements || b.time - a.time)
    .slice(0, 15)
  const recent = [...measured].sort((a, b) => b.time - a.time).slice(0, 15)
  const selected = new Map([...top, ...recent].map(post => [post.id, post]))
  const details = await Promise.all([...selected.values()].map(async ({ time, ...post }) => {
    if (permissionDenied || !/^\d+$/.test(post.id)) return post
    const [common, watch] = await Promise.all([
      mediaInsights(session, post.id, 'views,reposts,total_interactions'),
      post.reel ? mediaInsights(session, post.id, 'ig_reels_avg_watch_time,ig_reels_video_view_total_time,reels_skip_rate') : null,
    ])
    return { ...post, insights: Object.fromEntries([...common, ...(watch || [])].map(([name, row]) => [name, metricValue(row)])) }
  }))
  const byId = new Map(details.map(post => [post.id, post]))
  return {
    top: top.map(post => byId.get(post.id)),
    recent: recent.map(post => byId.get(post.id)),
    measured,
  }
}

const reachWeekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const reachPublishingTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Singapore', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
})

function reachByPublishingTime(posts) {
  const weekdays = reachWeekdays.map(label => ({ label, reach: 0, posts: 0 }))
  const windows = Array.from({ length: 6 }, (_, index) => ({
    startHour: index * 4, endHour: (index + 1) * 4, reach: 0, posts: 0,
  }))
  for (const { time, reach } of posts) {
    const parts = reachPublishingTime.formatToParts(time)
    const weekday = parts.find(({ type }) => type === 'weekday').value
    const hour = Number(parts.find(({ type }) => type === 'hour').value)
    const dayBucket = weekdays[reachWeekdays.indexOf(weekday)]
    const timeBucket = windows[Math.floor(hour / 4)]
    dayBucket.reach += reach
    dayBucket.posts += 1
    timeBucket.reach += reach
    timeBucket.posts += 1
  }
  return { weekdays, windows }
}

function analyticsPeriod(days, untilDate) {
  const until = untilDate ? Date.parse(untilDate) : Math.floor(Date.now() / dayMs) * dayMs
  const since = until - days * dayMs
  return { since, until, weeks: analyticsRanges(since, until, 7) }
}

function analyticsAccountQueries(session, weeks) {
  const viewsFor = range => accountInsights(session, `views,total_interactions,reach,accounts_engaged,profile_links_taps,${engagementMetrics.join(',')}`, range)
  const growthFor = range => accountInsights(session, 'follows_and_unfollows', range, 'follow_type')
  return { viewsFor, growthFor, latest: Promise.all([viewsFor(weeks.at(-1)), growthFor(weeks.at(-1))]) }
}

async function accountAnalytics(session, days, { since, until, weeks }, { viewsFor, growthFor, latest }) {
  const uniqueAccountDays = Math.min(days, 30)
  const [profile, [latestViews, latestGrowth]] = await Promise.all([
    graphRequest(`/${session.account.id}`, { fields: 'username,followers_count,follows_count,media_count' }, session.token),
    latest,
  ])
  const denied = latestViews.permissionDenied && latestGrowth.permissionDenied
  const empty = { metrics: new Map() }
  const earlierWeeks = weeks.slice(0, -1)
  const [earlierViews, earlierGrowth, monthlyGrowth, period, demographics] = await Promise.all([
    latestViews.permissionDenied ? earlierWeeks.map(() => empty) : Promise.all(earlierWeeks.map(viewsFor)),
    latestGrowth.permissionDenied ? earlierWeeks.map(() => empty) : Promise.all(earlierWeeks.map(growthFor)),
    latestGrowth.permissionDenied ? empty : growthFor({ since: until - 30 * dayMs, until }),
    denied ? empty : weeks.length === 1 ? latestViews : accountInsights(session, 'reach,accounts_engaged', {
      since: until - uniqueAccountDays * dayMs, until,
    }),
    denied ? {} : audienceDemographics(session),
  ])
  const viewResults = [...earlierViews, latestViews]
  const growthResults = [...earlierGrowth, latestGrowth]
  const weekly = weeks.map(({ since: start, until: end }, index) => {
    const { metrics } = viewResults[index]
    const growth = followerChange(growthResults[index].metrics.get('follows_and_unfollows'))
    return {
      start: dateKey(start), end: dateKey(end - dayMs),
      views: metricValue(metrics.get('views')),
      interactions: metricValue(metrics.get('total_interactions')),
      engagement: accountEngagement(metrics),
      reach: metricValue(metrics.get('reach')),
      accountsEngaged: metricValue(metrics.get('accounts_engaged')),
      profileLinkTaps: metricValue(metrics.get('profile_links_taps')),
      follows: growth?.follows ?? null, unfollows: growth?.unfollows ?? null, netFollowers: growth?.net ?? null,
    }
  })
  const weeklyTotal = key => weekly.every(week => week[key] !== null) ? sum(weekly.map(week => week[key])) : null
  const account = creatorAccount('instagram', { username: profile.username, followers: profile.followers_count, following: profile.follows_count, posts: profile.media_count })
  return {
    account,
    username: profile.username || '',
    followers: count(profile.followers_count) ? profile.followers_count : null,
    following: count(profile.follows_count) ? profile.follows_count : null,
    start: dateKey(since),
    end: dateKey(until - dayMs),
    views: weeklyTotal('views'),
    netFollowers: weeklyTotal('netFollowers'),
    followerChange30Days: followerChange(monthlyGrowth.metrics.get('follows_and_unfollows'))?.net ?? null,
    accountMetrics: {
      uniqueAccountDays,
      reach: metricValue(period.metrics.get('reach')),
      accountsEngaged: metricValue(period.metrics.get('accounts_engaged')),
      profileLinkTaps: weeklyTotal('profileLinkTaps'),
      interactions: weeklyTotal('interactions'), follows: weeklyTotal('follows'), unfollows: weeklyTotal('unfollows'),
    },
    demographics,
    insightsPermissionDenied: [...viewResults, ...growthResults].some(result => result.permissionDenied),
    weekly,
  }
}

async function contentAnalytics(session, { since, until, weeks }, { latest }) {
  const [media, [latestViews, latestGrowth]] = await Promise.all([analyticsMedia(session), latest])
  const denied = latestViews.permissionDenied && latestGrowth.permissionDenied
  const [{ measured: measuredMedia, ...featuredPosts }, stories] = await Promise.all([
    analyticsPosts(session, media, denied),
    analyticsStories(session, denied),
  ])
  const posts = measuredMedia.filter(({ time }) => time >= since && time < until)
  const measured = posts.filter(post => post.engagementRate !== null)
  const postsByWeek = Object.fromEntries(weeks.map(({ since: start, until: end }) => [
    dateKey(start), posts.filter(({ time }) => time >= start && time < end).length,
  ]))
  return {
    engagement: measured.length ? sum(measured.map(post => post.engagementRate)) / measured.length : null,
    measuredPosts: measured.length,
    postCount: posts.length,
    featuredPosts,
    reachByPublishingTime: reachByPublishingTime(measuredMedia.filter(post => post.reach !== null)),
    stories,
    postsByWeek,
  }
}

export async function instagramAnalytics(session, days, section, untilDate) {
  const period = analyticsPeriod(days, untilDate)
  const queries = analyticsAccountQueries(session, period.weeks)
  if (section === 'account') return accountAnalytics(session, days, period, queries)
  if (section === 'content') return contentAnalytics(session, period, queries)
  const [account, { postsByWeek, ...content }] = await Promise.all([
    accountAnalytics(session, days, period, queries),
    contentAnalytics(session, period, queries),
  ])
  return { ...account, ...content, weekly: account.weekly.map(week => ({ ...week, posts: postsByWeek[week.start] })) }
}

const counterpart = (conversation, accountId) => conversation.participants?.data?.find(person => person.id !== accountId)?.username || ''

export async function instagramConversations(session, after) {
  const result = await graphRequest(`/${session.account.id}/conversations`, {
    platform: 'instagram', fields: 'id,updated_time,participants', limit: '25', ...(after ? { after } : {}),
  }, session.token)
  return {
    conversations: (result.data || []).filter(row => validConversationId(row.id)).map(row => ({
      id: row.id, username: counterpart(row, session.account.id), updatedAt: row.updated_time,
    })),
    after: result.paging?.next ? result.paging.cursors?.after || '' : '',
  }
}

async function loadConversation(session, id, includeMessages) {
  if (!validConversationId(id)) throw failure('Invalid Instagram conversation ID.', 400)
  const path = `/${encodeURIComponent(id)}`
  const baseFields = 'id,updated_time,participants'
  const messageFields = `${baseFields},messages.limit(${INSTAGRAM_MESSAGE_LIMIT})`
  const row = includeMessages
    ? await graphRequest(path, {
      fields: `${messageFields}{id,created_time,from,message,attachments,shares{id,name,type,url},story,is_unsupported}`,
    }, session.token).catch(error => {
      if (error.metaCode !== 100) throw error
      return graphRequest(path, { fields: `${messageFields}{id,created_time,from,message}` }, session.token)
    })
    : await graphRequest(path, { fields: baseFields }, session.token)
  if (!row.participants?.data?.some(person => person.id === session.account.id)) {
    throw failure('This Instagram conversation is outside the connected account.', 403)
  }
  return row
}

function instagramMessageMedia(message) {
  const media = new Map()
  function add(value, type, name) {
    const url = httpsUrl(value)
    if (!url || media.has(url)) return
    const host = new URL(url).hostname
    const cdn = ['cdninstagram.com', 'fbcdn.net', 'fbsbx.com'].some(domain => host === domain || host.endsWith('.' + domain))
    media.set(url, {
      url, type, name: typeof name === 'string' ? name.slice(0, 150) : '',
      preview: cdn && (type === 'image' || type === 'video'),
    })
  }
  for (const part of message.attachments?.data || []) {
    const image = part.image_data
    const video = part.video_data
    add(image?.animated_gif_url || image?.url || image?.preview_url, 'image', part.name)
    add(typeof video === 'string' ? video : video?.url, 'video', part.name)
    if (part.file_url) {
      const fileUrl = httpsUrl(part.file_url)
      const isPdf = fileUrl && (/\.pdf$/i.test(part.name || '') || /\.pdf$/i.test(new URL(fileUrl).pathname))
      add(fileUrl, isPdf ? 'pdf' : 'file', part.name)
    }
  }
  for (const share of message.shares?.data || []) add(share.url, 'share', share.name)
  for (const story of [message.story?.reply_to, message.story?.mention, message.story]) {
    add(story?.link, 'story', '')
  }
  return [...media.values()]
}

export const INSTAGRAM_FILE_LIMIT = 4 * 1024 * 1024
const instagramFileHost = host => ['cdninstagram.com', 'fbcdn.net', 'fbsbx.com'].some(domain => host === domain || host.endsWith('.' + domain))

// Fetches one attachment of one message in a linked conversation, with a fresh link from Meta.
// Returns { bytes, name } for a small file on Instagram's own servers, or { redirect } to the fresh link otherwise.
export async function instagramMessageFile(session, conversationId, messageId, index) {
  if (!/^[\w=-]{1,512}$/.test(messageId || '') || !/^\d{1,2}$/.test(String(index))) throw failure('Invalid Instagram attachment.', 400)
  const row = await loadConversation(session, conversationId, true)
  const message = (row.messages?.data || []).find(item => item.id === messageId)
  const item = message && instagramMessageMedia(message)[Number(index)]
  if (!item) throw failure('Attachment not found in this Instagram conversation.', 404)
  if (item.type === 'share' || item.type === 'story' || !instagramFileHost(new URL(item.url).hostname)) return { redirect: item.url }
  const response = await fetch(item.url, { redirect: 'follow', signal: AbortSignal.timeout(15000) }).catch(() => null)
  if (!response?.ok || !response.body || !instagramFileHost(new URL(response.url || item.url).hostname)) {
    await response?.body?.cancel().catch(() => {})
    return { redirect: item.url }
  }
  if (Number(response.headers.get('content-length')) > INSTAGRAM_FILE_LIMIT) {
    await response.body.cancel().catch(() => {})
    return { redirect: item.url }
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > INSTAGRAM_FILE_LIMIT) return { redirect: item.url }
    chunks.push(chunk)
  }
  return { bytes: Buffer.concat(chunks), name: item.name || '' }
}

function replyParticipant(row, accountId) {
  const others = row.participants?.data?.filter(person => person.id !== accountId) || []
  return others.length === 1 && /^\d+$/.test(others[0].id || '') ? others[0] : null
}

export async function instagramConversation(session, id, { includeMessages = true } = {}) {
  const row = await loadConversation(session, id, includeMessages)
  return {
    id: row.id, username: counterpart(row, session.account.id), updatedAt: row.updated_time,
    messages: (row.messages?.data || []).map(message => ({
      id: message.id, date: message.created_time, sender: message.from?.username || '',
      outgoing: message.from?.id === session.account.id, text: message.message || '',
      media: instagramMessageMedia(message), unsupported: message.is_unsupported === true,
    })).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, INSTAGRAM_MESSAGE_LIMIT),
  }
}

export async function sendInstagramReply(session, conversationId, value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > INSTAGRAM_REPLY_LIMIT) throw failure(`Enter a reply of 1 to ${INSTAGRAM_REPLY_LIMIT} characters.`, 400)
  const accountId = session.account.id
  const thread = await loadConversation(session, conversationId, false)
  const recipient = replyParticipant(thread, accountId)
  if (!recipient) throw failure('This Instagram conversation does not have a single reply recipient.', 409)
  let sent
  try {
    sent = await graphRequest(`/${accountId}/messages`, {}, session.token, { recipient: { id: recipient.id }, message: { text } })
  } catch (error) {
    if (!error.instagramWindowRejected) throw error
    let lastInbound = NaN
    try {
      const latest = await loadConversation(session, conversationId, true)
      const dates = (latest.messages?.data || [])
        .filter(message => message.from?.id === recipient.id)
        .map(message => Date.parse(message.created_time))
        .filter(Number.isFinite)
      if (dates.length) lastInbound = Math.max(...dates)
    } catch { /* Keep the original send rejection if Meta cannot read the thread. */ }
    if (Number.isFinite(lastInbound)) {
      const when = new Date(lastInbound).toLocaleString('en-SG', {
        timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short',
      })
      const withinDay = Date.now() - lastInbound >= 0 && Date.now() - lastInbound < 864e5
      error.message += ` The latest incoming DM shown by Meta was ${when} SGT${withinDay ? ', within the last 24 hours' : ''}.`
    }
    throw error
  }
  return { id: sent.message_id, date: new Date().toISOString(), outgoing: true, text }
}
