import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { contentMetrics, creatorAccount } from '../src/analytics.js'

const base = 'https://open.tiktokapis.com/v2'
const scopes = ['user.info.basic', 'user.info.stats', 'video.list']
const stateCookie = 'cp_tiktok_state'
const sessionCookie = 'cp_tiktok_session'
const oauthErrors = new Set([
  'access_denied', 'invalid_client', 'invalid_grant', 'invalid_request', 'invalid_scope',
  'unauthorized_client', 'unsupported_grant_type', 'server_error', 'temporarily_unavailable',
])
const failure = (message, status) => Object.assign(new Error(message), { status })
const config = () => ({
  client_key: process.env.TIKTOK_CLIENT_KEY,
  client_secret: process.env.TIKTOK_CLIENT_SECRET,
  redirect_uri: process.env.TIKTOK_REDIRECT_URI,
  app_origin: process.env.TIKTOK_APP_ORIGIN,
})

const loopback = callback => ['127.0.0.1', 'localhost'].includes(callback.hostname) && Boolean(callback.port)

export function tiktokConfigured() {
  try {
    const { client_key, client_secret, redirect_uri, app_origin } = config()
    const callback = new URL(redirect_uri)
    const app = new URL(app_origin || callback.origin)
    const permittedScheme = callback.protocol === 'https:' ||
      (!process.env.VERCEL && callback.protocol === 'http:' && loopback(callback))
    return Boolean(client_key && client_secret && permittedScheme && !callback.search && !callback.hash &&
      !callback.username && !callback.password && callback.pathname === '/api/tiktok/auth/callback' &&
      app.protocol === callback.protocol && app.hostname === callback.hostname &&
      !app.username && !app.password && app.pathname === '/' && !app.search && !app.hash &&
      Buffer.from(process.env.TIKTOK_COOKIE_KEY || '', 'base64url').length === 32)
  } catch { return false }
}

const key = () => Buffer.from(process.env.TIKTOK_COOKIE_KEY, 'base64url')
function seal(value, purpose) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(purpose + ':' + config().client_key))
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')
}

function read(req, name) {
  if (!tiktokConfigured()) return null
  const raw = req.get('cookie')?.match(new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9_-]+)'))?.[1]
  if (!raw) return null
  try {
    const bytes = Buffer.from(raw, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12))
    decipher.setAAD(Buffer.from(name + ':' + config().client_key))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString())
  } catch { return null }
}

const cookieOptions = () => ({
  httpOnly: true, secure: Boolean(process.env.VERCEL) || !config().redirect_uri?.startsWith('http://'),
  sameSite: 'lax', path: '/api/tiktok',
})
const cookieState = req => read(req, stateCookie)
const session = req => read(req, sessionCookie)
export const tiktokStatus = req => {
  const configured = tiktokConfigured()
  const connection = session(req)
  return {
    configured,
    connected: Boolean(connection && connection.refreshExpires > Date.now()),
    ...(configured ? { authorizeUrl: new URL('/api/tiktok/auth/start', config().redirect_uri).href } : {}),
  }
}

export function tiktokAuthorize(req, res) {
  if (!tiktokConfigured()) throw failure('TikTok server setup is required.', 503)
  const { client_key, redirect_uri } = config()
  const callback = new URL(redirect_uri)
  if (req.get('host') !== callback.host) throw failure('Start TikTok sign-in from the dashboard’s Connect TikTok button.', 400)
  const state = randomBytes(24).toString('base64url')
  const verifier = loopback(callback) ? randomBytes(32).toString('base64url') : ''
  res.cookie(stateCookie, seal({ state, verifier, redirectUri: redirect_uri, expires: Date.now() + 600_000 }, stateCookie), { ...cookieOptions(), maxAge: 600_000 })
  const url = new URL('https://www.tiktok.com/v2/auth/authorize/')
  url.search = new URLSearchParams({
    client_key, redirect_uri, state, response_type: 'code', scope: scopes.join(','),
    ...(verifier ? { code_challenge: createHash('sha256').update(verifier).digest('hex'), code_challenge_method: 'S256' } : {}),
  }).toString()
  res.redirect(url.href)
}

async function tokenOperation(operation, params) {
  const { client_key, client_secret } = config()
  const response = await fetch(base + '/oauth/' + operation + '/', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key, client_secret, ...params }),
    redirect: 'error', signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  const data = await response?.json().catch(() => null)
  if (operation === 'revoke' && response?.ok && !data?.error) return null
  if (!response?.ok || !data || data.error) {
    const category = oauthErrors.has(data?.error) ? data.error : 'unknown_error'
    const reference = typeof data?.log_id === 'string' && /^[a-z\d_-]{8,80}$/i.test(data.log_id) ? data.log_id : ''
    const detail = typeof data?.error_description === 'string' ? data.error_description : ''
    const issue = /redirect[ _]?uri/i.test(detail) ? 'TikTok rejected the callback URL. Check the Sandbox redirect URI.'
      : category === 'invalid_client' || /client[ _-]?secret/i.test(detail) ? 'TikTok rejected the app credentials. Check that the Sandbox client key and secret belong to the same app.'
      : category === 'invalid_grant' ? 'TikTok rejected or expired this authorization. Start a fresh connection.'
      : 'TikTok rejected the token exchange. Start a fresh connection.'
    console.warn('TikTok OAuth request failed', { operation, category, httpStatus: response?.status, reference })
    throw failure(`${issue} (${category}${reference ? `, TikTok reference ${reference}` : ''})`, category === 'invalid_grant' ? 401 : 502)
  }
  return data
}

