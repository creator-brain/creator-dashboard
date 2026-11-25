import { FOLLOW_UP_STATUS, isAwaitingFollowUp, normalizeInstagramHandle, sourceOf } from '../src/model.js'

export const INSTAGRAM_CONVERSATION = 'Instagram Conversation ID'

const DATA_SOURCE_ID = '8206590b-d48c-825b-ac32-07e2152ec3e1'
const BASE = 'https://api.notion.com/v1'
const VERSION = '2025-09-03'

export async function notion(path, options = {}) {
  if (!process.env.NOTION_TOKEN) {
    const error = new Error('Set NOTION_TOKEN in .env to a Notion PAT or internal connection token with access to 💌 Collab Tracker.')
    error.status = 503
    throw error
  }
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': VERSION,
      'Content-Type': 'application/json',
    },
  })
  const body = await response.json()
  if (!response.ok) {
    const error = new Error(body.message || `Notion returned ${response.status}`)
    error.status = response.status
    throw error
  }
  return body
}

const plain = value => (value || []).map(part => part.plain_text ?? part.text?.content ?? '').join('')
const property = (page, name) => page.properties?.[name] || {}
const text = (page, name) => {
  const value = property(page, name)
  return plain(value.title || value.rich_text)
}
const multi = (page, name) => (property(page, name).multi_select || []).map(item => item.name)

const savedInstagramValue = page => text(page, INSTAGRAM_CONVERSATION).trim()
const misplacedInstagramHandle = page => savedInstagramValue(page).match(/^@([\w.]{1,30})$/)?.[1] || ''
export const instagramConversationId = page => misplacedInstagramHandle(page) ? '' : savedInstagramValue(page)
export function instagramContactHandle(page) {
  const contact = property(page, 'Contact')
  const value = (text(page, 'Contact') || contact.url || contact.email || '').trim()
  const handle = value.match(/^@?([\w.]{1,30})$/)?.[1]
    || value.match(/^https:\/\/(?:www\.)?instagram\.com\/([\w.]{1,30})\/?(?:[?#].*)?$/i)?.[1]
    || text(page, 'Instagram Handle').trim().match(/^@?([\w.]{1,30})$/)?.[1]
  return handle ? normalizeInstagramHandle(handle) : ''
}
export const instagramLinkHandle = page => instagramContactHandle(page) || normalizeInstagramHandle(misplacedInstagramHandle(page))

export function toDeal(page) {
  const date = property(page, 'Deadline').date || {}
  return {
    id: page.id,
    url: page.url,
    brand: text(page, 'Brand').replace(/<[^>]*>/g, '') || 'Untitled',
    status: property(page, 'Status').select?.name || '',
    type: multi(page, 'Deal Type'),
    platforms: multi(page, 'Platforms'),
    agency: text(page, 'Agency / Platform'),
    product: text(page, 'Product'),
    fee: text(page, 'Fee'),
    next: text(page, 'Next Step'),
    deadlineStart: date.start || '',
    deadlineEnd: date.end || '',
    last: property(page, 'Last Activity').date?.start?.slice(0, 10) || '',
    edited: property(page, 'Last Edited').last_edited_time || page.last_edited_time || '',
    gmail: property(page, 'Gmail Thread').url || '',
    instagramLinked: Boolean(instagramConversationId(page)),
  }
}

async function* trackerPages(filter) {
  let cursor
  do {
    const data = await notion(`/data_sources/${DATA_SOURCE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}), ...(filter ? { filter } : {}) }),
    })
    yield* data.results
    cursor = data.has_more ? data.next_cursor : null
  } while (cursor)
}

export async function listDeals() {
  const deals = []
  for await (const page of trackerPages()) deals.push(toDeal(page))
  return deals
}

export async function unlinkedInstagramDeals() {
  const schema = await notion(`/data_sources/${DATA_SOURCE_ID}`)
  if (schema.properties?.[INSTAGRAM_CONVERSATION]?.type !== 'rich_text') {
    throw Object.assign(new Error(`Add a Text property called ${INSTAGRAM_CONVERSATION} to the Notion tracker.`), { status: 409 })
  }
  const pending = []
  const filter = { or: [
    { property: INSTAGRAM_CONVERSATION, rich_text: { is_empty: true } },
    { property: INSTAGRAM_CONVERSATION, rich_text: { starts_with: '@' } },
  ] }
  for await (const page of trackerPages(filter)) {
    if (sourceOf(toDeal(page)) !== 'Instagram' || instagramConversationId(page)) continue
    const handle = instagramLinkHandle(page)
    if (handle) pending.push({ id: page.id, handle })
  }
  return pending
}

export async function reconcileFollowUps(now = Date.now()) {
  const deals = await listDeals()
  const warnings = []
  for (const [index, deal] of deals.entries()) {
    if (!isAwaitingFollowUp(deal, now)) continue
    try {
      // A page may have changed since the data source query. Recheck before writing.
      const page = await notion(`/pages/${deal.id}`)
      if (page.parent?.data_source_id?.replaceAll('-', '') !== DATA_SOURCE_ID.replaceAll('-', '')) {
        throw Object.assign(new Error('Page is outside the tracker'), { status: 403 })
      }
      const current = toDeal(page)
      if (!isAwaitingFollowUp(current, now)) {
        deals[index] = current
        continue
      }
      const updated = await notion(`/pages/${deal.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: updateProperties({ prop: 'status', value: FOLLOW_UP_STATUS }) }),
      })
      deals[index] = toDeal(updated)
    } catch (error) {
      warnings.push(`Could not move ${deal.brand} to Follow up: ${error.message}`)
    } finally {
      // Each candidate can cost two requests. Pace reads and writes to Notion.
      await new Promise(resolve => setTimeout(resolve, 750))
    }
  }
  return { deals, warnings }
}

