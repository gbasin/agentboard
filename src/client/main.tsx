import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/index.css'
import '@xterm/xterm/css/xterm.css'
import { isIOSDevice, isIOSPWA } from './utils/device'
import { registerSW } from 'virtual:pwa-register'

// Add class for iOS safe area handling
if (isIOSDevice()) {
  document.documentElement.classList.add('ios')
}
if (isIOSPWA()) {
  document.documentElement.classList.add('ios-pwa')
}

if (import.meta.env.PROD) {
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      // Long-lived PWA sessions may not reload often; periodically re-check for updates.
      setInterval(() => {
        void registration.update()
      }, 5 * 60 * 1000)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          void registration.update()
        }
      })
    },
  })
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
