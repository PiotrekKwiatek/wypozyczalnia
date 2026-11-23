// Wypożyczalnia Hufca: aplikacja na telefonie i praca przy słabym zasięgu.
// Pliki aplikacji: najpierw sieć (żeby poprawki docierały od razu), bez sieci z pamięci.
// Dane (Firebase) idą osobno i nie są tu buforowane – Firestore ma własną pamięć offline.
const CACHE = "wypozyczalnia-20261123d";
const CORE = ["./", "./index.html", "./prod.js", "./fb.js", "./config.js", "./manifest.webmanifest",
  "./icons/apple-touch-icon.png", "./icons/icon-192.png", "./icons/icon-512.png",
  "./vendor/firebase-app.js", "./vendor/firebase-auth.js", "./vendor/firebase-firestore.js",
  "./vendor/qrcode.js", "./vendor/jsQR.js", "./vendor/jspdf.umd.min.js", "./vendor/xlsx.full.min.js"];

const timed = (req, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("timeout")), ms);
  fetch(req).then(r => { clearTimeout(t); res(r); }, e => { clearTimeout(t); rej(e); });
});

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("wypozyczalnia-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL("./", location).pathname)) return;
  e.respondWith(
    // „no-cache”: zawsze pytamy serwer, czy plik się zmienił (szybkie 304), więc poprawki docierają przy pierwszym otwarciu z internetem
    timed(new Request(req.url, {cache:"no-cache", credentials:"same-origin"}), req.mode === "navigate" ? 5000 : 8000)
      .then(r => { if (r && r.ok && r.type === "basic"){ const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; })
      .catch(() => caches.match(req, {ignoreSearch:true}).then(r => r || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
