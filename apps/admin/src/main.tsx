import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { getSession, onSession, setSession } from './api'
import { Dashboard } from './dashboard'
import { Keys } from './keys'
import { ChangePassword, Domains, Health, LinkDetail, Links, Login, More, NewLink } from './pages'
import { QrGenerator } from './qr'
import { Icon, useRoute } from './ui'
import './styles.css'

function App() {
  const [session, set] = useState(getSession())
  useEffect(() => {
    const off = onSession(() => set(getSession()))
    return () => void off()
  }, [])
  const [page, ...rest] = useRoute()
  useEffect(() => window.scrollTo(0, 0), [page])
  if (!session) return <Login />
  if (session.mustChange) return <ChangePassword />

  const current = (ids: string[]) => (ids.includes(page) ? 'page' : undefined)
  const top = (id: string, label: string, also: string[] = []) => (
    <a href={`#/${id}`} aria-current={current([id, ...also])}>{label}</a>
  )
  const tab = (id: string, label: string, icon: string, also: string[] = []) => (
    <a href={`#/${id}`} aria-current={current([id, ...also])}>
      <Icon name={icon} />
      {label}
    </a>
  )

  return (
    <>
      <header class="appbar">
        <a class="brand" href="#/dashboard" aria-label="Short links — dashboard">
          <span class="brand-dot" aria-hidden="true" />
          <span>Short links</span>
        </a>
        <nav class="topnav" aria-label="Main">
          {top('dashboard', 'Dashboard')}
          {top('links', 'Links', ['link'])}
          {top('new', 'New link')}
          {top('qr', 'QR codes')}
          {top('domains', 'Domains')}
          {top('keys', 'API keys')}
          {top('health', 'Health')}
        </nav>
        <span class="spacer" />
        <span class="who">{session.email ?? 'API key'}</span>
        <button class="btn ghost small signout" onClick={() => setSession(null)}>Sign out</button>
      </header>

      <main class="page">
        {page === 'dashboard' && <Dashboard />}
        {page === 'links' && <Links />}
        {page === 'new' && <NewLink />}
        {page === 'link' && rest.length >= 2 && <LinkDetail ns={rest[0]!} code={rest[1]!} />}
        {page === 'qr' && <QrGenerator key={rest.join('/')} ns={rest[0]} code={rest[1]} />}
        {page === 'domains' && <Domains />}
        {page === 'keys' && <Keys />}
        {page === 'health' && <Health />}
        {page === 'more' && <More email={session.email} />}
      </main>

      <nav class="tabbar" aria-label="Main">
        {tab('dashboard', 'Home', 'dashboard')}
        {tab('links', 'Links', 'links', ['link'])}
        <a href="#/new" class="new" aria-current={current(['new'])}>
          <span class="plus"><Icon name="plus" /></span>
          New
        </a>
        {tab('qr', 'QR', 'qr')}
        {tab('more', 'More', 'more', ['domains', 'keys', 'health'])}
      </nav>
    </>
  )
}

render(<App />, document.getElementById('app')!)