const rich = value => [{ type: 'text', text: { content: String(value) } }]
const dateProperty = value => ({ date: value ? { start: value.start, ...(value.end ? { end: value.end } : {}) } : null })

export function updateProperties(change) {
  const properties = {}
  switch (change.prop) {
    case 'status': properties.Status = { select: change.value ? { name: change.value } : null }; break
    case 'type': properties['Deal Type'] = { multi_select: (change.value || []).map(name => ({ name })) }; break
    case 'fee': properties.Fee = { rich_text: change.value ? rich(change.value) : [] }; break
    case 'next': properties['Next Step'] = { rich_text: change.value ? rich(change.value) : [] }; break
    case 'dl': properties.Deadline = dateProperty(change.value); break
    case 'gmail': properties['Gmail Thread'] = { url: change.value }; break
    case 'instagram': properties[INSTAGRAM_CONVERSATION] = { rich_text: change.value ? rich(change.value) : [] }; break
    case 'activity': properties['Last Activity'] = dateProperty({ start: change.value }); break
    default: throw Object.assign(new Error('Unsupported property'), { status: 400 })
  }
  return properties
}

export async function updateDeal(id, change) {
  const page = await notion(`/pages/${id}`)
  if (page.parent?.data_source_id?.replaceAll('-', '') !== DATA_SOURCE_ID.replaceAll('-', '')) {
    throw Object.assign(new Error('This page is outside the Collab Tracker data source.'), { status: 403 })
  }
  if (change.instagramHandle) {
    const current = toDeal(page)
    if (current.instagramLinked || sourceOf(current) !== 'Instagram' || instagramLinkHandle(page) !== change.instagramHandle) return current
  }
  const properties = updateProperties(change)
  if (change.activityDate) {
    const previous = property(page, 'Last Activity').date?.start?.slice(0, 10) || ''
    if (change.activityDate > previous) properties['Last Activity'] = dateProperty({ start: change.activityDate })
  }
  return toDeal(await notion(`/pages/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  }))
}

export async function getBlocks(id) {
  const output = []
  let cursor
  do {
    const params = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) })
    const data = await notion(`/blocks/${id}/children?${params}`)
    output.push(...data.results)
    cursor = data.has_more ? data.next_cursor : null
  } while (cursor)
  return output
}

function blockText(block) {
  return plain(block[block.type]?.rich_text || block.child_page?.title && [{ plain_text: block.child_page.title }])
}

export async function pageMarkdown(id, depth = 0) {
  if (depth > 3) return ''
  const blocks = await getBlocks(id)
  const lines = []
  for (const block of blocks) {
    const value = blockText(block)
    const prefix = {
      heading_1: '# ', heading_2: '## ', heading_3: '### ',
      bulleted_list_item: '- ', numbered_list_item: '1. ',
      quote: '> ', to_do: block.to_do?.checked ? '- [x] ' : '- [ ] ',
      code: '```\n',
    }[block.type] || ''
    if (block.type === 'divider') lines.push('---')
    else if (block.type === 'code') lines.push(`${prefix}${value}\n\x60\x60\x60`)
    else if (['image', 'file', 'pdf', 'video', 'audio'].includes(block.type)) lines.push(`📎 ${plain(block[block.type]?.caption) || block[block.type]?.name || block.type} (open in Notion to view)`)
    else if (block.type === 'table_row') lines.push(`| ${(block.table_row?.cells || []).map(plain).join(' | ')} |`)
    else if (value) lines.push(prefix + value)
    if (block.has_children) lines.push(await pageMarkdown(block.id, depth + 1))
  }
  return lines.join('\n\n')
}

export { DATA_SOURCE_ID }
