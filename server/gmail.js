import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { parseDocument } from 'htmlparser2'
import { messageUrl } from '../src/messageLinks.js'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
]
const SESSION = 'cp_gmail_session'
const STATE = 'cp_gmail_state'

const config = () => ({
  clientId: process.env.GMAIL_CLIENT_ID,
  clientSecret: process.env.GMAIL_CLIENT_SECRET,
  cookieKey: process.env.GMAIL_COOKIE_KEY,
  redirectUri: process.env.GMAIL_REDIRECT_URI,
})

export function gmailConfigured() {
  const c = config()
  return Boolean(c.clientId && c.clientSecret && c.cookieKey && c.redirectUri)
}

function requiredConfig() {
  const c = config()
  if (!gmailConfigured()) throw Object.assign(new Error('Gmail is not configured. Set the Google OAuth client and cookie key on the server.'), { status: 503 })
  return c
}

function key() {
  const raw = Buffer.from(requiredConfig().cookieKey, 'base64url')
  if (raw.length !== 32) throw Object.assign(new Error('GMAIL_COOKIE_KEY must be a 32-byte base64url key.'), { status: 503 })
  return raw
}

function seal(value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')
}

function open(value) {
  try {
    const bytes = Buffer.from(value, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  } catch { return '' }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([name]) => name))
}

function cookieOptions(req, maxAge) {
  return { httpOnly: true, secure: Boolean(process.env.VERCEL || req.secure), sameSite: 'lax', path: '/api', maxAge }
}

export function gmailConnected(req) {
  return gmailConfigured() && Boolean(open(cookies(req)[SESSION] || ''))
}

export function gmailAuthorize(req, res) {
  const c = requiredConfig()
  key()
  const state = randomBytes(24).toString('base64url')
  res.cookie(STATE, seal(state), cookieOptions(req, 10 * 60_000))
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.redirectUri, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state }).toString()
  res.redirect(url.toString())
}

async function tokenRequest(params) {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error_description || result.error || 'Google authorization failed.'), { status: response.status })
  return result
}

export async function gmailCallback(req, res) {
  const c = requiredConfig()
  const expected = open(cookies(req)[STATE] || '')
  res.clearCookie(STATE, cookieOptions(req, 0))
  const received = String(req.query.state || '')
  if (!expected || expected.length !== received.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) throw Object.assign(new Error('Gmail sign-in state did not match. Try connecting again.'), { status: 400 })
  if (req.query.error) throw Object.assign(new Error('Gmail access was not granted.'), { status: 400 })
  if (typeof req.query.code !== 'string') throw Object.assign(new Error('Google did not return an authorization code.'), { status: 400 })
  const tokens = await tokenRequest({ code: req.query.code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: 'authorization_code' })
  if (!tokens.refresh_token) throw Object.assign(new Error('Google did not return a refresh token. Reconnect and grant offline access.'), { status: 502 })
  res.cookie(SESSION, seal(tokens.refresh_token), cookieOptions(req, 30 * 864e5))
  res.redirect(process.env.GMAIL_APP_ORIGIN || '/')
}

export function gmailDisconnect(req, res) {
  res.clearCookie(SESSION, cookieOptions(req, 0))
  res.json({ connected: false })
}

const accessCache = new Map()
async function accessToken(req) {
  const refreshToken = open(cookies(req)[SESSION] || '')
  if (!refreshToken) throw Object.assign(new Error('Connect Gmail to continue.'), { status: 401 })
  const cacheKey = createHash('sha256').update(refreshToken).digest('hex')
  const cached = accessCache.get(cacheKey)
  if (cached && cached.expires > Date.now() + 60_000) return cached.token
  const c = requiredConfig()
  const tokens = await tokenRequest({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token' })
  accessCache.set(cacheKey, { token: tokens.access_token, expires: Date.now() + (tokens.expires_in || 3600) * 1000 })
  return tokens.access_token
}

export async function gmailRequest(req, path, options = {}) {
  const token = await accessToken(req)
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error?.message || `Gmail returned ${response.status}.`), { status: response.status })
  return result
}

export function threadIdFromUrl(value) {
  if (!value) return ''
  const parse = tail => {
    if (/^[a-f\d]{8,32}$/i.test(tail)) return tail.toLowerCase()
    if (/^thread-f:\d{10,20}$/.test(tail)) {
      const number = BigInt(tail.slice('thread-f:'.length))
      return number <= 0xffffffffffffffffn ? number.toString(16) : ''
    }
    return ''
  }
  if (!value.includes('://')) return parse(value)
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'mail.google.com') return ''
    const tail = (url.hash || url.pathname).split('/').filter(Boolean).at(-1)
    return parse(tail || '')
  } catch { return '' }
}

