import { Fragment } from 'react'
import { inlineMessageLinks } from './messageLinks.js'

export function MessageText({ text }) {
  const body = text || ''
  const inline = inlineMessageLinks(body)
  let offset = 0

  return body && (
    <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">
      {inline.map(({ index, lastIndex, url, text: label }) => {
        const before = body.slice(offset, index)
        offset = lastIndex
        return <Fragment key={index}>{before}<a className="link link-primary wrap-anywhere"
          href={url} target="_blank" rel="noopener noreferrer">{label}</a></Fragment>
      })}
      {body.slice(offset)}
    </p>
  )
}
