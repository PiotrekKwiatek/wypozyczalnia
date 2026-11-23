// Wypożyczalnia Hufca: wersja z kontami. Logowanie mailem i hasłem (Firebase Authentication),
// role z listy maili (kolekcja roles), wspólna baza Firestore.
// Hasła nie trafiają do bazy ani do kodu aplikacji: przechowuje je Firebase Authentication jako skróty (scrypt).
import { initializeApp } from "./vendor/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, updateProfile, signOut, reload } from "./vendor/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, query, where, orderBy, limit, onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc, FieldPath } from "./vendor/firebase-firestore.js";
import CFG from "./config.js";

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
const gate = () => document.getElementById("inw-gate");
const card = () => document.getElementById("inw-card");
const nowISO = () => new Date().toISOString();
const MIN_PASS = 8;

if (!CFG || !CFG.apiKey || String(CFG.apiKey).includes("WSTAW")){
  document.addEventListener("DOMContentLoaded", () => showCard(`<h1>Wypożyczalnia Hufca</h1><p class="err">Strona nie ma jeszcze ustawień bazy (plik config.js).</p>`));
  throw new Error("Brak konfiguracji Firebase");
}
const app = initializeApp(CFG);
const auth = getAuth(app);
auth.languageCode = "pl";
let fs;
try { fs = initializeFirestore(app, {ignoreUndefinedProperties:true, localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})}); }
catch (_){ fs = initializeFirestore(app, {ignoreUndefinedProperties:true}); }

/* ---------- baza: to samo API co w Claude ---------- */
function mapErr(e){
  const raw = String((e && e.code) || "unavailable").replace(/^(firestore|auth)\//, "").replace(/-/g, "_");
  const code = ["not_found", "permission_denied", "failed_precondition", "out_of_range"].includes(raw) ? "invalid_argument" : raw === "deadline_exceeded" ? "unavailable" : raw;
  const o = new Error((e && e.message) || code); o.code = code; o.raw = raw; return o;
}
const guard = async fn => { try { return await fn(); } catch (e){ throw mapErr(e); } };
const wDoc = s => ({id:s.id, exists:s.exists(), data:() => (s.exists() ? s.data() : undefined), metadata:s.metadata});
const wQDoc = d => ({id:d.id, exists:true, data:() => d.data(), metadata:d.metadata});
const wQuery = q => ({docs:q.docs.map(wQDoc), size:q.size, empty:q.empty, metadata:q.metadata, docChanges:() => q.docChanges().map(c => ({type:c.type, oldIndex:c.oldIndex, newIndex:c.newIndex, doc:wQDoc(c.doc)}))});
const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function flat(o, pre, out){
  for (const [k, v] of Object.entries(o)){
    if (v === undefined) continue;
    if (isPlain(v) && Object.keys(v).length) flat(v, [...pre, k], out);
    else out.push(new FieldPath(...pre, k), v);
  }
  return out;
}
function mkQuery(path, cons){
  const q = () => query(collection(fs, path), ...cons);
  return {
    where:(f, op, v) => mkQuery(path, [...cons, where(f, op, v)]),
    orderBy:(f, dir) => mkQuery(path, [...cons, orderBy(f, dir || "asc")]),
    limit:n => mkQuery(path, [...cons, limit(n)]),
    get:() => guard(async () => wQuery(await getDocs(q()))),
    onSnapshot:(next, err) => onSnapshot(q(), s => next(wQuery(s)), e => { const m = mapErr(e); if (err) err(m); else console.warn(path, m); })
  };
}
function mkColl(path){
  return Object.assign(mkQuery(path, []), {
    path,
    doc:id => mkDoc(id ? `${path}/${id}` : doc(collection(fs, path)).path),
    add:async data => { const r = mkDoc(doc(collection(fs, path)).path); await r.set(data); return r; }
  });
}
function mkDoc(path){
  const ref = doc(fs, path);
  return {
    id:ref.id, path,
    get:() => guard(async () => wDoc(await getDoc(ref))),
    set:data => guard(() => setDoc(ref, data)),
    update:data => guard(async () => { const a = flat(data || {}, [], []); if (a.length) await updateDoc(ref, ...a); }),
    delete:() => guard(() => deleteDoc(ref)),
    onSnapshot:(next, err) => onSnapshot(ref, s => next(wDoc(s)), e => { const m = mapErr(e); if (err) err(m); else console.warn(path, m); }),
    collection:sub => mkColl(`${path}/${sub}`)
  };
}
const db = {doc:mkDoc, collection:mkColl};

/* ---------- konto ---------- */
let U = null, ACC = null;
const names = new Map();
const user = {
  me:async () => ({id:U.uid, name:ACC.name}),
  id:async () => U.uid,
  can:async () => ACC.role === "admin" || ACC.role === "biuro",
  canEdit:async () => ACC.role === "admin",
  isOwner:async () => false,
  profiles:async ids => {
    const out = {};
    if (!(ACC.role === "admin" || ACC.role === "biuro")) return out;
    await Promise.all(ids.map(async id => {
      if (!names.has(id)){ try { const s = await getDoc(doc(fs, "users", id)); names.set(id, s.exists() ? s.data() : null); } catch (_){ names.set(id, null); } }
      const p = names.get(id); if (p && p.name) out[id] = {name:p.name};
    }));
    return out;
  }
};

/* ---------- zdjęcia ---------- */
const blobs = new Map();
const toDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const assets = {
  upload:async b => {
    const d = await toDataURL(b);
    if (d.length > 900000) throw Object.assign(new Error("Zdjęcie jest za duże."), {code:"invalid_argument"});
    const r = doc(collection(fs, "blobs"));
    await guard(() => setDoc(r, {d, at:nowISO(), by:U ? U.uid : ""}));
    blobs.set(r.id, d);
    return {id:r.id};
  },
  delete:async id => { blobs.delete(id); try { await deleteDoc(doc(fs, "blobs", id)); } catch (_){} }
};
window.INW_BLOB = id => blobs.get(id) || "";
async function fillImg(img){
  const id = img.dataset.blob; if (!id || img.dataset.done) return;
  img.dataset.done = "1";
  if (!blobs.has(id)){ try { const s = await getDoc(doc(fs, "blobs", id)); blobs.set(id, s.exists() ? s.data().d : ""); } catch (_){ blobs.set(id, ""); } }
  const d = blobs.get(id); if (d) img.src = d; else img.classList.add("no-blob");
}
new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes){ if (n.nodeType !== 1) continue; if (n.matches && n.matches("img[data-blob]")) fillImg(n); if (n.querySelectorAll) n.querySelectorAll("img[data-blob]").forEach(fillImg); } })
  .observe(document.documentElement, {childList:true, subtree:true});

