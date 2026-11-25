import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

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

async function graphRequest(path, params, token) {
  const url = `${graph}${path}?${new URLSearchParams(params)}`
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'error', signal: AbortSignal.timeout(8000),
  }).catch(() => { throw failure('Could not reach Instagram. Try again.', 502) })
  const data = await response.json().catch(() => null)
  if (data?.error?.code === 190 && token) throw failure('The Meta access token expired or was revoked. Update it on the server.', 401)
  if (!response.ok || !data || data.error) throw failure('Meta could not complete the Instagram request. Check the account and messaging permissions.', 502)
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
