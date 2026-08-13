import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

import { Layout } from './components/Layout'
import { AdvancedPage } from './routes/AdvancedPage'
import { CardPage } from './routes/CardPage'
import { CardsPage } from './routes/CardsPage'
import { DeckGalleryPage } from './routes/DeckGalleryPage'
import { DeckPage } from './routes/DeckPage'
import { GlossaryPage } from './routes/GlossaryPage'
import { DeckPage as BinderPage } from './routes/DeckPage'
import { NotFoundPage } from './routes/NotFoundPage'
import { PlaytestPage } from './routes/PlaytestPage'
import { SearchPage } from './routes/SearchPage'
import { SetsPage } from './routes/SetsPage'
import { SettingsPage } from './routes/SettingsPage'

import './styles/global.css'
import './styles/components.css'

// The app restores its own scroll positions when returning to a cached view;
// the browser's guess fights that and wins the race often enough to matter.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <SearchPage /> },
      { path: 'card/:oracleId', element: <CardPage /> },
      { path: 'cards', element: <CardsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'advanced', element: <AdvancedPage /> },
      { path: 'deck', element: <DeckGalleryPage /> },
      { path: 'deck/:deckId', element: <DeckPage /> },
      // Two faces of one route: the picker, then the table.
      { path: 'playtest', element: <PlaytestPage /> },
      { path: 'playtest/:deckId', element: <PlaytestPage /> },
      { path: 'sets', element: <SetsPage /> },
      { path: 'glossary', element: <GlossaryPage /> },
      // The binder is the deck editor in binder mode: one deck, never listed
      // among the others, reached by its own tab rather than by opening it.
      { path: 'binder', element: <BinderPage binder /> },
      // Inside the layout, not beside it: a wrong turn should still leave you
      // looking at the app's own navigation rather than a bare page.
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
