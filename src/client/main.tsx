import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/index.css'
import '@xterm/xterm/css/xterm.css'
import { isIOSDevice, isIOSPWA } from './utils/device'

// Add class for iOS safe area handling
if (isIOSDevice()) {
  document.documentElement.classList.add('ios')
}
if (isIOSPWA()) {
  document.documentElement.classList.add('ios-pwa')
}
if (typeof window !== 'undefined' && window.location) {
  const params = new URLSearchParams(window.location.search)
  if (params.has('debug-ui')) {
    document.documentElement.classList.add('debug-ui')
  }
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
