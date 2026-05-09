// Minimal Service Worker for PWA install eligibility
// dashboard はリアルタイム性重視 = network-first / オフライン fallback のみ
// cache 戦略は持たない（SSE 接続が前提なのでオフライン UX は重要でない）

const VERSION = 'company-hud-v0.1.0'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  // network-first で常に最新を取得・失敗時は最低限の応答を返す
  event.respondWith(
    fetch(event.request).catch(() => {
      // SSE エンドポイントは失敗しても 503 を返す（クライアントが reconnect 試行）
      if (event.request.url.includes('/sse')) {
        return new Response('', { status: 503 })
      }
      // それ以外は簡易オフライン応答
      return new Response(
        '<h1>offline</h1><p>company-hud server が落ちている可能性があります。<br>別ターミナルで <code>cd tools/company-hud && npm start</code></p>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 },
      )
    }),
  )
})
