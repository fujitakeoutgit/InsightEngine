import { useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useCollection } from '../lib/collection'
import { ManaSprite } from './ManaSprite'

const NAV = [
  { to: '/', label: 'Search', end: true },
  { to: '/advanced', label: 'Advanced' },
  { to: '/cards', label: 'Cards' },
  { to: '/deck', label: 'Deck Lab' },
  { to: '/sets', label: 'Sets' },
  { to: '/glossary', label: 'Glossary' },
]

export function Layout() {
  const collected = useCollection()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  /* "Press / to search" is printed in the footer of every page, but the only
   * handler lived inside SearchBar -- which renders on the search page alone,
   * so on five of the seven pages the footer was promising a key that did
   * nothing.
   *
   * Here it means "take me to the search box" rather than "focus it": there is
   * no box on this page to focus. SearchBar autofocuses itself when it opens
   * without a query, so arriving is the same as being focused, and its own
   * handler still owns the key once you are there. */
  useEffect(() => {
    if (pathname === '/') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target
        && (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable)
      ) return
      event.preventDefault()
      navigate('/')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pathname, navigate])

  return (
    <div className="app">
      <ManaSprite />
      {/* Ambient field: two drifting blobs behind a static turbulence grain. */}
      <div className="field" aria-hidden>
        <div className="blob a" />
        <div className="blob b" />
      </div>

      <header className="header">
        <div className="shell header-inner">
          <NavLink to="/" className="brand">
            <span className="mark" aria-hidden />
            Insight Enigma
          </NavLink>
          <nav className="nav">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => (isActive ? 'active' : '')}
              >
                {item.label}
                {item.to === '/cards' && collected.length > 0 && (
                  <span className="count-badge">{collected.length}</span>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main>
        <Outlet />
      </main>

      <footer className="footer">
        <div className="shell footer-grid">
          <div>
            <p>
              Card data and images from{' '}
              <a href="https://scryfall.com" target="_blank" rel="noreferrer noopener">
                Scryfall
              </a>
              . Insight Enigma is unofficial Fan Content permitted under the Wizards of the Coast
              Fan Content Policy.
            </p>
            <p className="faint" style={{ marginTop: 6 }}>
              Not affiliated with or endorsed by Scryfall or Wizards of the Coast. Magic: The
              Gathering is © Wizards of the Coast LLC.
            </p>
          </div>
          <p className="mono faint">
            Press <kbd>/</kbd> to search
          </p>
        </div>
      </footer>
    </div>
  )
}
