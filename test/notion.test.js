import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationHas, listDeals, recordHas, toDeal, updateDeal, updateProperties } from '../server/notion.js'

const page = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  url: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  last_edited_time: '2026-11-24T02:00:00.000Z',
  properties: {
    Brand: { title: [{ plain_text: '<b>Acme</b>' }] },
    Status: { select: { name: 'Action needed' } },
    'Deal Type': { multi_select: [{ name: 'Paid' }, { name: 'UGC' }] },
    Platforms: { multi_select: [{ name: 'TikTok' }] },
    'Agency / Platform': { rich_text: [{ plain_text: 'Agency' }] },
    Fee: { rich_text: [{ plain_text: '$500' }] },
    'Next Step': { rich_text: [{ plain_text: 'Send draft' }] },
    Deadline: { date: { start: '2026-12-01' } },
    'Last Activity': { date: { start: '2026-11-24' } },
    'Gmail Thread': { url: 'https://mail.google.com/thread' },
  },
}

test('maps Notion properties to a safe deal model', () => {
  const deal = toDeal(page)
  assert.equal(deal.brand, 'Acme')
  assert.deepEqual(deal.type, ['Paid', 'UGC'])
  assert.equal(deal.deadlineStart, '2026-12-01')
  assert.equal(deal.gmail, 'https://mail.google.com/thread')
})

test('builds Notion updates without changing conversation activity for metadata edits', () => {
  const result = updateProperties({ prop: 'dl', value: { start: '2026-12-01T10:00:00+08:00', end: '2026-12-01T11:00:00+08:00' } })
  assert.deepEqual(result.Deadline.date, { start: '2026-12-01T10:00:00+08:00', end: '2026-12-01T11:00:00+08:00' })
  assert.equal(result['Last Activity'], undefined)
  assert.deepEqual(updateProperties({ prop: 'type', value: [] })['Deal Type'], { multi_select: [] })
  assert.deepEqual(updateProperties({ prop: 'gmail', value: 'https://mail.google.com/mail/u/0/#all/18c9b10f0a123456' })['Gmail Thread'], { url: 'https://mail.google.com/mail/u/0/#all/18c9b10f0a123456' })
  assert.deepEqual(updateProperties({ prop: 'activity', value: '2026-11-24' })['Last Activity'], { date: { start: '2026-11-24' } })
})

test('paginates the configured data source without storing rows', async () => {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.NOTION_TOKEN
  const bodies = []
  process.env.NOTION_TOKEN = 'test-token'
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    bodies.push(body)
    return { ok: true, json: async () => bodies.length === 1 ? { results: [page], has_more: true, next_cursor: 'next' } : { results: [page], has_more: false } }
  }
  try {
    const deals = await listDeals()
    assert.equal(deals.length, 2)
    assert.equal(bodies[1].start_cursor, 'next')
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.NOTION_TOKEN
    else process.env.NOTION_TOKEN = originalToken
  }
})

test('refuses writes to a page outside the tracker', async () => {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.NOTION_TOKEN
  let calls = 0
  process.env.NOTION_TOKEN = 'test-token'
  globalThis.fetch = async () => {
    calls++
    return { ok: true, json: async () => ({ ...page, parent: { data_source_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } }) }
  }
  try {
    await assert.rejects(updateDeal(page.id, { prop: 'status', value: 'Completed' }, '2026-11-24'), /outside the Collab Tracker/)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.NOTION_TOKEN
    else process.env.NOTION_TOKEN = originalToken
  }
})

test('records Has only when the conversation contents change, without touching Last Activity', async () => {
  assert.deepEqual(toDeal(page).has, [])
  assert.deepEqual(toDeal({ ...page, properties: { ...page.properties, Has: { multi_select: [{ name: 'Links' }] } } }).has, ['Links'])
  assert.deepEqual(conversationHas({ attachments: true, links: true }), ['Attachments', 'Links'])
  assert.deepEqual(conversationHas({ attachments: false, links: true }), ['Links'])
  assert.deepEqual(updateProperties({ prop: 'has', value: ['Attachments'] }), { Has: { multi_select: [{ name: 'Attachments' }] } })

  const originalFetch = globalThis.fetch
  const originalToken = process.env.NOTION_TOKEN
  process.env.NOTION_TOKEN = 'test-token'
  const writes = []
  const tracked = { ...page, parent: { data_source_id: '8206590b-d48c-825b-ac32-07e2152ec3e1' } }
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'PATCH') writes.push(JSON.parse(options.body).properties)
    return { ok: true, json: async () => tracked }
  }
  try {
    assert.equal(await recordHas({ ...toDeal(tracked), has: ['Links'] }, ['Links']), null)
    assert.equal(writes.length, 0)
    assert.ok(await recordHas(toDeal(tracked), ['Attachments', 'Links']))
    assert.deepEqual(writes, [{ Has: { multi_select: [{ name: 'Attachments' }, { name: 'Links' }] } }])
    globalThis.fetch = async () => { throw new Error('network down') }
    assert.equal(await recordHas(toDeal(tracked), ['Links']), null)
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.NOTION_TOKEN
    else process.env.NOTION_TOKEN = originalToken
  }
})
