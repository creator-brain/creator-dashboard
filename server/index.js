import express from 'express'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { conversationHas, recordHas, DATA_SOURCE_ID, INSTAGRAM_CONVERSATION, instagramConversationId, instagramLinkHandle, notion, pageMarkdown, reconcileFollowUps, toDeal, unlinkedInstagramDeals, updateDeal } from './notion.js'
import { normalizeInstagramHandle, sourceOf } from '../src/model.js'
import { threadMessageLinks } from '../src/messageLinks.js'
import { instagramAnalytics, instagramConfigured, instagramConversation, instagramConversations, instagramMessageFile, instagramDailyMetric, instagramLock, instagramScorecard, instagramSession, instagramUnlock, sendInstagramReply, validConversationId } from './instagram.js'
import { gmailAttachmentParts, gmailAuthorize, gmailCallback, gmailConfigured, gmailConnected, gmailDisconnect, gmailPdfParts, gmailRequest, gmailThreadUrl, GMAIL_ATTACHMENT_DOWNLOAD_LIMIT, makeMessage, viewableAttachmentType, replyDetails, summarizeThread, threadIdFromUrl } from './gmail.js'
import { validWebhookSignature, webhookChallenge } from './metaWebhook.js'
import { tiktokAnalytics, tiktokAuthorize, tiktokCallback, tiktokDisconnect, tiktokStatus } from './tiktok.js'

try {
  const env = readFileSync(resolve('.env'), 'utf8')
  for (const [name, value] of Object.entries(parseEnv(env))) {
    if (!process.env[name]) process.env[name] = value
  }
} catch { /* Environment variables may already be supplied by the host. */ }

const app = express()
app.disable('x-powered-by')
app.get('/api/meta/webhook', (req, res) => {
  if (!process.env.META_WEBHOOK_VERIFY_TOKEN) return res.sendStatus(503)
  const challenge = webhookChallenge(req.query, process.env.META_WEBHOOK_VERIFY_TOKEN)
  if (challenge === null) return res.sendStatus(403)
  res.type('text/plain').send(challenge)
})
app.post('/api/meta/webhook', express.raw({ type: 'application/json', limit: '256kb' }), (req, res) => {
  if (!process.env.META_CLIENT_SECRET) return res.sendStatus(503)
  if (!validWebhookSignature(req.body, req.get('x-hub-signature-256'), process.env.META_CLIENT_SECRET)) return res.sendStatus(403)
  res.status(501).send('Instagram message sync is not ready yet.')
})
const smallBody = express.json({ limit: '32kb' })
const emailBody = express.json({ limit: '4.3mb' })
app.use((req, res, next) => (/^\/api\/deals\/[\da-f-]{32,36}\/gmail\/(draft|send)$/.test(req.path) ? emailBody : smallBody)(req, res, next))
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next() })

app.get('/api/health', (_req, res) => res.json({ configured: Boolean(process.env.NOTION_TOKEN) }))
app.get('/api/gmail/status', async (req, res, next) => {
  try {
    const configured = gmailConfigured(), connected = gmailConnected(req)
    const profile = connected ? await gmailRequest(req, '/profile') : null
    res.json({ configured, connected, email: profile?.emailAddress || '' })
  } catch (error) { next(error) }
})
app.get('/api/gmail/auth/start', (req, res, next) => { try { gmailAuthorize(req, res) } catch (error) { next(error) } })
app.get('/api/gmail/auth/callback', async (req, res, next) => { try { await gmailCallback(req, res) } catch (error) { next(error) } })
function sameSiteWrite(req, res, next) {
  try {
    if (new URL(req.get('origin')).hostname !== req.hostname) return res.status(403).json({ error: 'Cross-site request blocked.' })
    next()
  } catch { res.status(403).json({ error: 'Request origin required.' }) }
}
app.post('/api/gmail/disconnect', sameSiteWrite, gmailDisconnect)
app.get('/api/tiktok/status', (req, res) => res.json(tiktokStatus(req)))
app.get('/api/tiktok/auth/start', tiktokAuthorize)
app.get('/api/tiktok/auth/callback', tiktokCallback)
app.post('/api/tiktok/disconnect', sameSiteWrite, tiktokDisconnect)
app.get('/api/tiktok/analytics', async (req, res) => res.json(await tiktokAnalytics(req, res)))
app.get('/api/meta/status', (req, res) => {
  res.json({ configured: instagramConfigured(), connected: Boolean(instagramSession(req)) })
})
app.post('/api/meta/unlock', sameSiteWrite, instagramUnlock)
app.post('/api/meta/lock', sameSiteWrite, instagramLock)

