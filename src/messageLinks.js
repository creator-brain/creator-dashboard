import LinkifyIt from 'linkify-it'

const linkify = new LinkifyIt().set({ fuzzyEmail: false })

export function messageUrl(value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

export function inlineMessageLinks(text) {
  return (linkify.match(text || '') || []).flatMap(match => {
    const url = messageUrl(match.url)
    return url ? [{ ...match, url }] : []
  })
}

export function threadMessageLinks(messages) {
  const links = new Map()
  for (const message of messages) {
    for (const link of message.links || []) {
      const url = messageUrl(link.url)
      const label = link.label?.trim()
      if (url && label && !links.has(url)) links.set(url, { url, label })
    }
  }
  for (const message of messages) {
    for (const { url, text: label } of inlineMessageLinks(message.body ?? message.text)) {
      if (!links.has(url)) links.set(url, { url, label })
    }
  }
  return [...links.values()]
}
