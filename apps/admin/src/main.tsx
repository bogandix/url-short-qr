import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { getSession, onSession, setSession } from './api'
import { Dashboard } from './dashboard'
import { Keys } from './keys'
import { ChangePassword, Domains, Health, LinkDetail, Links, Login, NewLink } from './pages'
import { QrGenerator } from './qr'
import { useRoute } from './ui'
import './styles.css'

function App() {
  const [session, set] = useState(getSession())
  useEffect(() => {
    const off = onSession(() => set(getSession()))
    return () => void off()
  }, [])
  const [rawPage, ...rest] = useRoute()
  const page = rawPage
  if (!session) return <Login />
  if (session.mustChange) return <ChangePassword />

  const nav = (id: string, label: string) => (
    <a href={`#/${id}`} aria-current={page === id || (id === 'links' && page === 'link') ? 'page' : undefined}>{label}</a>
  )
  return (
    <>
      <nav class="top">
        <strong>Shortener</strong>
        {nav('dashboard', 'Dashboard')}
        {nav('links', 'Links')}
        {nav('new', 'New link')}
        {nav('qr', 'QR codes')}
        {nav('domains', 'Domains')}
        {nav('keys', 'API keys')}
        {nav('health', 'Health')}
        <span class="spacer" />
        <span class="muted small">{session.email ?? 'API key'}</span>
        <button class="ghost" onClick={() => setSession(null)}>Sign out</button>
      </nav>
      <main>
        {page === 'dashboard' && <Dashboard />}
        {page === 'links' && <Links />}
        {page === 'new' && <NewLink />}
        {page === 'link' && rest.length >= 2 && <LinkDetail ns={rest[0]!} code={rest[1]!} />}
        {page === 'qr' && <QrGenerator key={rest.join('/')} ns={rest[0]} code={rest[1]} />}
        {page === 'domains' && <Domains />}
        {page === 'keys' && <Keys />}
        {page === 'health' && <Health />}
      </main>
    </>
  )
}

render(<App />, document.getElementById('app')!)
