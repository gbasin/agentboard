import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'
import fs from 'node:fs'

function isConnRefused(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false

  const anyErr = err as { code?: unknown; message?: unknown; errors?: unknown }
  if (anyErr.code === 'ECONNREFUSED') return true

  // Node can surface dual-stack localhost failures as an AggregateError.
  if (Array.isArray(anyErr.errors)) {
    for (const sub of anyErr.errors) {
      if (sub && typeof sub === 'object' && (sub as { code?: unknown }).code === 'ECONNREFUSED') {
        return true
      }
    }
  }

  return typeof anyErr.message === 'string' && anyErr.message.includes('ECONNREFUSED')
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const allowedHosts = env.VITE_ALLOWED_HOSTS
    ? env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim())
    : []
  const backendPort = env.PORT || '4040'

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'Agentboard',
          short_name: 'Agentboard',
          description: 'Web GUI for tmux optimized for AI agent TUIs',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          icons: [
            {
              src: '/icons/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: '/icons/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
            },
            {
              src: '/icons/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/ws(?:\/|$)/],
        },
      }),
    ],
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
    server: {
      allowedHosts,
      https: (() => {
        const homeDir = process.env.HOME
        if (!homeDir) {
          return undefined
        }
        const certFile = path.join(homeDir, '.agentboard', 'tls-cert.pem')
        const keyFile = path.join(homeDir, '.agentboard', 'tls-key.pem')
        if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
          try {
            return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
          } catch {
            // Fall back to HTTP when local certs are unreadable/invalid.
            return undefined
          }
        }
        return undefined
      })(),
      proxy: {
        '/api': {
          target: `http://localhost:${backendPort}`,
          // Preserve Vite string-shorthand behavior.
          changeOrigin: true,
          configure: (proxy) => {
            // Vite registers its own error handler after calling `configure()`.
            // Patch `proxy.on()` so that handler doesn't log ECONNREFUSED during backend restarts.
            const p = proxy as unknown as {
              on: (event: string, listener: (...args: any[]) => void) => unknown
            }
            const originalOn = p.on.bind(p)
            p.on = ((event: string, listener: (...args: any[]) => void) => {
              if (event !== 'error') return originalOn(event, listener)
              return originalOn(event, (err: unknown, _req: unknown, res: any, target: unknown) => {
                if (isConnRefused(err)) {
                  // Backend is restarting; avoid noisy logs and fail fast.
                  if (res && typeof res.writeHead === 'function') {
                    if (!res.headersSent && !res.writableEnded) {
                      res.writeHead(502, { 'Content-Type': 'text/plain' })
                    }
                    if (!res.writableEnded) res.end()
                  } else if (res && typeof res.end === 'function') {
                    res.end()
                  }
                  return
                }
                listener(err, _req, res, target)
              })
            }) as typeof p.on
          },
        },
        '/ws': {
          target: `ws://localhost:${backendPort}`,
          ws: true,
          configure: (proxy) => {
            const p = proxy as unknown as {
              on: (event: string, listener: (...args: any[]) => void) => unknown
            }
            const originalOn = p.on.bind(p)
            p.on = ((event: string, listener: (...args: any[]) => void) => {
              if (event !== 'error') return originalOn(event, listener)
              return originalOn(event, (err: unknown, req: unknown, res: any, target: unknown) => {
                if (isConnRefused(err)) {
                  // ws upgrade socket
                  if (res && typeof res.end === 'function') res.end()
                  return
                }
                listener(err, req, res, target)
              })
            }) as typeof p.on
          },
        },
      },
    },
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
    },
  }
})
