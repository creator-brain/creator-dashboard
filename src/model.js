export const STATUSES = [
  { key: 'Backlog', phase: 'Inbound', color: 'brown' },
  { key: 'New - not replied', phase: 'Inbound', color: 'red' },
  { key: 'Action needed', phase: 'Inbound', color: 'orange' },
  { key: 'Awaiting brand', phase: 'Inbound', color: 'yellow' },
  { key: 'Follow up - 14+ days', label: 'Follow up · 14+ days', phase: 'Inbound', color: 'orange' },
  { key: 'Ideas/Scripting', phase: 'Production', color: 'purple' },
  { key: 'Filming', phase: 'Production', color: 'gray' },
  { key: 'Editing', phase: 'Production', color: 'blue' },
  { key: 'Draft sent/Scheduled', phase: 'Production', color: 'orange' },
  { key: 'Completed - payment pending', phase: 'Wrap-up', color: 'pink' },
  { key: 'Completed', phase: 'Archive', color: 'green' },
  { key: 'Missed/Not Interested', phase: 'Archive', color: 'gray' },
]
export const FOLLOW_UP_DAYS = 14
export const FOLLOW_UP_STATUS = 'Follow up - 14+ days'
export const FOLLOW_UP = STATUSES.find(group => group.key === FOLLOW_UP_STATUS)
export const BOARD_GROUPS = STATUSES
export const LIVE_GROUPS = [
  ...STATUSES.slice(1, 5),
  { key: 'Backlog', label: 'Stream booked', phase: 'Scheduled', color: 'blue', statuses: ['Backlog', 'Ideas/Scripting', 'Filming', 'Editing', 'Draft sent/Scheduled'] },
  { key: 'Completed - payment pending', label: 'Streamed – payment pending', phase: 'Wrap-up', color: 'pink' },
  { key: 'Completed', label: 'Streamed', phase: 'Archive', color: 'green' },
  STATUSES.at(-1),
]
export const TYPES = ['Paid', 'Gifted', 'TikTok Shop affiliate', 'UGC', 'Livestream', 'Other', 'Scam']
export const TYPE_COLORS = { Paid: 'green', Gifted: 'blue', 'TikTok Shop affiliate': 'orange', UGC: 'purple', Livestream: 'pink', Other: 'gray', Scam: 'yellow' }
export const PLATFORMS = ['TikTok', 'Instagram', 'Live', 'Shopee']
export const SOURCES = ['Email', 'Instagram', 'WhatsApp', 'Unknown']
export const SOURCE_COLORS = { Email: 'blue', Instagram: 'pink', WhatsApp: 'green', Unknown: 'gray' }
export const CLOSED = new Set(['Completed', 'Missed/Not Interested'])
export const activityTime = deal => deal.last ? new Date(`${datePart(deal.last)}T00:00:00+08:00`).getTime() : deal.edited ? new Date(deal.edited).getTime() : NaN
export const isAwaitingFollowUp = (deal, now = Date.now()) => deal.status === 'Awaiting brand' && Number.isFinite(activityTime(deal)) && now - activityTime(deal) >= FOLLOW_UP_DAYS * 864e5
export const inGroup = (group, deal) => (group.statuses || [group.key]).includes(deal.status)
export const isLive = deal => deal.type.includes('Livestream') || deal.platforms.includes('Live') || /\blive\b|livestream|\bstreams?\b/i.test(`${deal.brand} ${deal.agency}`)
export const sourceOf = deal => deal.gmail ? 'Email' : /whatsapp/i.test(deal.agency) ? 'WhatsApp' : /instagram/i.test(deal.agency) ? 'Instagram' : 'Unknown'
export const normalizeInstagramHandle = value => value.trim().replace(/^@/, '').toLowerCase()
export const INSTAGRAM_REPLY_LIMIT = 1000
export const INSTAGRAM_MESSAGE_LIMIT = 10
export const datePart = value => value?.slice(0, 10) || ''
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' })
export const dayDiff = value => Math.round((new Date(`${datePart(value)}T00:00:00+08:00`) - new Date(`${today()}T00:00:00+08:00`)) / 864e5)
export const isOverdue = deal => deal.deadlineStart && dayDiff(deal.deadlineStart) < 0 && !CLOSED.has(deal.status)
export const isSoon = deal => deal.deadlineStart && dayDiff(deal.deadlineStart) >= 0 && dayDiff(deal.deadlineStart) <= 7 && !CLOSED.has(deal.status)
export const isStale = deal => deal.status === FOLLOW_UP_STATUS || !CLOSED.has(deal.status) && deal.status !== 'Completed - payment pending' && Number.isFinite(activityTime(deal)) && Date.now() - activityTime(deal) >= FOLLOW_UP_DAYS * 864e5
export const formatDate = value => value ? new Date(`${datePart(value)}T00:00:00+08:00`).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', timeZone: 'Asia/Singapore' }) : ''
export const formatTime = value => value && value.includes('T') ? new Date(value).toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Singapore' }) : ''
export const age = value => {
  if (!value) return 'Not edited yet'
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000)
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`
}
export const sortDeals = (deals, sort) => [...deals].sort((a, b) => {
  if (sort === 'brand') return a.brand.localeCompare(b.brand, undefined, { sensitivity: 'base' })
  if (sort === 'deadline') return (a.deadlineStart || '9999').localeCompare(b.deadlineStart || '9999') || (b.last || '').localeCompare(a.last || '')
  return (b[sort] || '').localeCompare(a[sort] || '') || (b.edited || '').localeCompare(a.edited || '')
})
export function searchDeals(deals, query) {
  const term = query.trim().toLocaleLowerCase()
  if (!term) return []
  const rank = deal => {
    const brand = deal.brand.toLocaleLowerCase()
    if (brand === term) return 0
    if (brand.startsWith(term)) return 1
    if (brand.includes(term)) return 2
    const other = [deal.agency, deal.product, deal.next, deal.fee, deal.status, deal.source, ...(deal.type || []), ...(deal.platforms || [])].join(' ').toLocaleLowerCase()
    return other.includes(term) ? 3 : -1
  }
  return deals.map(deal => ({ deal, rank: rank(deal) })).filter(item => item.rank >= 0).sort((a, b) => a.rank - b.rank || a.deal.brand.localeCompare(b.deal.brand, undefined, { sensitivity: 'base' })).map(item => item.deal)
}
export const toDateInput = value => datePart(value)
export const toTimeInput = value => value?.includes('T') ? new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Singapore' }) : ''
export const deadlineValue = (date, start, end) => !date ? null : !start ? { start: date } : { start: `${date}T${start}:00+08:00`, ...(end ? { end: `${date}T${end}:00+08:00` } : {}) }

export async function api(path, options) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}
