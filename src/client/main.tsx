import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/index.css'
import 'xterm/css/xterm.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element not found')
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
