// Précache uniquement l’application; le préfixe évite d’effacer les caches d’autres sites.
const CACHE_PREFIX = "pdfstudio-";
const CACHE = `${CACHE_PREFIX}v7`;
const FILES = [
  "./", "index.html", "app.js", "engine.js", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "vendor/mupdf.js", "vendor/mupdf-wasm.js", "vendor/mupdf-wasm.wasm",
  ...["LiberationSerif", "LiberationSans", "Carlito"].flatMap((f) => ["Regular", "Bold", "Italic", "BoldItalic"].map((s) => `fonts/${f}-${s}.ttf`)),
  "fonts/LiberationMono-Regular.ttf", "fonts/LiberationMono-Bold.ttf",
];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => (k.startsWith(CACHE_PREFIX) && k !== CACHE) || k === "editeur-pdf-v1").map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match(new URL("index.html", self.registration.scope))));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
