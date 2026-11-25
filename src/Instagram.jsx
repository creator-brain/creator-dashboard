import { useEffect, useRef, useState } from 'react'
import { Instagram } from 'lucide-react'
import { api, normalizeInstagramHandle } from './model.js'

function useInstagramStatus() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api('/meta/status', { signal: controller.signal }).then(setStatus).catch(reason => {
      if (!controller.signal.aborted) setError(reason.message)
    })
    return () => controller.abort()
  }, [])
  return { status, setStatus, error, setError }
}

function ConnectInstagram() {
  return <a className="btn btn-primary btn-sm" href="/api/meta/auth/start">Connect Instagram</a>
}

const loginMessages = {
  cancelled: 'Instagram connection was cancelled.',
  account: 'Select the Instagram professional account configured for this dashboard.',
  storage: 'Instagram session storage is unavailable. Try connecting again.',
  failed: 'Instagram could not complete the connection. Check the Meta app configuration and try again.',
}

export function InstagramIntegration({ loginResult }) {
  const { status, setStatus, error, setError } = useInstagramStatus()
  const [busy, setBusy] = useState(false)
  async function disconnect() {
    setBusy(true)
    setError('')
    try {
      await api('/meta/disconnect', { method: 'POST' })
      setStatus(previous => ({ ...previous, connected: false, username: '' }))
    } catch (reason) { setError(reason.message) }
    finally { setBusy(false) }
  }
  return <section className="space-y-3 rounded-2xl border border-base-300 p-4">
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-purple-100 text-purple-700"><Instagram size={20} /></span>
      <div><h3 className="font-semibold">Instagram</h3><p className="text-xs text-base-content/60">{status?.connected ? `Connected as @${status.username}` : 'Read DMs from linked deals.'}</p></div>
    </div>
    {status?.connected ? <button className="btn btn-outline btn-sm" disabled={busy} onClick={disconnect}>Disconnect Instagram</button>
      : status?.configured ? <ConnectInstagram />
      : status ? <p className="text-xs text-base-content/60">Instagram server setup is needed.</p> : null}
    {error && <p className="text-sm text-error" role="alert">{error}</p>}
    {loginMessages[loginResult] && <p className="text-sm text-base-content/75" role="status">{loginMessages[loginResult]}</p>}
  </section>
}

const messageDate = date => date && Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleString('en-SG', {
  timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short',
}) : ''
const matchingConversations = (conversations, handle) => conversations.filter(item => normalizeInstagramHandle(item.username) === handle)
const mergeConversations = (existing, incoming) => [...new Map([...existing, ...incoming].map(item => [item.id, item])).values()]
const conversationPage = (after, signal) => api(`/meta/conversations${after ? `?${new URLSearchParams({ after })}` : ''}`, { signal })

export async function syncInstagramLinks(onLinked) {
  const { pending } = await api('/meta/pending-links')
  if (!pending.length) return
  const handles = new Map(pending.map(({ handle }) => [handle, new Set()]))
  const seenCursors = new Set()
  const pause = () => new Promise(resolve => setTimeout(resolve, 600))
  let after = ''
  do {
    if (seenCursors.has(after)) throw new Error('Instagram returned a repeated inbox page. Refresh to try again.')
    seenCursors.add(after)
    if (after) await pause()
    const page = await conversationPage(after)
    for (const { id, username } of page.conversations) handles.get(normalizeInstagramHandle(username))?.add(id)
    after = page.after
  } while (after)

  let failures = 0
  for (const { id, handle } of pending) {
    const matches = handles.get(handle)
    if (matches.size !== 1) continue
    const [conversationId] = matches
    await pause()
    try {
      const { deal } = await api(`/meta/deals/${id}/auto-link`, { method: 'POST', body: JSON.stringify({ conversationId }) })
      if (deal?.instagramLinked) onLinked(deal)
    } catch { failures++ }
  }
  if (failures) throw new Error(`Couldn’t link ${failures} Instagram deal${failures === 1 ? '' : 's'}. Refresh to try again.`)
}

