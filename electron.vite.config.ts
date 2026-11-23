import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

// THE PRODUCTION PAGE'S CSP (0.12.0-rc.2). index.html carries the dev server's
// policy (its React refresh preamble is an inline script, its hot reload a WebSocket); the built
// page, loaded from a file where no response header can carry one, takes a stricter one: no
// inline script, no socket, no base or form targets. Each replacement must land, so a change to
// index.html's policy fails the build rather than shipping the dev policy.
const productionCsp = (): Plugin => ({
  name: 'production-csp',
  apply: 'build',
  transformIndexHtml(html, ctx) {
    // the window's page only: display.html (Display on other screens) is served over HTTP, where
    // the display server sends its own policy as a header
    if (!ctx.filename.endsWith('index.html')) return html
    const swaps: Array<[string, string]> = [
      ["script-src 'self' 'unsafe-inline';", "script-src 'self';"],
      ["connect-src 'self' ws:", "connect-src 'self'; base-uri 'none'; form-action 'none'"]
    ]
    return swaps.reduce((out, [from, to]) => {
      if (!out.includes(from)) throw new Error(`production-csp: index.html's policy lacks ${from}`)
      return out.replace(from, to)
    }, html)
  }
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // CommonJS: a sandboxed preload cannot be an ES module (the windows are sandboxed since
    // 0.10.0), and .cjs because the package is "type": "module"
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss(), productionCsp()],
    // two pages: the app's windows (index.html) and Display on other screens (display.html)
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          display: resolve('src/renderer/display.html')
        }
      }
    }
  }
})