app.get('/api/meta/scorecard', async (req, res) => {
  const session = instagramSession(req)
  res.json({ scorecard: session ? await instagramScorecard(session) : null })
})

app.get('/api/meta/analytics', async (req, res) => {
  const { days = '30', section, until } = req.query
  if (!['7', '30', '90'].includes(days)) return res.status(400).json({ error: 'Choose 7, 30, or 90 days.' })
  if (section !== undefined && !['account', 'content'].includes(section)) return res.status(400).json({ error: 'Choose account or content analytics.' })
  if (until !== undefined && (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(until) ||
    !(Math.abs(Date.parse(until) - Math.floor(Date.now() / 86_400_000) * 86_400_000) <= 86_400_000))) {
    return res.status(400).json({ error: 'Invalid Instagram analytics date.' })
  }
  const configured = instagramConfigured()
  const session = instagramSession(req)
  res.json({ configured, analytics: session ? await instagramAnalytics(session, Number(days), section, until) : null })
})

function requireInstagramSession(req, res, next) {
  const session = instagramSession(req)
  if (!session) return res.status(401).json({ error: 'Unlock the Instagram inbox in Integrations first.' })
  res.locals.instagram = session
  next()
}

app.get('/api/meta/analytics/daily-:metric', requireInstagramSession, async (req, res) => {
  const { days = '30' } = req.query
  const { metric } = req.params
  if (!['7', '30', '90'].includes(days)) return res.status(400).json({ error: 'Choose 7, 30, or 90 days.' })
  if (!['views', 'engagement'].includes(metric)) return res.status(400).json({ error: 'Choose views or engagement.' })
  res.json({ daily: await instagramDailyMetric(res.locals.instagram, Number(days), metric) })
})

app.get('/api/meta/conversations', requireInstagramSession, async (req, res) => {
  const { after } = req.query
  if (after !== undefined && (typeof after !== 'string' || after.length > 2048)) return res.status(400).json({ error: 'Invalid Instagram cursor.' })
  res.json(await instagramConversations(res.locals.instagram, after))
})

app.get('/api/meta/pending-links', async (req, res) => {
  const session = instagramSession(req)
  res.json({ pending: session ? await unlinkedInstagramDeals() : [] })
})

async function instagramDeal(req, res, next) {
  const { id } = req.params
  if (!/^[\da-f-]{32,36}$/i.test(id)) return res.status(400).json({ error: 'Invalid page ID.' })
  const page = await notion(`/pages/${id}`)
  if (page.parent?.data_source_id?.replaceAll('-', '') !== DATA_SOURCE_ID.replaceAll('-', '')) return res.status(403).json({ error: 'Page is outside the tracker.' })
  const deal = toDeal(page)
  if (sourceOf(deal) !== 'Instagram') return res.status(400).json({ error: 'This deal does not have the Instagram source label.' })
  if (page.properties?.[INSTAGRAM_CONVERSATION]?.type !== 'rich_text') return res.status(409).json({ error: `Add a Text property called ${INSTAGRAM_CONVERSATION} to the Notion tracker.` })
  res.locals.deal = deal
  res.locals.conversationId = instagramConversationId(page)
  res.locals.contactHandle = instagramLinkHandle(page)
  next()
}

app.get('/api/meta/deals/:id', requireInstagramSession, instagramDeal, async (_req, res) => {
  const { instagram, conversationId } = res.locals
  if (!conversationId) return res.json({ conversation: null, contactHandle: res.locals.contactHandle })
  const conversation = await instagramConversation(instagram, conversationId)
  const has = conversationHas({
    attachments: conversation.messages.some(message => message.media?.length),
    links: threadMessageLinks(conversation.messages).length > 0,
  })
  const deal = await recordHas(res.locals.deal, has)
  res.json({ conversation, ...(deal ? { deal } : {}) })
})

