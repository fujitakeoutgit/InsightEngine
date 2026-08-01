import { Link, useLocation } from 'react-router-dom'

import { BackLink } from '../components/PageHead'

/**
 * The catch-all.
 *
 * Without one, a mistyped URL fell through to React Router's own error screen
 * — a stack trace on a black page, which says nothing to someone who simply
 * followed a stale link. This says which path missed and offers the two places
 * worth going next.
 */
export function NotFoundPage() {
  const { pathname } = useLocation()

  return (
    <section className="shell" style={{ paddingTop: 'var(--gap-5)' }}>
      <div className="page-back"><BackLink /></div>
      <div className="notice">
        <h3>Nothing lives here</h3>
        <p>
          <code className="mono">{pathname}</code> is not a page in this app.
        </p>
        <div className="row wrap gap-2" style={{ marginTop: 'var(--gap-3)' }}>
          <Link to="/" className="btn">Search</Link>
          <Link to="/deck" className="btn btn-ghost">Deck Lab</Link>
        </div>
      </div>
    </section>
  )
}
