import { NavLink, Outlet } from 'react-router-dom'
import { useCollection } from '../lib/collection'

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

  return (
    <div className="app">
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