app.get('/api/meta/deals/:id/messages/:messageId/media/:index', requireInstagramSession, instagramDeal, async (req, res) => {
  const { instagram, conversationId } = res.locals
  if (!conversationId) return res.status(404).json({ error: 'No linked Instagram conversation.' })
  const file = await instagramMessageFile(instagram, conversationId, req.params.messageId, req.params.index)
  res.set('Cache-Control', 'private, no-store')
  if (file.redirect) return res.redirect(file.redirect)
  sendViewableFile(res, file.bytes, file.name || 'instagram-attachment')
})

app.post('/api/meta/deals/:id/send', sameSiteWrite, requireInstagramSession, instagramDeal, async (req, res) => {
  const { instagram, conversationId, deal: currentDeal } = res.locals
  if (!conversationId || req.body?.conversationId !== conversationId) {
    return res.status(409).json({ error: 'The linked Instagram conversation changed. Refresh the deal before sending.' })
  }
  const message = await sendInstagramReply(instagram, conversationId, req.body?.text)
  const activityDate = instagramActivityDate({ updatedAt: message.date })
  let deal = null
  let warning = ''
  if (activityDate > currentDeal.last) {
    try { deal = await updateDeal(req.params.id, { prop: 'activity', value: activityDate }) }
    catch { warning = 'Message sent. Last Activity could not be updated in Notion.' }
  }
  res.json({ message, deal, warning })
})

app.post('/api/meta/deals/:id/link', sameSiteWrite, requireInstagramSession, instagramDeal, async (req, res) => {
  const { conversationId } = req.body || {}
  if (!validConversationId(conversationId)) return res.status(400).json({ error: 'Choose an Instagram conversation.' })
  const conversation = await instagramConversation(res.locals.instagram, conversationId)
  const deal = await updateDeal(req.params.id, { prop: 'instagram', value: conversationId, activityDate: instagramActivityDate(conversation) })
  res.json({ deal, conversation })
})

function instagramActivityDate({ updatedAt }) {
  return Number.isFinite(Date.parse(updatedAt)) ? new Date(updatedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }) : ''
}

