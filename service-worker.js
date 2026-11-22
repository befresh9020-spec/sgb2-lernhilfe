/* ==========================================================================
   SERVICE WORKER – SGB II Lern- und Arbeitshilfe
   --------------------------------------------------------------------------
   Ziele:
   - Offline-Nutzung (Seite und Übung bleiben ohne Netz erreichbar)
   - Rechtsstand bleibt aktuell: Die Seite selbst wird "Netzwerk zuerst"
     geladen, der Cache dient nur als Rückfall
   - Passt zum Update-Hinweis in der index.html (SKIP_WAITING-Nachricht)

   BEI JEDEM INHALTLICHEN UPDATE:
   -> VERSION unten hochzählen. Der Browser vergleicht die sw.js Byte für
      Byte; nur wenn sie sich ändert, erscheint der Hinweis "Neue Version
      verfügbar" und der Cache wird neu aufgebaut.
   ========================================================================== */

const VERSION = '2026-07-1';
const CACHE_PREFIX = 'sgb2-lernhilfe-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

/* Wie lange auf das Netz gewartet wird, bevor bei vorhandenem Cache die
   gespeicherte Seite gezeigt wird (schlechtes Netz im Zug, WLAN-Löcher). */
const NAV_TIMEOUT_MS = 4000;

/* Relativ zum Speicherort der sw.js – funktioniert dadurch auf der eigenen
   Domain genauso wie in einem Codeberg-Pages-Unterordner.
   Fehlende Dateien (z. B. noch kein Icon) brechen die Installation NICHT ab. */
const PRECACHE_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192x192.png',
  './uebung-einkommensanrechnung.html'
];

const SCOPE = self.registration.scope;
const toUrl = (path) => new URL(path, SCOPE).href;
const INDEX_URL = toUrl('./index.html');

/* --------------------------------------------------------------------------
   INSTALL: Grunddateien vorab laden
   Bewusst KEIN skipWaiting() hier: Die neue Version wartet, bis der Nutzer
   im Hinweis "Neu laden" wählt. So wechselt die Seite nie mitten im Lernen.
   -------------------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled(
        PRECACHE_FILES.map(async (path) => {
          /* cache: 'reload' umgeht den HTTP-Cache des Browsers bzw. von
             Codeberg Pages, damit wirklich der neue Stand gespeichert wird */
          const response = await fetch(new Request(toUrl(path), { cache: 'reload' }));
          if (response.ok && !response.redirected) {
            await cache.put(toUrl(path), response);
          }
        })
      );
    })()
  );
});

/* --------------------------------------------------------------------------
   ACTIVATE: alte Caches aufräumen
   -------------------------------------------------------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/* --------------------------------------------------------------------------
   NACHRICHT VON DER SEITE: "Neu laden" im Update-Hinweis
   -------------------------------------------------------------------------- */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* --------------------------------------------------------------------------
   FETCH
   -------------------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const request = event.request;

  /* Nur einfache GET-Anfragen derselben Herkunft behandeln. Externe Links
     (app.sgb2-azubi.de, terminal.sgb2-azubi.de, codeberg.page) öffnen in
     eigenen Tabs und haben ihre eigenen Service Worker. */
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /* Die sw.js selbst nie aus dem eigenen Cache bedienen */
  if (url.pathname.endsWith('/sw.js')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
  } else {
    event.respondWith(handleAsset(event));
  }
});

/* Seitenaufrufe: Netzwerk zuerst, Cache als Rückfall.
   Gespeichert wird ohne Query-String, damit ?utm=… den Cache nicht aufbläht. */
async function handleNavigation(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);

  const cleanUrl = new URL(request.url);
  cleanUrl.search = '';
  const cacheKey = cleanUrl.href;

  const cached =
    (await cache.match(cacheKey)) ||
    (await cache.match(INDEX_URL)) ||
    (await cache.match(SCOPE));

  try {
    /* Ist schon eine Kopie da, wird nur begrenzt auf das Netz gewartet.
       Ohne Kopie (Erstbesuch) wird geduldig auf die Antwort gewartet. */
    const response = cached
      ? await fetchWithTimeout(request, NAV_TIMEOUT_MS)
      : await fetch(request);

    if (response.ok && !response.redirected) {
      event.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  } catch (err) {
    if (cached) return cached;
    return new Response(
      '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Offline</title></head>' +
        '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.6">' +
        '<h1>Keine Verbindung</h1>' +
        '<p>Die Lernhilfe wurde noch nicht für die Offline-Nutzung gespeichert. ' +
        'Bitte einmal mit Internetverbindung öffnen.</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/* Alle übrigen Dateien (Manifest, Icons, Übungsseite …):
   sofort aus dem Cache, im Hintergrund aktualisieren (Stale-While-Revalidate). */
async function handleAsset(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }

  const response = await network;
  return response || Response.error();
}

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Zeitüberschreitung'));
    }, ms);

    fetch(request, { signal: controller.signal }).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}