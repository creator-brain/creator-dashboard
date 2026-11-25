import { randomBytes, timingSafeEqual } from 'node:crypto'

const graph = 'https://graph.facebook.com/v27.0'
const stateCookie = 'cp_meta_state'
const sessionCookie = 'cp_meta_session'
const sessionSeconds = 7 * 24 * 60 * 60
const localSessions = new Map()

const failure = (message, status) => Object.assign(new Error(message), { status })
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: process.env.META_REDIRECT_URI?.startsWith('https:'), path: '/api/meta' })
const readCookie = (req, name) => req.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1)
const randomId = () => randomBytes(32).toString('hex')
const validSessionId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const validConversationId = value => typeof value === 'string' && /^[\w=-]{1,512}$/.test(value)

export function instagramConfigured() {
  const { META_CLIENT_ID, META_CLIENT_SECRET, META_CONFIG_ID, META_REDIRECT_URI, META_IG_ACCOUNT_ID, META_SESSION_REDIS_URL, META_SESSION_REDIS_TOKEN } = process.env
  return Boolean(META_CLIENT_ID && META_CLIENT_SECRET && META_CONFIG_ID && META_REDIRECT_URI && /^\d+$/.test(META_IG_ACCOUNT_ID || '') &&
    (!process.env.VERCEL || (META_REDIRECT_URI.startsWith('https:') && META_SESSION_REDIS_URL && META_SESSION_REDIS_TOKEN)))
}

async function sessionCommand(command, id, session) {
  const key = `collab-pipeline:instagram:${id}`
  const { META_SESSION_REDIS_URL, META_SESSION_REDIS_TOKEN } = process.env
  if (META_SESSION_REDIS_URL && META_SESSION_REDIS_TOKEN) {
    const args = command === 'SET' ? [command, key, JSON.stringify(session), 'EX', sessionSeconds] : [command, key]
    const response = await fetch(META_SESSION_REDIS_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${META_SESSION_REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    }).catch(() => { throw failure('Instagram session storage is unavailable.', 503) })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data || data.error) throw failure('Instagram session storage is unavailable.', 503)
    return command === 'GET' && data.result ? JSON.parse(data.result) : null
  }
  if (process.env.VERCEL) throw failure('Instagram session storage is not configured.', 503)
  for (const [key, entry] of localSessions) if (entry.expires <= Date.now()) localSessions.delete(key)
  if (command === 'SET') localSessions.set(key, { session, expires: Date.now() + sessionSeconds * 1000 })
  if (command === 'DEL') localSessions.delete(key)
  return localSessions.get(key)?.session || null
}

async function graphRequest(path, params, token) {
  const url = `${graph}${path}?${new URLSearchParams(params)}`
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'error', signal: AbortSignal.timeout(8000),
  }).catch(() => { throw failure('Could not reach Instagram. Try again.', 502) })
  const data = await response.json().catch(() => null)
  if (data?.error?.code === 190 && token) throw failure('Instagram authorization expired. Disconnect and connect again.', 401)
  if (!response.ok || !data || data.error) throw failure('Meta could not complete the Instagram request. Check the account and messaging permissions.', 502)
  return data
}

export async function instagramSession(req) {
  const id = readCookie(req, sessionCookie)
  if (!instagramConfigured() || !validSessionId(id)) return null
  const session = await sessionCommand('GET', id)
  return session?.account.id === process.env.META_IG_ACCOUNT_ID && session.configId === process.env.META_CONFIG_ID ? session : null
}

export function instagramAuthorize(req, res) {
  if (!instagramConfigured()) throw failure('Instagram server setup is required.', 503)
  const callback = new URL(process.env.META_REDIRECT_URI)
  if (req.get('host') !== callback.host) return res.redirect(new URL('/api/meta/auth/start', callback).href)
  const state = randomId()
  res.cookie(stateCookie, state, { ...cookieOptions(), maxAge: 10 * 60_000 })
  const params = new URLSearchParams({
    client_id: process.env.META_CLIENT_ID,
    config_id: process.env.META_CONFIG_ID,
    redirect_uri: process.env.META_REDIRECT_URI,
    response_type: 'code', state, prompt: 'login',
  })
  res.redirect(`https://www.facebook.com/dialog/oauth?${params}`)
}