/* ---------- pliki ---------- */
const standalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
const downloads = {
  save:async ({filename, data, type}) => {
    const b = data instanceof Blob ? data : new Blob([data], {type:type || "text/plain;charset=utf-8"});
    if (standalone() && navigator.canShare){
      try { const f = new File([b], filename || "plik", {type:b.type || "application/octet-stream"}); if (navigator.canShare({files:[f]})){ await navigator.share({files:[f], title:filename}); return; } }
      catch (e){ if (e && e.name === "AbortError") return; }
    }
    const u = URL.createObjectURL(b), a = document.createElement("a");
    a.href = u; a.download = filename || "plik"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  }
};

/* ---------- ekrany logowania ---------- */
function showCard(html){
  const g = gate(), c = card(); if (!g || !c) return;
  g.hidden = false; document.body.classList.add("gated");
  c.innerHTML = html;
  const f = c.querySelector("input:not([type=hidden])"); if (f && !("ontouchstart" in window)) setTimeout(() => f.focus(), 30);
}
function hideCard(){ const g = gate(); if (g) g.hidden = true; document.body.classList.remove("gated"); }
const head = `<div class="inw-mark" aria-hidden="true"></div><h1>Wypożyczalnia Hufca</h1>`;
const msg = (t, err) => { const m = card() && card().querySelector(".inw-msg"); if (m){ m.textContent = t || ""; m.classList.toggle("err", !!err); } };
const busy = (on, label) => { const b = card() && card().querySelector("button[type=submit]"); if (b){ b.disabled = on; if (label) b.dataset.l = b.dataset.l || b.textContent; b.textContent = on && label ? label : (b.dataset.l || b.textContent); } };
function authErr(e){
  const c = String((e && e.code) || "");
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return "Zły e-mail albo hasło.";
  if (c.includes("email-already-in-use")) return "Konto z tym mailem już istnieje. Zaloguj się albo użyj „Nie pamiętam hasła”.";
  if (c.includes("weak-password") || c.includes("password-does-not-meet")) return `Hasło jest za słabe. Użyj co najmniej ${MIN_PASS} znaków.`;
  if (c.includes("invalid-email")) return "Sprawdź adres e-mail.";
  if (c.includes("too-many-requests")) return "Za dużo prób. Odczekaj kilka minut i spróbuj ponownie.";
  if (c.includes("network-request-failed")) return "Brak połączenia z internetem.";
  if (c.includes("unauthorized-continue-uri") || c.includes("unauthorized-domain")) return "Ta strona nie jest dopuszczona w ustawieniach Firebase (Autoryzowane domeny).";
  if (c.includes("operation-not-allowed")) return "Logowanie mailem i hasłem nie jest włączone w Firebase.";
  return `Coś poszło nie tak (${c || "błąd"}). Spróbuj ponownie.`;
}
const pwField = (id, label, hint, ac) => `<div class="field"><label for="${id}">${label}</label><div class="pw"><input id="${id}" type="password" autocomplete="${ac}" minlength="${MIN_PASS}" required><button type="button" class="pw-eye" data-pw="${id}" aria-label="Pokaż hasło">pokaż</button></div>${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
const lastEmail = () => { try { return localStorage.getItem("inwh-email") || ""; } catch (_){ return ""; } };

function screenLogin(note){
  showCard(`${head}<p>Zaloguj się mailem i hasłem.</p>${note ? `<p class="inw-ok">${esc(note)}</p>` : ""}
  <form id="f-login" class="inw-f" novalidate>
    <div class="field"><label for="l-mail">E-mail</label><input id="l-mail" type="email" autocomplete="username" inputmode="email" required value="${esc(lastEmail())}" placeholder="imie.nazwisko@zhp.net.pl"></div>
    ${pwField("l-pass", "Hasło", "", "current-password")}
    <p class="inw-msg" role="alert"></p>
    <button type="submit" class="btn btn-primary">Zaloguj się</button>
  </form>
  <div class="inw-links"><button type="button" class="lnk" data-go="register">Pierwszy raz? Załóż konto</button><button type="button" class="lnk" data-go="reset">Nie pamiętam hasła</button></div>`);
  $("#f-login").addEventListener("submit", async e => {
    e.preventDefault();
    const em = $("#l-mail").value.trim(), pw = $("#l-pass").value;
    if (!em || !pw){ msg("Wpisz e-mail i hasło.", true); return; }
    busy(true, "Loguję…"); msg("");
    try { localStorage.setItem("inwh-email", em); } catch (_){}
    try { await signInWithEmailAndPassword(auth, em, pw); }
    catch (err){ busy(false); msg(authErr(err), true); }
  });
}
function screenRegister(){
  showCard(`${head}<p>Załóż konto swoim mailem (najlepiej ZHP). Dostęp nada Ci admin hufca.</p>
  <form id="f-reg" class="inw-f" novalidate>
    <div class="field"><label for="r-name">Imię i nazwisko</label><input id="r-name" autocomplete="name" maxlength="60" required></div>
    <div class="field"><label for="r-mail">E-mail</label><input id="r-mail" type="email" autocomplete="username" inputmode="email" required value="${esc(lastEmail())}" placeholder="imie.nazwisko@zhp.net.pl"></div>
    ${pwField("r-pass", "Hasło", `Co najmniej ${MIN_PASS} znaków. Nie używaj hasła do poczty ZHP.`, "new-password")}
    <p class="inw-msg" role="alert"></p>
    <button type="submit" class="btn btn-primary">Załóż konto</button>
  </form>
  <div class="inw-links"><button type="button" class="lnk" data-go="login">Mam już konto, zaloguj</button></div>`);
  $("#f-reg").addEventListener("submit", async e => {
    e.preventDefault();
    const nm = $("#r-name").value.trim().replace(/\s+/g, " "), em = $("#r-mail").value.trim(), pw = $("#r-pass").value;
    if (nm.length < 3){ msg("Wpisz imię i nazwisko.", true); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)){ msg("Sprawdź adres e-mail.", true); return; }
    if (pw.length < MIN_PASS){ msg(`Hasło musi mieć co najmniej ${MIN_PASS} znaków.`, true); return; }
    busy(true, "Zakładam konto…"); msg("");
    try { localStorage.setItem("inwh-email", em); } catch (_){}
    try {
      pendingName = nm;
      const cred = await createUserWithEmailAndPassword(auth, em, pw);
      await updateProfile(cred.user, {displayName:nm});
      await sendEmailVerification(cred.user, {url:location.origin + location.pathname});
      screenVerify(cred.user, true);
    } catch (err){ pendingName = ""; busy(false); msg(authErr(err), true); }
  });
}
function screenReset(){
  showCard(`${head}<p>Wyślemy Ci link do ustawienia nowego hasła.</p>
  <form id="f-reset" class="inw-f" novalidate>
    <div class="field"><label for="p-mail">E-mail</label><input id="p-mail" type="email" autocomplete="username" inputmode="email" required value="${esc(lastEmail())}"></div>
    <p class="inw-msg" role="alert"></p>
    <button type="submit" class="btn btn-primary">Wyślij link</button>
  </form>
  <div class="inw-links"><button type="button" class="lnk" data-go="login">Wróć do logowania</button></div>`);
  $("#f-reset").addEventListener("submit", async e => {
    e.preventDefault();
    const em = $("#p-mail").value.trim(); if (!em){ msg("Wpisz e-mail.", true); return; }
    busy(true, "Wysyłam…");
    try { await sendPasswordResetEmail(auth, em, {url:location.origin + location.pathname}); screenLogin(`Jeśli konto z adresem ${em} istnieje, wysłaliśmy na nie link. Sprawdź też folder Spam.`); }
    catch (err){ busy(false); msg(authErr(err), true); }
  });
}
let pendingName = "";
function screenVerify(u, fresh){
  showCard(`${head}<p class="inw-big">Potwierdź adres e-mail</p>
  <p>${fresh ? "Konto założone. " : ""}Wysłaliśmy link na <b>${esc(u.email)}</b>. Kliknij go (sprawdź też folder Spam), a potem wróć tutaj.</p>
  <p class="inw-msg" role="alert"></p>
  <div class="inw-col"><button type="button" class="btn btn-primary" id="v-done">Już potwierdziłem</button><button type="button" class="btn" id="v-again">Wyślij link jeszcze raz</button><button type="button" class="lnk" id="v-out">Wyloguj</button></div>`);
  $("#v-done").onclick = async () => {
    msg("Sprawdzam…");
    try { await reload(u); } catch (_){}
    if (auth.currentUser && auth.currentUser.emailVerified){ await auth.currentUser.getIdToken(true); enter(auth.currentUser); }
    else msg("Adres nie jest jeszcze potwierdzony. Kliknij link w mailu i spróbuj ponownie.", true);
  };
  $("#v-again").onclick = async () => { try { await sendEmailVerification(u, {url:location.origin + location.pathname}); msg("Wysłano ponownie. Sprawdź skrzynkę i folder Spam."); } catch (err){ msg(authErr(err), true); } };
  $("#v-out").onclick = () => signOut(auth);
}
function screenNoAccess(u, req){
  showCard(`${head}<p class="inw-big">Nie masz jeszcze dostępu</p>
  <p>Konto <b>${esc(u.email)}</b> działa, ale nie ma go na liście osób z dostępem.</p>
  ${req ? `<p class="inw-ok">Prośba o dostęp wysłana ${esc(new Date(req.at).toLocaleDateString("pl-PL"))}. Gdy admin ją zatwierdzi, ta strona sama się odświeży.</p>`
        : `<form id="f-acc" class="inw-f" novalidate><div class="field"><label for="a-unit">Jednostka lub funkcja <span class="opt">(pomoże adminowi)</span></label><input id="a-unit" maxlength="80" placeholder="np. drużynowa 25 DH Przygoda"></div><p class="inw-msg" role="alert"></p><button type="submit" class="btn btn-primary">Poproś o dostęp</button></form>`}
  <div class="inw-links"><button type="button" class="lnk" id="n-out">Wyloguj</button></div>`);
  const f = $("#f-acc");
  if (f) f.addEventListener("submit", async e => {
    e.preventDefault(); busy(true, "Wysyłam…");
    try { const r = {uid:u.uid, email:u.email.toLowerCase(), name:u.displayName || "", unit:$("#a-unit").value.trim(), at:nowISO()}; await setDoc(doc(fs, "access", u.uid), r); screenNoAccess(u, r); }
    catch (err){ busy(false); msg("Nie udało się wysłać prośby. Spróbuj ponownie.", true); }
  });
  $("#n-out").onclick = () => signOut(auth);
}
document.addEventListener("click", e => {
  const g = e.target.closest("[data-go]"); if (g && gate() && gate().contains(g)){ ({login:screenLogin, register:screenRegister, reset:screenReset})[g.dataset.go](); return; }
  const eye = e.target.closest("[data-pw]"); if (eye){ const i = document.getElementById(eye.dataset.pw); if (i){ const show = i.type === "password"; i.type = show ? "text" : "password"; eye.textContent = show ? "ukryj" : "pokaż"; eye.setAttribute("aria-label", show ? "Ukryj hasło" : "Pokaż hasło"); } }
});

/* ---------- rola z listy maili ---------- */
let roleUnsub = null, started = false;
async function roleOf(u){
  const em = u.email.toLowerCase(), ref = doc(fs, "roles", em);
  let s = null; try { s = await getDoc(ref); } catch (_){ s = null; }
  if (s && s.exists()) return s.data();
  try { const d = {role:"admin", name:u.displayName || "", addedAt:nowISO(), addedBy:u.uid, owner:true}; await setDoc(ref, d); return d; } catch (_){}
  return null;
}
async function enter(u){
  showCard(`${head}<p>Sprawdzam dostęp…</p>`);
  try { const t = await u.getIdTokenResult(); if (!t.claims.email_verified) await u.getIdToken(true); } catch (_){}
  const r = await roleOf(u);
  const em = u.email.toLowerCase();
  if (!r || !["admin", "biuro", "druzynowy"].includes(r.role)){
    let req = null; try { const s = await getDoc(doc(fs, "access", u.uid)); req = s.exists() ? s.data() : null; } catch (_){}
    screenNoAccess(u, req);
    if (roleUnsub) roleUnsub();
    roleUnsub = onSnapshot(doc(fs, "roles", em), s => { if (s.exists()) location.reload(); }, () => {});
    return;
  }
  ACC = {uid:u.uid, email:em, name:u.displayName || r.name || em.split("@")[0], role:r.role};
  window.INW_ACCOUNT = ACC;
  document.body.classList.add("role-" + r.role);
  setDoc(doc(fs, "users", u.uid), {name:ACC.name, email:em, seen:nowISO(), role:r.role}, {merge:true}).catch(() => {});
  if (roleUnsub) roleUnsub();
  let first = true;
  roleUnsub = onSnapshot(doc(fs, "roles", em), s => { if (first){ first = false; return; } const d = s.exists() ? s.data() : null; if (!d || d.role !== ACC.role) location.reload(); }, () => location.reload());
  hideCard();
  const ab = document.getElementById("acct-btn");
  if (ab){ ab.hidden = false; ab.textContent = ACC.name.split(/\s+/).map(w => w[0] || "").join("").slice(0, 2).toUpperCase() || "?"; ab.title = ACC.name; }
  if (!started){ started = true; window.__inwResolve({db, user, assets, downloads}); }
}
onAuthStateChanged(auth, async u => {
  if (!u){ if (started) location.reload(); else screenLogin(); return; }
  U = u;
  if (u.displayName == null && pendingName){ try { await updateProfile(u, {displayName:pendingName}); } catch (_){} }
  if (!u.emailVerified){ try { await reload(u); } catch (_){} }
  if (!auth.currentUser || !auth.currentUser.emailVerified){ if (!pendingName) screenVerify(u, false); return; }
  enter(auth.currentUser);
});

/* ---------- konto: menu ---------- */
const ROLE_LBL = {admin:"admin", biuro:"biuro hufca", druzynowy:"drużynowy / instruktor"};
window.INW_ACCT = () => {
  if (!ACC || typeof openSheet !== "function") return;
  openSheet("Konto", `<div class="f">
    <div><p class="sheet-lead">${esc(ACC.name)}</p><p class="meta">${esc(ACC.email)} · rola: ${esc(ROLE_LBL[ACC.role] || ACC.role)}</p></div>
    <p class="hint">Hasło trzyma Firebase (Google) w postaci zaszyfrowanego skrótu. Nikt z hufca go nie widzi, także admin.</p>
    ${window.INW_INSTALL_HTML ? window.INW_INSTALL_HTML() : ""}
    <div class="form-actions"><button type="button" class="btn" data-act="inw-pass">Zmień hasło</button><span class="spacer"></span><button type="button" class="btn btn-primary" data-act="inw-signout">Wyloguj</button></div>
  </div>`, null, {noFocus:true});
};
window.INW_PASS = async () => {
  try { await sendPasswordResetEmail(auth, ACC.email, {url:location.origin + location.pathname}); if (typeof toast === "function") toast(`Wysłaliśmy link do zmiany hasła na ${ACC.email}.`); }
  catch (e){ if (typeof toast === "function") toast(authErr(e), "err"); }
};
window.INW_SIGNOUT = async () => { try { await signOut(auth); } finally { location.reload(); } };
window.INW_DB = {fs, doc, setDoc, deleteDoc, getDoc};
