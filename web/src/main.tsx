import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

import { Layout } from './components/Layout'
import { AdvancedPage } from './routes/AdvancedPage'
import { CardPage } from './routes/CardPage'
import { CardsPage } from './routes/CardsPage'
import { DeckPage } from './routes/DeckPage'
import { GlossaryPage } from './routes/GlossaryPage'
import { SearchPage } from './routes/SearchPage'
import { SetsPage } from './routes/SetsPage'

import './styles/global.css'
import './styles/components.css'

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <SearchPage /> },
      { path: 'card/:oracleId', element: <CardPage /> },
      { path: 'cards', element: <CardsPage /> },
      { path: 'advanced', element: <AdvancedPage /> },
      { path: 'deck', element: <DeckPage /> },
      { path: 'sets', element: <SetsPage /> },
      { path: 'glossary', element: <GlossaryPage /> },
    ],
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