app.post('/api/meta/deals/:id/auto-link', sameSiteWrite, requireInstagramSession, instagramDeal, async (req, res) => {
  const { conversationId } = req.body || {}
  const { contactHandle, instagram } = res.locals
  if (res.locals.conversationId || !contactHandle) return res.json({ deal: res.locals.deal })
  if (!validConversationId(conversationId)) return res.status(400).json({ error: 'Invalid Instagram conversation ID.' })
  const conversation = await instagramConversation(instagram, conversationId, { includeMessages: false })
  if (normalizeInstagramHandle(conversation.username) !== contactHandle) return res.status(409).json({ error: 'The conversation does not match the Notion contact.' })
  const deal = await updateDeal(req.params.id, {
    prop: 'instagram', value: conversationId, instagramHandle: contactHandle, activityDate: instagramActivityDate(conversation),
  })
  res.json({ deal })
})
async function linkedThread(req, res) {
  if (!/^[\da-f-]{32,36}$/i.test(req.params.id)) throw Object.assign(new Error('Invalid page ID.'), { status: 400 })
  const page = await notion(`/pages/${req.params.id}`)
  if (res) res.locals.page = page
  if (page.parent?.data_source_id?.replaceAll('-', '') !== DATA_SOURCE_ID.replaceAll('-', '')) throw Object.assign(new Error('Page is outside the tracker.'), { status: 403 })
  const url = page.properties?.['Gmail Thread']?.url || ''
  const threadId = threadIdFromUrl(url)
  if (url && !threadId) throw Object.assign(new Error('This Notion Gmail Thread link cannot be opened through the Gmail API.'), { status: 400 })
  return threadId
}
app.get('/api/deals/:id/gmail', async (req, res, next) => {
  try {
    const threadId = await linkedThread(req, res)
    if (!threadId) return res.json({ thread: null, reply: null })
    const data = await gmailRequest(req, `/threads/${encodeURIComponent(threadId)}?format=full`)
    const profile = await gmailRequest(req, '/profile')
    const thread = summarizeThread(data, profile.emailAddress)
    const has = conversationHas({
      attachments: thread.messages.some(mail => (mail.attachments || mail.pdfs || []).length),
      links: threadMessageLinks(thread.messages).length > 0,
    })
    const deal = await recordHas(toDeal(res.locals.page), has)
    res.json({ thread, reply: replyDetails(thread, profile.emailAddress), ...(deal ? { deal } : {}) })
  } catch (error) { next(error) }
})
// PDFs and real images (judged by their bytes) open in the browser tab; everything else downloads.
function sendViewableFile(res, bytes, name, downloadType = 'application/octet-stream') {
  res.set('X-Content-Type-Options', 'nosniff')
  const viewable = viewableAttachmentType(bytes)
  if (!viewable) return res.attachment(name).type(downloadType).send(bytes)
  const fallback = String(name || 'attachment').replace(/[^\x20-\x7e]|["\\]/g, '_')
  res.set('Content-Disposition', `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name || 'attachment')}`)
  if (viewable !== 'application/pdf') res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
  res.type(viewable).send(bytes)
}

app.get('/api/deals/:id/gmail/messages/:messageId/:kind/:index', async (req, res, next) => {
  const { messageId, kind, index } = req.params
  if (kind !== 'pdfs' && kind !== 'attachments') return next()
  const getParts = kind === 'pdfs' ? gmailPdfParts : gmailAttachmentParts
  if (!/^[\w-]{1,128}$/.test(messageId) || !/^\d{1,6}$/.test(index)) return res.status(400).json({ error: 'Invalid Gmail attachment.' })
  if (!gmailConnected(req)) return res.status(401).json({ error: 'Connect Gmail to download this attachment.' })
  const threadId = await linkedThread(req)
  if (!threadId) return res.status(404).json({ error: 'No linked Gmail thread.' })
  const path = `/messages/${encodeURIComponent(messageId)}`
  const message = await gmailRequest(req, `${path}?format=full`)
  const file = message.threadId === threadId ? getParts(message.payload)[Number(index)] : undefined
  if (!file) return res.status(404).json({ error: 'Attachment not found on this Gmail thread.' })
  if (file.body.size > GMAIL_ATTACHMENT_DOWNLOAD_LIMIT) return res.redirect(gmailThreadUrl(messageId))
  const body = file.body.attachmentId
    ? await gmailRequest(req, `${path}/attachments/${encodeURIComponent(file.body.attachmentId)}`) : file.body
  if (typeof body.data !== 'string' || !body.data.length) return res.redirect(gmailThreadUrl(messageId))
  if (body.data.length > Math.ceil(GMAIL_ATTACHMENT_DOWNLOAD_LIMIT / 3) * 4) return res.redirect(gmailThreadUrl(messageId))
  const bytes = Buffer.from(body.data, 'base64url')
  const isPdf = file.mimeType === 'application/pdf'
  if (bytes.length > GMAIL_ATTACHMENT_DOWNLOAD_LIMIT || (isPdf && !bytes.subarray(0, 1024).includes('%PDF-'))) return res.redirect(gmailThreadUrl(messageId))
  sendViewableFile(res, bytes, file.name, isPdf ? 'application/pdf' : 'application/octet-stream')
})
app.post('/api/deals/:id/gmail/link', sameSiteWrite, async (req, res, next) => {
  try {
    if (!/^[\da-f-]{32,36}$/i.test(req.params.id)) throw Object.assign(new Error('Invalid page ID.'), { status: 400 })
    const input = String(req.body?.url || '').trim()
    const threadId = threadIdFromUrl(input)
    if (!threadId) throw Object.assign(new Error('Paste a Gmail conversation link or thread ID.'), { status: 400 })
    const thread = summarizeThread(await gmailRequest(req, `/threads/${encodeURIComponent(threadId)}?format=full`))
    if (!thread.messages.length) throw Object.assign(new Error('No messages were found in this Gmail conversation.'), { status: 400 })
    const latest = Math.max(0, ...thread.messages.filter(message => !message.draft).map(message => message.date))
    const activityDate = latest ? new Date(latest).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }) : ''
    const deal = await updateDeal(req.params.id, { prop: 'gmail', value: input.startsWith('https://mail.google.com/') ? input : gmailThreadUrl(threadId), activityDate })
    res.json({ deal })
  } catch (error) { next(error) }
})
async function emailAction(req, res, next, action) {
  try {
    const threadId = await linkedThread(req)
    if (!threadId) throw Object.assign(new Error('This deal has no linked Gmail thread.'), { status: 400 })
    const profile = await gmailRequest(req, '/profile')
    const thread = summarizeThread(await gmailRequest(req, `/threads/${encodeURIComponent(threadId)}?format=metadata`))
    const reply = replyDetails(thread, profile.emailAddress)
    if (!reply.replyToId) throw Object.assign(new Error('The linked Gmail thread has no Message-ID to reply to.'), { status: 400 })
    const message = makeMessage({ from: profile.emailAddress, to: req.body?.to, subject: reply.subject, body: req.body?.body, attachments: req.body?.attachments, threadId, replyToId: reply.replyToId, references: reply.references })
    const draftId = req.body?.draftId
    if (draftId && (typeof draftId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(draftId))) throw Object.assign(new Error('Invalid Gmail draft ID.'), { status: 400 })
    if (draftId) {
      const existing = await gmailRequest(req, `/drafts/${encodeURIComponent(draftId)}?format=metadata`)
      if (existing.message?.threadId !== threadId) throw Object.assign(new Error('That draft does not belong to this deal.'), { status: 403 })
    }
    const path = action === 'draft' ? draftId ? `/drafts/${encodeURIComponent(draftId)}` : '/drafts' : draftId ? '/drafts/send' : '/messages/send'
    const payload = action === 'draft' ? { message } : draftId ? { id: draftId, message } : message
    const result = await gmailRequest(req, path, { method: action === 'draft' && draftId ? 'PUT' : 'POST', body: JSON.stringify(payload) })
    let warning = ''
    if (action === 'send') {
      try { await updateDeal(req.params.id, { prop: 'activity', value: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }) }) }
      catch (error) { warning = `Email sent, but Last Activity could not be updated in Notion: ${error.message}` }
    }
    res.json({ id: result.id, threadId: result.threadId || result.message?.threadId || threadId, action, warning })
  } catch (error) { next(error) }
}
app.post('/api/deals/:id/gmail/draft', sameSiteWrite, (req, res, next) => emailAction(req, res, next, 'draft'))
app.post('/api/deals/:id/gmail/send', sameSiteWrite, (req, res, next) => emailAction(req, res, next, 'send'))
let reconciliation
function syncFollowUps() {
  if (!reconciliation) reconciliation = reconcileFollowUps().finally(() => { reconciliation = null })
  return reconciliation
}
app.get('/api/deals', async (_req, res, next) => { try { res.json(await syncFollowUps()) } catch (error) { next(error) } })
app.get('/api/deals/:id/body', async (req, res, next) => {
  try {
    if (!/^[\da-f-]{32,36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid page ID' })
    const page = await notion(`/pages/${req.params.id}`)
    if (page.parent?.data_source_id?.replaceAll('-', '') !== DATA_SOURCE_ID.replaceAll('-', '')) return res.status(403).json({ error: 'Page is outside the tracker' })
    res.json({ markdown: await pageMarkdown(req.params.id) })
  } catch (error) { next(error) }
})
app.patch('/api/deals/:id', async (req, res, next) => {
  try {
    if (!/^[\da-f-]{32,36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid page ID' })
    const { prop, value } = req.body || {}
    if (!['status', 'type', 'fee', 'next', 'dl'].includes(prop)) return res.status(400).json({ error: 'Unsupported property' })
    if (prop === 'type' && (!Array.isArray(value) || value.some(v => typeof v !== 'string'))) return res.status(400).json({ error: 'Invalid deal type' })
    if (prop === 'dl' && value !== null && (!value || typeof value.start !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value.start))) return res.status(400).json({ error: 'Invalid deadline' })
    if (['status', 'fee', 'next'].includes(prop) && typeof value !== 'string') return res.status(400).json({ error: 'Invalid value' })
    res.json({ deal: await updateDeal(req.params.id, { prop, value }) })
  } catch (error) { next(error) }
})

app.use(express.static(resolve('dist')))
app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')))
app.use((error, _req, res, _next) => res.status(error.status || 502).json({ error: error.message }))

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3001)
  app.listen(port, '127.0.0.1', () => console.log(`Collab Pipeline API: http://127.0.0.1:${port}`))
  // Keep the Notion board current while the local server is running.
  setInterval(() => { if (process.env.NOTION_TOKEN) syncFollowUps().catch(error => console.error('Follow-up sync failed:', error.message)) }, 15 * 60_000).unref()
}

export default app