export const gmailThreadUrl = id => `https://mail.google.com/mail/u/0/#all/${id}`

const header = (message, name) => message.payload?.headers?.find(item => item.name?.toLowerCase() === name.toLowerCase())?.value || ''
const decode = value => value ? Buffer.from(value, 'base64url').toString('utf8') : ''
function htmlMessage(value) {
  let text = ''
  let quoted = false
  const anchors = []
  function visit(node) {
    if (quoted || ['script', 'style', 'head', 'title', 'template'].includes(node.name)) return
    if (node.attribs?.class?.split(/\s+/).includes('gmail_quote') || node.attribs?.id?.toLowerCase() === 'divrplyfwdmsg') {
      quoted = true
      return
    }
    if (node.type === 'text') text += node.data.replace(/\r\n?/g, '\n')
    const start = text.length
    for (const child of node.children || []) visit(child)
    if (node.name === 'a') {
      const url = messageUrl(node.attribs?.href)
      if (url) anchors.push({ start, url, label: text.slice(start).replace(/\s+/g, ' ').trim() || url })
    }
    if (['br', 'p', 'div', 'li', 'tr', 'hr'].includes(node.name)) text += '\n'
  }
  visit(parseDocument(value))
  const current = currentMessageText(text)
  const truncated = current !== text.trim()
  const end = text.length - text.trimStart().length + current.length
  const links = new Map()
  for (const { start, url, label } of anchors) {
    if ((!truncated || start < end) && !links.has(url)) links.set(url, { url, label })
  }
  return { body: current.replace(/\n{3,}/g, '\n\n'), links: [...links.values()] }
}
export function currentMessageText(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n')
  const hasNewText = index => lines.slice(0, index).some(line => line.trim() && !/^>/.test(line.trim()))
  const oldHeaders = index => /^From:\s+\S/i.test(lines[index] || '') && lines.slice(index + 1, index + 6).some(line => /^(Sent|Date|To|Subject):\s+/i.test(line.trim()))
  const cut = lines.findIndex((line, index) => index > 0 && hasNewText(index) && (
    /^On .{8,} wrote:\s*$/i.test(line.trim()) ||
    /^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim()) ||
    (index > 1 && !lines[index - 1].trim() && oldHeaders(index)) ||
    (/^>/.test(line.trim()) && /^>/.test((lines[index + 1] || '').trim()))
  ))
  return (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trim()
}
function bodyText(part, mime) {
  if (part.filename || part.mimeType === 'message/rfc822') return ''
  if (part.mimeType === mime && part.body?.data) return decode(part.body.data)
  return (part.parts || []).map(child => bodyText(child, mime)).find(Boolean) || ''
}

export const GMAIL_ATTACHMENT_DOWNLOAD_LIMIT = 4 * 1024 * 1024

export function gmailAttachmentParts(part = {}) {
  const { filename, mimeType, body } = part
  const disposition = part.headers?.find(({ name }) => name.toLowerCase() === 'content-disposition')?.value || ''
  const isPdf = mimeType?.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(filename || '')
  if (body && (filename || isPdf || /^attachment\b/i.test(disposition)) &&
    (!/^inline\b/i.test(disposition) || isPdf)) {
    const fallback = isPdf ? 'Attachment.pdf' : 'Attachment'
    const name = (filename || fallback).replace(/[\x00-\x1f\x7f/\\]/g, '_').trim().slice(0, 180) || fallback
    return [{ name, body, mimeType: isPdf ? 'application/pdf' : mimeType || 'application/octet-stream' }]
  }
  if (mimeType === 'message/rfc822') return []
  return (part.parts || []).flatMap(gmailAttachmentParts)
}

export const gmailPdfParts = part => gmailAttachmentParts(part).filter(file => file.mimeType === 'application/pdf')

export function summarizeThread(thread, accountEmail) {
  const messages = (thread.messages || []).map(message => {
    const html = htmlMessage(bodyText(message.payload || {}, 'text/html'))
    const attachments = gmailAttachmentParts(message.payload).map(({ name, body, mimeType }, index) => {
      const size = Number.isSafeInteger(body.size) && body.size >= 0 ? body.size : null
      return { name, mimeType, index, size, downloadable: Boolean(body.attachmentId || body.data) && (size === null || size <= GMAIL_ATTACHMENT_DOWNLOAD_LIMIT) }
    })
    const pdfs = attachments.filter(file => file.mimeType === 'application/pdf')
      .map(({ name, size, downloadable }, index) => ({ name, index, size, downloadable }))
    return {
      id: message.id,
      from: header(message, 'From'),
      to: header(message, 'To'),
      subject: header(message, 'Subject'),
      date: Number(message.internalDate) || 0,
      sent: (message.labelIds || []).includes('SENT'),
      outgoing: (message.labelIds || []).includes('SENT') || Boolean(accountEmail && address(header(message, 'From')).toLowerCase() === accountEmail.toLowerCase()),
      draft: (message.labelIds || []).includes('DRAFT'),
      body: currentMessageText(bodyText(message.payload || {}, 'text/plain') || html.body || message.snippet || ''),
      links: html.links,
      pdfs,
      attachments,
      messageId: header(message, 'Message-ID'),
      references: header(message, 'References'),
      replyTo: header(message, 'Reply-To'),
    }
  })
  return { id: thread.id, messages }
}

