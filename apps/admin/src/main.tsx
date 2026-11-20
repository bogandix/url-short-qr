import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { getSession, onSession, setSession } from './api'
import { Domains, Health, LinkDetail, Links, Login, NewLink } from './pages'
import { useRoute } from './ui'
import './styles.css'

function App() {
  const [session, set] = useState(getSession())
  useEffect(() => {
    const off = onSession(() => set(getSession()))
    return () => void off()
  }, [])
  const [page, ...rest] = useRoute()
  if (!session) return <Login />

  const nav = (id: string, label: string) => (
    <a href={`#/${id}`} aria-current={page === id || (id === 'links' && page === 'link') ? 'page' : undefined}>{label}</a>
  )
  return (
    <>
      <nav class="top">
        <strong>Shortener</strong>
        {nav('links', 'Links')}
        {nav('new', 'New')}
        {nav('domains', 'Domains')}
        {nav('health', 'Health')}
        <span class="spacer" />
        <span class="muted small">{session.email ?? 'API key'}</span>
        <button class="ghost" onClick={() => setSession(null)}>Sign out</button>
      </nav>
      <main>
        {page === 'links' && <Links />}
        {page === 'new' && <NewLink />}
        {page === 'link' && rest.length >= 2 && <LinkDetail ns={rest[0]!} code={rest[1]!} />}
        {page === 'domains' && <Domains />}
        {page === 'health' && <Health />}
      </main>
    </>
  )
}

render(<App />, document.getElementById('app')!)