export async function instagramCallback(req, res) {
  const { state, code } = req.query
  const expected = readCookie(req, stateCookie)
  res.clearCookie(stateCookie, cookieOptions())
  if (!instagramConfigured() || !validSessionId(state) || !validSessionId(expected) || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
    throw failure('Instagram login expired or could not be verified. Start again from Integrations.', 400)
  }
  const redirect = new URL('/', process.env.META_APP_ORIGIN || process.env.META_REDIRECT_URI)
  const finish = result => {
    redirect.searchParams.set('instagram', result)
    return res.redirect(redirect.href)
  }
  if (req.query.error === 'access_denied') return finish('cancelled')
  if (req.query.error) return finish('failed')
  if (typeof code !== 'string' || !code) throw failure('Meta did not return an Instagram authorization code.', 400)
  try {
    const session = await exchangeInstagramCode(code)
    const oldId = readCookie(req, sessionCookie)
    const id = randomId()
    await sessionCommand('SET', id, session)
    if (validSessionId(oldId)) await sessionCommand('DEL', oldId)
    res.cookie(sessionCookie, id, { ...cookieOptions(), maxAge: sessionSeconds * 1000 })
    return finish('connected')
  } catch (error) {
    if (error.status === 403) return finish('account')
    if (error.status === 503) return finish('storage')
    return finish('failed')
  }
}

async function exchangeInstagramCode(code) {
  const { access_token: token } = await graphRequest('/oauth/access_token', {
    client_id: process.env.META_CLIENT_ID, client_secret: process.env.META_CLIENT_SECRET,
    redirect_uri: process.env.META_REDIRECT_URI, code,
  })
  if (!token) throw failure('Meta did not return an Instagram access token.', 502)
  const seenCursors = new Set()
  let account, after
  do {
    if (seenCursors.has(after)) throw failure('Meta returned a repeated account page.', 502)
    seenCursors.add(after)
    const result = await graphRequest('/me/assigned_instagram_accounts', { fields: 'id,username', ...(after ? { after } : {}) }, token)
    account = result.data?.find(item => item.id === process.env.META_IG_ACCOUNT_ID)
    after = result.paging?.next ? result.paging.cursors?.after : null
  } while (!account && after)
  if (!account) throw failure('Authorize the Instagram professional account configured for this dashboard.', 403)
  const profile = await graphRequest('/me', { fields: 'client_business_id' }, token)
  return { token, account, businessId: profile.client_business_id, configId: process.env.META_CONFIG_ID }
}

export async function instagramDisconnect(req, res) {
  const id = readCookie(req, sessionCookie)
  if (validSessionId(id)) await sessionCommand('DEL', id)
  res.clearCookie(sessionCookie, cookieOptions()).json({ connected: false })
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

export async function instagramConversation(session, id, { includeMessages = true } = {}) {
  if (!validConversationId(id)) throw failure('Invalid Instagram conversation ID.', 400)
  const row = await graphRequest(`/${encodeURIComponent(id)}`, {
    fields: `id,updated_time,participants${includeMessages ? ',messages.limit(20){id,created_time,from,message}' : ''}`,
  }, session.token)
  if (!row.participants?.data?.some(person => person.id === session.account.id)) {
    throw failure('This Instagram conversation is outside the connected account.', 403)
  }
  return {
    id: row.id, username: counterpart(row, session.account.id), updatedAt: row.updated_time,
    messages: (row.messages?.data || []).map(message => ({
      id: message.id, date: message.created_time, sender: message.from?.username || '',
      outgoing: message.from?.id === session.account.id, text: message.message || '',
    })).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
  }
}
