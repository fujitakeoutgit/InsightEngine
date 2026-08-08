import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useCollection } from '../lib/collection'
import { canAnimate, dissolvePage, gsap } from '../lib/motion'
import { CardTray } from './CardTray'
import { ManaSprite } from './ManaSprite'

/* Cards is deliberately absent: it is a tray now, not a destination.
 *
 * The pile you gather while browsing is only useful *next to* the thing you
 * gathered it for, so opening it navigates nowhere — it slides out of the
 * banner over whatever you were doing. The /cards route still exists for a
 * direct link. */
const NAV = [
  { to: '/', label: 'Search', end: true },
  { to: '/advanced', label: 'Advanced' },
  { to: '/deck', label: 'Deck Lab' },
  { to: '/playtest', label: 'Playtest' },
  { to: '/sets', label: 'Sets' },
  { to: '/glossary', label: 'Glossary' },
]

export function Layout() {
  const collected = useCollection()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [scrolled, setScrolled] = useState(false)
  const [trayOpen, setTrayOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const inkRef = useRef<HTMLSpanElement>(null)

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

  // Every route change resolves the new page out of blur. Layout effect so
  // the "from" state is applied before the browser paints the new route —
  // an ordinary effect showed one full-opacity frame first.
  useLayoutEffect(() => {
    dissolvePage(mainRef.current)
  }, [pathname])

  /* The gate for every CSS-driven entrance (dialogs, overlays, dropdowns).
   *
   * A keyframe on a hidden document starts and then freezes at its first
   * frame — time does not advance without compositing — so an entrance that
   * begins at opacity 0 leaves the element invisible for as long as the page
   * stays hidden. That is the same trap canAnimate() exists to dodge for
   * GSAP, so CSS entrances subscribe to the same verdict: they are declared
   * under `:root.motion-ok`, and this is the one place that class is set. */
  useEffect(() => {
    const sync = () =>
      document.documentElement.classList.toggle('motion-ok', canAnimate())
    sync()
    document.addEventListener('visibilitychange', sync)
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    media.addEventListener('change', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      media.removeEventListener('change', sync)
    }
  }, [])

  // The header earns denser glass once content actually passes beneath it.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  /* The nav ink: one underline that travels to the active link.
   *
   * Measured from the DOM rather than derived from NAV, because the links
   * are variable width and the Cards badge appears and disappears — which is
   * also why `collected.length` is a dependency. Re-measured on resize.
   * With animation unavailable the ink is placed, not slid; either way the
   * end state is the same measurement. */
  useLayoutEffect(() => {
    const place = (animate: boolean) => {
      const nav = navRef.current
      const ink = inkRef.current
      if (!nav || !ink) return
      const active = nav.querySelector<HTMLElement>('a.active')
      if (!active) {
        gsap.set(ink, { width: 0 })
        return
      }
      // The link has 11px of side padding; the ink underlines the label, not
      // the hit area, which is what the old per-link rule drew.
      const x = active.offsetLeft + 11
      const width = Math.max(0, active.offsetWidth - 22)
      if (animate && canAnimate()) {
        gsap.to(ink, { x, width, duration: 0.45, ease: 'power3.out', overwrite: true })
      } else {
        gsap.set(ink, { x, width })
      }
    }
    place(true)
    const onResize = () => place(false)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [pathname, collected.length])

  return (
    <div className="app">
      <ManaSprite />
      {/* Ambient field: two drifting blobs behind a static turbulence grain. */}
      <div className="field" aria-hidden>
        <div className="blob a" />
        <div className="blob b" />
      </div>

      <header className={scrolled ? 'header scrolled' : 'header'}>
        <div className="shell header-inner">
          <NavLink to="/" className="brand">
            <span className="mark" aria-hidden />
            Insight Enigma
          </NavLink>
          <nav className="nav" ref={navRef}>
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
            {/* A button, not a link: it opens over the page rather than
                replacing it, so it never takes the ink either. */}
            <button
              className={trayOpen ? 'nav-tray on' : 'nav-tray'}
              onClick={() => setTrayOpen((o) => !o)}
              aria-expanded={trayOpen}
            >
              Cards
              {collected.length > 0 && (
                <span className="count-badge">{collected.length}</span>
              )}
            </button>
            <span className="nav-ink" ref={inkRef} aria-hidden />
          </nav>
        </div>
      </header>

      <CardTray open={trayOpen} onClose={() => setTrayOpen(false)} />

      <main ref={mainRef}>
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
