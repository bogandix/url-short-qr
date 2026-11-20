import { useState } from 'preact/hooks'
import { api } from './api'
import { Card, ErrorBox, useAsync } from './ui'

type Key = { id: string; name: string; scopes: string[]; owner_prefix: string | null; namespaces: string[] | null; created_at: string; last_used_at: string | null; revoked_at: string | null }
const SCOPES = ['links:read', 'links:write', 'stats:read', 'domains:admin', 'keys:admin'] as const

/** API keys for client services, e.g. vrumvrum: scope to links + stats, owner prefix "vrumvrum:". */
export function Keys() {
  const list = useAsync(() => api<{ items: Key[] }>('/keys'), [])
  const [v, setV] = useState({ name: '', owner_prefix: '', namespaces: '', scopes: ['links:read', 'links:write', 'stats:read'] as string[] })
  const [created, setCreated] = useState<string>()
  const [err, setErr] = useState<Error>()
  const create = async (e: Event) => {
    e.preventDefault()
    setErr(undefined)
    try {
      const r = await api<{ key: string }>('/keys', {
        method: 'POST',
        json: {
          name: v.name,
          scopes: v.scopes,
          owner_prefix: v.owner_prefix || null,
          namespaces: v.namespaces ? v.namespaces.split(',').map((s) => s.trim()).filter(Boolean) : null,
        },
      })
      setCreated(r.key)
      list.reload()
    } catch (x) {
      setErr(x as Error)
    }
  }
  const revoke = async (k: Key) => {
    if (!window.confirm(`Revoke "${k.name}"? Calls using it fail within a minute.`)) return
    await api(`/keys/${k.id}`, { method: 'DELETE' }).catch((x: Error) => setErr(x))
    list.reload()
  }
  return (
    <>
      <div class="page-head"><div><h1>API keys</h1><p>Keys for other services, e.g. vrumvrum. Limit each to an owner prefix.</p></div></div>
      <Card title="New API key">
        <form class="form-grid" onSubmit={create}>
          <label>Name<input required placeholder="vrumvrum-prod" value={v.name} onInput={(e) => setV({ ...v, name: e.currentTarget.value })} /></label>
          <label>Owner prefix (optional)<input placeholder="vrumvrum:" value={v.owner_prefix} onInput={(e) => setV({ ...v, owner_prefix: e.currentTarget.value })} /></label>
          <label>Namespaces (optional, comma-separated)<input placeholder="vv1.eu" value={v.namespaces} onInput={(e) => setV({ ...v, namespaces: e.currentTarget.value })} /></label>
          <fieldset class="span-all row">
            {SCOPES.map((s) => (
              <label key={s} class="check">
                <input type="checkbox" checked={v.scopes.includes(s)} onChange={(e) => setV({ ...v, scopes: e.currentTarget.checked ? [...v.scopes, s] : v.scopes.filter((x) => x !== s) })} />
                {s}
              </label>
            ))}
          </fieldset>
          <div class="span-all"><button class="primary" disabled={!v.name || !v.scopes.length}>Create key</button></div>
        </form>
        {created && (
          <div class="secret">
            <p><b>Copy this key now — it is not shown again.</b></p>
            <code>{created}</code>
            <button class="small" onClick={() => navigator.clipboard.writeText(created)}>Copy</button>
          </div>
        )}
        <ErrorBox error={err ?? list.error} />
      </Card>
      <Card title="Keys" actions={<a class="btn small" href="/_/api/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a>}>
        <div class="tablewrap">
          <table class="list">
            <thead><tr><th>Name</th><th>Scopes</th><th>Restrictions</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {list.data?.items.map((k) => (
                <tr key={k.id} class={k.revoked_at ? 'muted' : ''}>
                  <td class="primary-cell" data-label="Name"><b>{k.name}</b></td>
                  <td class="wide" data-label="Scopes">{k.scopes.map((s) => <span class="tag" key={s}>{s}</span>)}</td>
                  <td class="small wide" data-label="Limited to">{[k.owner_prefix && `owner ${k.owner_prefix}*`, k.namespaces?.length && `ns ${k.namespaces.join(', ')}`].filter(Boolean).join(' · ') || '—'}</td>
                  <td class="muted small" data-label="Last used">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</td>
                  <td class="status-cell">{k.revoked_at ? <span class="badge b-archived">revoked</span> : <button class="danger small" onClick={() => revoke(k)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}