const address = value => String(value || '').match(/<([^<>\s,]+@[^<>\s,]+)>/)?.[1] || String(value || '').match(/\b[^\s,<>]+@[^\s,<>]+\.[^\s,<>]+\b/)?.[0] || ''
export function replyDetails(thread, accountEmail) {
  const messages = (thread?.messages || []).filter(message => !message.draft)
  const last = messages.at(-1)
  const external = [...messages].reverse().map(message => message.sent ? address(message.to) : address(message.replyTo || message.from)).find(email => email && email.toLowerCase() !== accountEmail?.toLowerCase()) || ''
  return { to: external, subject: last?.subject || '', replyToId: last?.messageId || '', references: last?.references || '' }
}

const cleanHeader = value => String(value || '').replace(/[\r\n\0]/g, ' ').trim()
const subjectHeader = value => /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`
const wrapBase64 = value => value.match(/.{1,76}/g)?.join('\r\n') || ''
function normalizeAttachments(input) {
  if (input == null) return []
  if (!Array.isArray(input) || input.length > 10) throw Object.assign(new Error('Choose up to 10 attachments.'), { status: 400 })
  let total = 0
  return input.map(item => {
    if (!item || typeof item.name !== 'string' || typeof item.data !== 'string') throw Object.assign(new Error('Invalid attachment.'), { status: 400 })
    const name = item.name.replace(/[\r\n\0\\/]/g, '_').trim()
    if (!name || name.length > 150 || !item.data || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(item.data)) throw Object.assign(new Error('Invalid attachment name or content.'), { status: 400 })
    const data = Buffer.from(item.data, 'base64')
    total += data.length
    if (total > 2.5 * 1024 * 1024) throw Object.assign(new Error('Attachments must total 2.5 MB or less.'), { status: 400 })
    const type = typeof item.type === 'string' && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(item.type) ? item.type : 'application/octet-stream'
    return { name, type, data: data.toString('base64') }
  })
}
export function makeMessage({ from, to, subject, body, attachments, threadId, replyToId, references }) {
  from = cleanHeader(from)
  to = cleanHeader(to)
  subject = cleanHeader(subject)
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)) throw Object.assign(new Error('Gmail account has no valid sending address.'), { status: 400 })
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw Object.assign(new Error('Enter one valid recipient email address.'), { status: 400 })
  if (!subject || subject.length > 250) throw Object.assign(new Error('Enter a subject under 250 characters.'), { status: 400 })
  if (typeof body !== 'string' || !body.trim() || body.length > 100_000) throw Object.assign(new Error('Enter an email body under 100,000 characters.'), { status: 400 })
  const files = normalizeAttachments(attachments)
  const lines = [`From: ${from}`, `To: ${to}`, `Subject: ${subjectHeader(subject)}`, 'MIME-Version: 1.0']
  if (threadId && replyToId) {
    lines.push(`In-Reply-To: ${cleanHeader(replyToId)}`)
    lines.push(`References: ${cleanHeader(`${references || ''} ${replyToId}`).slice(-900)}`)
  }
  const encodedBody = wrapBase64(Buffer.from(body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'))
  let mime
  if (!files.length) {
    lines.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64')
    mime = `${lines.join('\r\n')}\r\n\r\n${encodedBody}\r\n`
  } else {
    const boundary = `cp_${randomBytes(18).toString('hex')}`
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodedBody}\r\n`]
    for (const file of files) {
      const fallback = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_')
      parts.push(`--${boundary}\r\nContent-Type: ${file.type}; name="${fallback}"\r\nContent-Disposition: attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.name)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapBase64(file.data)}\r\n`)
    }
    mime = `${lines.join('\r\n')}\r\n\r\n${parts.join('')}--${boundary}--\r\n`
  }
  return { raw: Buffer.from(mime, 'utf8').toString('base64url'), ...(threadId && replyToId ? { threadId } : {}) }
}
