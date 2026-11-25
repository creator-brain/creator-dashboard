const statusLabels = {
  connected: 'Connected',
  disconnected: 'Not connected',
  locked: 'Locked',
  setup: 'Setup needed',
  unavailable: 'Unavailable',
}

export function IntegrationCard({ name, icon: Icon, iconStyle, description, detail, status, action, error }) {
  return <section className="rounded-2xl border border-base-300 p-4">
    <div className="flex items-start gap-3">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconStyle}`}>
        <Icon size={20} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h3 className="font-semibold">{name}</h3>
          {status
            ? <span className={`tone-chip ${status === 'connected' ? 'tone-green' : 'tone-gray'}`} role="status">{statusLabels[status]}</span>
            : <span className="loading loading-spinner loading-xs" role="status" aria-label={`Checking ${name} connection`} />}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-base-content/60">{description}</p>
        {detail && <p className="mt-2 truncate text-xs font-medium" title={detail}>{detail}</p>}
      </div>
    </div>
    {action && <div className="mt-4 flex justify-end">{action}</div>}
    {error && <p className="mt-3 text-sm text-error" role="alert">{error}</p>}
  </section>
}