export function InstagramPanel({ deal, onLinked }) {
  const { status, error: statusError } = useInstagramStatus()
  const [conversation, setConversation] = useState(undefined)
  const [choices, setChoices] = useState(null)
  const [selected, setSelected] = useState('')
  const [handle, setHandle] = useState('')
  const [searchedHandle, setSearchedHandle] = useState('')
  const searchRequest = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const path = `/meta/deals/${deal.id}`
  useEffect(() => () => searchRequest.current?.abort(), [])
  useEffect(() => {
    if (!status?.connected) return
    const controller = new AbortController()
    api(path, { signal: controller.signal }).then(result => setConversation(result.conversation)).catch(reason => {
      if (!controller.signal.aborted) setError(reason.message)
    })
    return () => controller.abort()
  }, [path, status?.connected, deal.instagramLinked])

  async function run(action) {
    setBusy(true)
    setError('')
    try { await action() }
    catch (reason) { setError(reason.message) }
    finally { setBusy(false) }
  }
  function loadChoices(after) {
    return run(async () => {
      const result = await conversationPage(after)
      setChoices(previous => ({ ...result, conversations: mergeConversations(after ? previous.conversations : [], result.conversations) }))
    })
  }
  function searchByHandle(event) {
    event.preventDefault()
    const username = normalizeInstagramHandle(handle)
    if (!/^[a-z0-9._]{1,30}$/.test(username)) {
      setError('Enter an Instagram username, such as @brand.')
      return
    }
    setSearchedHandle(username)
    setSelected('')
    return run(async () => {
      const controller = new AbortController()
      searchRequest.current = controller
      let page = choices
      let matches = matchingConversations(page.conversations, username)
      // Search a few pages at a time so a large inbox doesn't keep the picker busy indefinitely.
      for (let count = 0; !matches.length && page.after && count < 5; count++) {
        if (count) await new Promise(resolve => setTimeout(resolve, 600))
        if (controller.signal.aborted) return
        const result = await conversationPage(page.after, controller.signal)
        page = { ...result, after: result.after === page.after ? '' : result.after,
          conversations: mergeConversations(page.conversations, result.conversations) }
        setChoices(page)
        matches = matchingConversations(page.conversations, username)
      }
      if (matches.length === 1) setSelected(matches[0].id)
    })
  }
  function clearSearch() {
    setHandle('')
    setSearchedHandle('')
    setSelected('')
    setError('')
  }
  function link(event) {
    event.preventDefault()
    return run(async () => {
      const result = await api(`${path}/link`, { method: 'POST', body: JSON.stringify({ conversationId: selected }) })
      setConversation(result.conversation)
      setChoices(null)
      clearSearch()
      onLinked(result.deal)
    })
  }
  function refresh() {
    return run(async () => setConversation((await api(path)).conversation))
  }
  const visibleChoices = !choices ? [] : searchedHandle ? matchingConversations(choices.conversations, searchedHandle) : choices.conversations
  return <section className="space-y-3">
    <h3 className="section-title">Instagram conversation</h3>
    {(error || statusError) && <p className="text-sm text-error" role="alert">{error || statusError}</p>}
    {status && !status.configured && <p className="text-sm text-base-content/60">Instagram server setup is needed.</p>}
    {status?.configured && !status.connected && <ConnectInstagram />}
    {status?.connected && conversation === undefined && (error
      ? <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={refresh}>Try again</button>
      : <span className="loading loading-spinner loading-sm" aria-label="Loading Instagram conversation" />)}
    {conversation !== undefined && !choices && <div className="flex flex-wrap gap-2">
      <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={() => loadChoices()}>{conversation ? 'Change conversation' : 'Choose conversation'}</button>
      {conversation && <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={refresh}>Refresh messages</button>}
    </div>}
    {choices && <div className="space-y-3">
      <form className="space-y-2" onSubmit={searchByHandle}>
        <label className="block text-xs">Brand or agency Instagram handle
          <input className="input input-bordered mt-1 w-full" value={handle} placeholder="@brand" disabled={busy}
            onChange={event => { setHandle(event.target.value); setSearchedHandle(''); setSelected(''); setError('') }} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-outline btn-sm" disabled={busy || !handle.trim()} type="submit">{busy && searchedHandle ? 'Searching…' : searchedHandle && !visibleChoices.length && choices.after ? 'Search more' : 'Find conversation'}</button>
          {searchedHandle && <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={clearSearch}>Show all</button>}
        </div>
      </form>
      <form className="space-y-2" onSubmit={link}>
      {visibleChoices.length ? <label className="block text-xs">Conversation participant
        <select className="select select-bordered mt-1 w-full" value={selected} onChange={event => setSelected(event.target.value)}>
          <option value="">Choose the brand or agency account</option>
          {visibleChoices.map(item => <option key={item.id} value={item.id}>{item.username ? `@${item.username}` : `Conversation ${item.id.slice(-10)}`} · {messageDate(item.updatedAt)}</option>)}
        </select>
      </label> : !busy && <p className="text-sm text-base-content/60" role="status">{searchedHandle ? `No match for @${searchedHandle}${choices.after ? ' in the conversations checked so far' : ''}.` : 'No conversations found.'}</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !selected}>Save to Notion</button>
        {choices.after && !searchedHandle && <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={() => loadChoices(choices.after)}>Load more</button>}
        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => { setChoices(null); clearSearch() }}>Cancel</button>
      </div>
      </form>
    </div>}
    {conversation && <>
      {conversation.username && <p className="text-sm font-medium">@{conversation.username}</p>}
      {!conversation.messages.length && <p className="text-sm text-base-content/60">No recent messages returned by Instagram.</p>}
      {conversation.messages.map((message, index) => <details key={`${conversation.id}:${message.id}`} open={index === 0} className="rounded-xl border border-base-300 p-3">
        <summary className="cursor-pointer text-sm font-medium">{message.outgoing ? 'You' : message.sender ? `@${message.sender}` : 'Instagram'} <time className="ml-1 text-xs font-normal opacity-65">{messageDate(message.date)}</time></summary>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm">{message.text || 'No message text. View media or shares in Instagram.'}</p>
      </details>)}
    </>}
  </section>
}
