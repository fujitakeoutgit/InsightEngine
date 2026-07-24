import { useEffect, useRef } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { gsap, reduced } from '../lib/motion'

const NAV = [
  { to: '/', label: 'Search', end: true },
  { to: '/advanced', label: 'Advanced' },
  { to: '/deck', label: 'Deck Lab' },
  { to: '/sets', label: 'Sets' },
  { to: '/glossary', label: 'Glossary' },
]

/** Procedural film grain, generated once so no image asset is needed. */
function useGrain() {
  useEffect(() => {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const image = ctx.createImageData(size, size)
    for (let i = 0; i < image.data.length; i += 4) {
      const v = Math.random() * 255
      image.data[i] = v
      image.data[i + 1] = v
      image.data[i + 2] = v
      image.data[i + 3] = 255
    }
    ctx.putImageData(image, 0, 0)
    document.documentElement.style.setProperty('--grain-url', `url(${canvas.toDataURL()})`)
  }, [])
}

export function Layout() {
  const headerRef = useRef<HTMLElement>(null)
  useGrain()

  // The header hairline strengthens once the page has scrolled.
  useEffect(() => {
    if (reduced() || !headerRef.current) return
    const onScroll = () => {
      const scrolled = window.scrollY > 12
      gsap.to(headerRef.current, {
        '--hairline': scrolled ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.07)',
        duration: 0.3,
        overwrite: true,
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="app">
      <div className="aurora" aria-hidden />
      <div className="grain" aria-hidden />

      <header className="header" ref={headerRef}>
        <div className="shell header-inner">
          <NavLink to="/" className="wordmark">
            <span className="mark" aria-hidden />
            Manafold
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
              . Manafold is unofficial Fan Content permitted under the Wizards of the Coast Fan
              Content Policy.
            </p>
            <p className="faint" style={{ marginTop: 'var(--gap-1)' }}>
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
