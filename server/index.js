import express from 'express'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DATA_SOURCE_ID, INSTAGRAM_CONVERSATION, instagramContactHandle, instagramConversationId, notion, pageMarkdown, reconcileFollowUps, toDeal, unlinkedInstagramDeals, updateDeal } from './notion.js'
import { normalizeInstagramHandle, sourceOf } from '../src/model.js'
import { instagramAuthorize, instagramCallback, instagramConfigured, instagramConversation, instagramConversations, instagramDisconnect, instagramSession, validConversationId } from './instagram.js'
import { gmailAuthorize, gmailCallback, gmailConfigured, gmailConnected, gmailDisconnect, gmailRequest, gmailThreadUrl, makeMessage, replyDetails, summarizeThread, threadIdFromUrl } from './gmail.js'
import { validWebhookSignature, webhookChallenge } from './metaWebhook.js'

try {
  const env = readFileSync(resolve('.env'), 'utf8')
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
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
app.get('/api/meta/auth/start', instagramAuthorize)
app.get('/api/meta/auth/callback', instagramCallback)
app.get('/api/meta/status', async (req, res) => {
  const session = await instagramSession(req)
  res.json({ configured: instagramConfigured(), connected: Boolean(session), username: session?.account.username || '' })
})
app.post('/api/meta/disconnect', sameSiteWrite, instagramDisconnect)

async function requireInstagramSession(req, res, next) {
  const session = await instagramSession(req)
  if (!session) return res.status(401).json({ error: 'Connect Instagram in Integrations first.' })
  res.locals.instagram = session
  next()
}

app.get('/api/meta/conversations', requireInstagramSession, async (req, res) => {
  const { after } = req.query
  if (after !== undefined && (typeof after !== 'string' || after.length > 2048)) return res.status(400).json({ error: 'Invalid Instagram cursor.' })
  res.json(await instagramConversations(res.locals.instagram, after))
})

app.get('/api/meta/pending-links', async (req, res) => {
  const session = await instagramSession(req)
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
  res.locals.contactHandle = instagramContactHandle(page)
  next()
}

app.get('/api/meta/deals/:id', requireInstagramSession, instagramDeal, async (_req, res) => {
  const { instagram, conversationId } = res.locals
  res.json({ conversation: conversationId ? await instagramConversation(instagram, conversationId) : null })
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
async function linkedThread(req) {
  if (!/^[\da-f-]{32,36}$/i.test(req.params.id)) throw Object.assign(new Error('Invalid page ID.'), { status: 400 })
  const page = await notion(`/pages/${req.params.id}`)
  if (page.parent?.data_source_id?.replaceAll('-', '') !== DATA_SOURCE_ID.replaceAll('-', '')) throw Object.assign(new Error('Page is outside the tracker.'), { status: 403 })
  const url = page.properties?.['Gmail Thread']?.url || ''
  const threadId = threadIdFromUrl(url)
  if (url && !threadId) throw Object.assign(new Error('This Notion Gmail Thread link cannot be opened through the Gmail API.'), { status: 400 })
  return threadId
}
app.get('/api/deals/:id/gmail', async (req, res, next) => {
  try {
    const threadId = await linkedThread(req)
    const thread = threadId ? summarizeThread(await gmailRequest(req, `/threads/${encodeURIComponent(threadId)}?format=full`)) : null
    const profile = thread ? await gmailRequest(req, '/profile') : null
    res.json({ thread, reply: thread ? replyDetails(thread, profile.emailAddress) : null })
  } catch (error) { next(error) }
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
