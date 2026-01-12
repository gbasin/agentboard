import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/index.css'
import '@xterm/xterm/css/xterm.css'
import { isIOSPWA } from './utils/device'

// Add class for iOS PWA safe area handling
if (isIOSPWA()) {
  document.documentElement.classList.add('ios-pwa')
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element not found')
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