function saveSession(res, connection) {
  res.cookie(sessionCookie, seal(connection, sessionCookie), {
    ...cookieOptions(), maxAge: Math.min(30 * 86400_000, connection.refreshExpires - Date.now()),
  })
}

function tokenSession(tokens) {
  if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string' ||
      !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
      !Number.isFinite(tokens.refresh_expires_in) || tokens.refresh_expires_in <= 0) {
    throw failure('TikTok did not return a usable session.', 502)
  }
  const now = Date.now()
  return {
    access: tokens.access_token, refresh: tokens.refresh_token,
    accessExpires: now + tokens.expires_in * 1000, refreshExpires: now + tokens.refresh_expires_in * 1000,
  }
}

export async function tiktokCallback(req, res) {
  res.set('Referrer-Policy', 'no-referrer')
  const pending = cookieState(req)
  res.clearCookie(stateCookie, cookieOptions())
  const { code, state } = req.query
  if (!pending || pending.expires <= Date.now() || typeof state !== 'string' ||
      !/^[A-Za-z0-9_-]{32}$/.test(state) || !timingSafeEqual(Buffer.from(pending.state), Buffer.from(state))) {
    throw failure('TikTok sign-in expired or did not match. Try connecting again.', 400)
  }
  if (req.query.error || typeof code !== 'string' || !code) throw failure('TikTok access was not granted.', 400)
  const tokens = await tokenOperation('token', {
    grant_type: 'authorization_code', redirect_uri: pending.redirectUri || config().redirect_uri, code,
    ...(pending.verifier ? { code_verifier: pending.verifier } : {}),
  })
  const granted = (tokens.scope || '').split(/[\s,]+/)
  if (scopes.some(scope => !granted.includes(scope))) throw failure('Grant profile statistics and video access when connecting TikTok.', 403)
  saveSession(res, tokenSession(tokens))
  const appOrigin = config().app_origin
  res.redirect(appOrigin ? new URL('/?analytics=tiktok#overview', appOrigin).href : '/?analytics=tiktok#overview')
}

const refreshes = new Map()
async function accessToken(req, res, force = false) {
  const connection = session(req)
  if (!connection || connection.refreshExpires <= Date.now()) throw failure('Connect TikTok to continue.', 401)
  if (!force && connection.accessExpires > Date.now() + 30_000) return connection.access
  const id = createHash('sha256').update(connection.refresh).digest('hex')
  let refreshed = refreshes.get(id)
  if (!refreshed) {
    refreshed = tokenOperation('token', { grant_type: 'refresh_token', refresh_token: connection.refresh }).then(tokenSession)
    refreshes.set(id, refreshed)
    const release = () => setTimeout(() => refreshes.delete(id), 10_000).unref()
    refreshed.then(release, release)
  }
  const next = await refreshed
  saveSession(res, next)
  return next.access
}

export async function tiktokDisconnect(req, res) {
  if (tiktokStatus(req).connected) {
    try {
      const token = await accessToken(req, res)
      await tokenOperation('revoke', { token })
    } catch (error) {
      if (error.status !== 401) throw error
    }
  }
  res.clearCookie(sessionCookie, cookieOptions())
  res.json({ connected: false, configured: tiktokConfigured() })
}

async function request(path, fields, token, body) {
  const response = await fetch(base + path + '?' + new URLSearchParams({ fields }), {
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    redirect: 'error', signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  const payload = await response?.json().catch(() => null)
  if (response?.status === 401 || payload?.error?.code === 'access_token_invalid') throw failure('Your TikTok access token expired.', 401)
  if (!response?.ok || !payload?.data || payload.error?.code !== 'ok') throw failure('TikTok analytics are currently unavailable.', 502)
  return payload.data
}

function safeUrl(value, suffix = '') {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    if (suffix && url.hostname !== suffix && !url.hostname.endsWith('.' + suffix)) return ''
    return url.href
  } catch { return '' }
}

export async function tiktokAnalytics(req, res) {
  const status = tiktokStatus(req)
  if (!status.connected) return { ...status, analytics: null }
  const getData = token => Promise.all([
    request('/user/info/', 'display_name,follower_count,following_count,likes_count,video_count', token),
    request('/video/list/', 'id,create_time,title,video_description,share_url,cover_image_url,view_count,like_count,comment_count,share_count', token, { max_count: 15 }),
  ])
  try {
    const token = await accessToken(req, res)
    const [profile, media] = await getData(token).catch(async error => {
      if (error.status !== 401) throw error
      return getData(await accessToken(req, res, true))
    })
    const user = profile.user
    if (!user || !Array.isArray(media.videos)) throw failure('TikTok returned incomplete analytics.', 502)
    return { ...status, analytics: {
      account: creatorAccount('tiktok', {
        username: user.display_name, followers: user.follower_count, following: user.following_count,
        posts: user.video_count, likes: user.likes_count,
      }),
      posts: media.videos.slice(0, 15).flatMap(video => {
        const date = new Date(video.create_time * 1000)
        if (typeof video.id !== 'string' || !Number.isFinite(date.getTime())) return []
        return [{
          id: video.id,
          date: date.toISOString(),
          caption: (video.title || video.video_description || '').slice(0, 150),
          url: safeUrl(video.share_url, 'tiktok.com'),
          image: safeUrl(video.cover_image_url),
          metrics: contentMetrics({ views: video.view_count, likes: video.like_count, comments: video.comment_count, shares: video.share_count }),
        }]
      }),
    } }
  } catch (error) {
    if (error.status !== 401) throw error
    res.clearCookie(sessionCookie, cookieOptions())
    return { ...status, connected: false, analytics: null }
  }
}
