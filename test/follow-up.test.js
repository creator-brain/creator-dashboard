import test from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_GROUPS, FOLLOW_UP, FOLLOW_UP_STATUS, inGroup, isAwaitingFollowUp, LIVE_GROUPS } from '../src/model.js'
import { reconcileFollowUps } from '../server/notion.js'

const now = Date.parse('2026-11-24T12:00:00+08:00')
const awaiting = edited => ({ status: 'Awaiting brand', edited })

test('marks an Awaiting brand deal eligible at exactly 14 days', () => {
  assert.equal(isAwaitingFollowUp(awaiting('2026-11-10T12:00:01+08:00'), now), false)
  assert.equal(isAwaitingFollowUp(awaiting('2026-11-10T12:00:00+08:00'), now), true)
  assert.equal(isAwaitingFollowUp(awaiting(''), now), false)
  assert.equal(isAwaitingFollowUp({ status: 'Action needed', edited: '2026-10-01T00:00:00+08:00' }, now), false)
})

test('Follow up is a real status group on both boards', () => {
  assert.equal(FOLLOW_UP.key, FOLLOW_UP_STATUS)
  assert.equal(inGroup(FOLLOW_UP, { status: FOLLOW_UP_STATUS }), true)
  assert.equal(inGroup(BOARD_GROUPS.find(group => group.key === 'Awaiting brand'), { status: FOLLOW_UP_STATUS }), false)
  assert.equal(LIVE_GROUPS.some(group => group.key === FOLLOW_UP_STATUS), true)
})

test('rechecks Notion then writes Status and Last Activity for an eligible deal', async () => {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.NOTION_TOKEN
  const calls = []
  process.env.NOTION_TOKEN = 'test-token'
  const page = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    url: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parent: { data_source_id: '8206590b-d48c-825b-ac32-07e2152ec3e1' },
    last_edited_time: '2026-11-01T00:00:00+08:00',
    properties: { Brand: { title: [{ plain_text: 'Sample brand' }] }, Status: { select: { name: 'Awaiting brand' } } },
  }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) })
    const result = calls.length === 1 ? { results: [page], has_more: false } : calls.length === 2 ? page : { ...page, last_edited_time: '2026-11-24T04:00:00Z', properties: { ...page.properties, Status: { select: { name: FOLLOW_UP_STATUS } } } }
    return { ok: true, json: async () => result }
  }
  try {
    const result = await reconcileFollowUps(now)
    assert.equal(result.deals[0].status, FOLLOW_UP_STATUS)
    assert.deepEqual(result.warnings, [])
    assert.equal(calls[2].method, 'PATCH')
    assert.deepEqual(calls[2].body.properties.Status, { select: { name: FOLLOW_UP_STATUS } })
    assert.equal(calls[2].body.properties['Last Activity'].date.start, '2026-11-24')
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.NOTION_TOKEN
    else process.env.NOTION_TOKEN = originalToken
  }
})

test('does not write when the page was edited after the query', async () => {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.NOTION_TOKEN
  let calls = 0
  process.env.NOTION_TOKEN = 'test-token'
  const page = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    url: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parent: { data_source_id: '8206590b-d48c-825b-ac32-07e2152ec3e1' },
    properties: { Brand: { title: [{ plain_text: 'Sample brand' }] }, Status: { select: { name: 'Awaiting brand' } } },
  }
  globalThis.fetch = async () => {
    calls++
    return { ok: true, json: async () => calls === 1 ? { results: [{ ...page, last_edited_time: '2026-11-01T00:00:00+08:00' }], has_more: false } : { ...page, last_edited_time: '2026-11-24T03:00:00+08:00' } }
  }
  try {
    const result = await reconcileFollowUps(now)
    assert.equal(result.deals[0].status, 'Awaiting brand')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.NOTION_TOKEN
    else process.env.NOTION_TOKEN = originalToken
  }
})

test('keeps Awaiting brand when Notion rejects the status update', async () => {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.NOTION_TOKEN
  let calls = 0
  process.env.NOTION_TOKEN = 'test-token'
  const page = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    url: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parent: { data_source_id: '8206590b-d48c-825b-ac32-07e2152ec3e1' },
    last_edited_time: '2026-11-01T00:00:00+08:00',
    properties: { Brand: { title: [{ plain_text: 'Sample brand' }] }, Status: { select: { name: 'Awaiting brand' } } },
  }
  globalThis.fetch = async () => {
    calls++
    return calls === 3 ? { ok: false, status: 400, json: async () => ({ message: 'Cannot add status option' }) } : { ok: true, json: async () => calls === 1 ? { results: [page], has_more: false } : page }
  }
  try {
    const result = await reconcileFollowUps(now)
    assert.equal(result.deals[0].status, 'Awaiting brand')
    assert.match(result.warnings[0], /Cannot add status option/)
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.NOTION_TOKEN
    else process.env.NOTION_TOKEN = originalToken
  }
})
