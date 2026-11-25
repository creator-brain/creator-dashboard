import { createHmac, timingSafeEqual } from 'node:crypto'

function equal(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && timingSafeEqual(left, right)
}

export function webhookChallenge(query, verifyToken) {
  if (!verifyToken || query?.['hub.mode'] !== 'subscribe' || !equal(query?.['hub.verify_token'], verifyToken)) return null
  const challenge = query?.['hub.challenge']
  return typeof challenge === 'string' ? challenge : null
}

export function validWebhookSignature(rawBody, header, appSecret) {
  if (!appSecret || !Buffer.isBuffer(rawBody) || !/^sha256=[a-f\d]{64}$/i.test(header || '')) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex')
  return equal(header.slice(7).toLowerCase(), expected)
}
