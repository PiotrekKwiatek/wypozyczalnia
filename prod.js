// Wypożyczalnia Hufca: dodatki wersji z kontami (role, widok drużynowego, wnioski, użytkownicy).
// Ładowany zaraz po głównym skrypcie aplikacji; podmienia kilka jej funkcji zależnie od roli.
(function(){
  var ACC = function(){ return window.INW_ACCOUNT || null; };
  var role = function(){ return (ACC() || {}).role || ""; };
  var isDruz = function(){ return role() === "druzynowy"; };
  var isAdmin = function(){ return role() === "admin"; };
  var isStaff = function(){ return role() === "admin" || role() === "biuro"; };
  var ROLE_LBL = {admin:"admin", biuro:"biuro hufca", druzynowy:"drużynowy / instruktor"};
  var DSTATUS = {nowy:["warn", "czeka na biuro"], zaplanowany:["lent", "przyjęty"], wydany:["ok", "wydany"], czesciowo:["lent", "część oddana"], zwrocony:["mute", "zwrócony"], odrzucony:["late", "odrzucony"], anulowany:["mute", "anulowany"]};

  S.cat = {}; S.myreq = []; S.roles = new Map(); S.access = []; S.usersList = []; S.dOnlyAvail = false; S.uq = "";
  S.dcart = (function(){ try { var v = JSON.parse(localStorage.getItem("inwh-dcart") || "[]"); return Array.isArray(v) ? v.filter(function(x){ return x && typeof x.itemId === "string"; }) : []; } catch (_){ return []; } })();
  function saveDcart(){ try { localStorage.setItem("inwh-dcart", JSON.stringify(S.dcart)); } catch (_){} updateCartBar(); }
  window.INW_BIURO_ADD = function(){ var a = S.config && S.config.get && S.config.get("access"); return !a || a.biuroAddItems !== false; };

  /* ---------- co kto subskrybuje ---------- */
  window.INW_SUBS = function(){
    if (isDruz()) return ["catalog", "myrequests", "config"];
    var base = ["rooms", "boxes", "items", "active", "loans", "issues", "plans", "requests", "config", "log", "catalog"];
    return isAdmin() ? base.concat(["roles", "access", "users"]) : base;
  };
  var _subOne = subOne;
  subOne = function(name){
    var err = function(e){ S.got[name] = true; scheduleRender(); onSubErr(name)(e); };
    if (name === "catalog") return S.db.doc("public/catalog").onSnapshot(function(s){ var d = s.exists ? s.data() : null; S.cat = (d && d.items) || {}; S.got.catalog = true; scheduleRender(); }, err);
    if (name === "myrequests") return S.db.collection("requests").where("uid", "==", ACC().uid).onSnapshot(function(q){ S.myreq = q.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); }); S.got.myrequests = true; scheduleRender(); }, err);
    if (name === "roles") return S.db.collection("roles").onSnapshot(function(q){ S.roles = new Map(q.docs.map(function(d){ return [d.id, d.data()]; })); S.got.roles = true; scheduleRender(); }, err);
    if (name === "access") return S.db.collection("access").onSnapshot(function(q){ S.access = q.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); }); S.got.access = true; scheduleRender(); }, err);
    if (name === "users") return S.db.collection("users").onSnapshot(function(q){ S.usersList = q.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); }); S.got.users = true; scheduleRender(); }, err);
    return _subOne(name);
  };

  /* ---------- oszczędne wczytywanie (23.11) ----------
     Darmowy plan Firebase to 50 000 odczytów dziennie, a każde otwarcie aplikacji czyta wszystko od nowa.
     Na start biuro i admin dostają więc tylko ostatnie 3 miesiące historii, oddanych wypożyczeń i załatwionych usterek.
     Otwarte wypożyczenia i otwarte usterki są zawsze w całości. Starsze dane wczytują się na żądanie
     („Wczytaj starsze”, okres „ostatni rok” / „całość” w Historii) i zawsze przed kopią zapasową. */
  var RECENT_DAYS = 92, LAZY = ["active", "loans", "issues", "log"];
  var subs = {}, part = {}, firstGot = {}, fullWait = null, fullRes = null, fullLeft = 0;
  S.histFull = false;
  function cutoffDate(){ var d = new Date(); d.setDate(d.getDate() - RECENT_DAYS); d.setHours(0, 0, 0, 0); return d; }
  function stopSub(name){ (subs[name] || []).forEach(function(u){ try { u(); } catch (_){} }); subs[name] = []; }
  function byDesc(f){ return function(a, b){ return String(b[f] || "").localeCompare(String(a[f] || "")); }; }
  function mergeById(lists){ var m = new Map(); lists.forEach(function(l){ (l || []).forEach(function(x){ m.set(x.id, x); }); }); return Array.from(m.values()); }
  function setLoans(){ S.loans = S.histFull && part.loansAll ? part.loansAll : mergeById([part.loansRecent, S.active]).sort(byDesc("out")); }
  function setIssues(){ S.issues = S.histFull && part.issuesAll ? part.issuesAll : mergeById([part.issuesOpen, part.issuesRecent]).sort(byDesc("at")); }
  function setLog(docs){
    S.log = docs.flatMap(function(d){ var v = d.data() || {}; return Object.entries(v.ev && typeof v.ev === "object" ? v.ev : {}).map(function(p){ return Object.assign({}, p[1], {id:p[0]}); }); })
      .filter(function(e){ return e && e.at; }).sort(function(a, b){ return String(b.at).localeCompare(String(a.at)); });
  }
  function fullArrived(key){
    if (!fullRes || firstGot[key]) return; firstGot[key] = true;
    if (--fullLeft <= 0){ var r = fullRes; fullRes = null; r(); }
  }
  var _subOne2 = subOne;
  subOne = function(name){
    if (!S.db || !isStaff() || LAZY.indexOf(name) < 0) return _subOne2(name);
    stopSub(name);
    var full = S.histFull, need = 0, got = {};
    var err = function(e){ S.got[name] = true; scheduleRender(); if (full) fullArrived("full-" + name); onSubErr(name)(e); };
    var on = function(key, q, fn){
      need++;
      subs[name].push(q.onSnapshot(function(s){
        fn(s);
        if (!got[key]){ got[key] = true; need--; }
        if (need <= 0){ S.got[name] = true; if (full) fullArrived("full-" + name); }
        scheduleRender();
      }, err));
    };
    var rows = function(s){ return s.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); }); };
    var c = cutoffDate(), cIso = c.toISOString(), cDay = ymdOf(c);
    if (name === "active") on("a", S.db.collection("loans").where("open", "==", true), function(s){ S.active = rows(s); setLoans(); });
    else if (name === "loans"){
      if (full) on("all", S.db.collection("loans").orderBy("out", "desc"), function(s){ part.loansAll = rows(s); setLoans(); });
      else on("recent", S.db.collection("loans").where("out", ">=", cIso).orderBy("out", "desc"), function(s){ part.loansRecent = rows(s); setLoans(); });
    }
    else if (name === "issues"){
      if (full) on("all", S.db.collection("issues").orderBy("at", "desc"), function(s){ part.issuesAll = rows(s); setIssues(); });
      else {
        on("open", S.db.collection("issues").where("open", "==", true), function(s){ part.issuesOpen = rows(s); setIssues(); });
        on("recent", S.db.collection("issues").where("at", ">=", cIso).orderBy("at", "desc"), function(s){ part.issuesRecent = rows(s); setIssues(); });
      }
    }
    else if (name === "log"){
      if (full) on("all", S.db.collection("log").orderBy("day", "desc"), function(s){ setLog(s.docs); });
      else on("recent", S.db.collection("log").where("day", ">=", cDay).orderBy("day", "desc"), function(s){ setLog(s.docs); });
    }
  };
  // Wczytuje całość historii (raz na sesję). Zwraca obietnicę, która kończy się, gdy dane są na miejscu.
  window.INW_FULL = function(){
    if (!S.db || !isStaff()) return Promise.resolve();
    if (S.histFull) return fullWait || Promise.resolve();
    S.histFull = true; firstGot = {}; fullLeft = 3;
    fullWait = new Promise(function(res){ fullRes = res; });
    ["loans", "issues", "log"].forEach(function(n){ subOne(n); });
    scheduleRender();
    return fullWait.then(function(){ scheduleRender(); });
  };
  var _histList = histListHTML;
  histListHTML = function(){
    var h = _histList();
    if (!ACC() || !isStaff() || S.histFull && !fullRes) return h;
    if (S.histFull || S.hist.period === "365" || S.hist.period === "all"){ window.INW_FULL(); return h + '<p class="meta inw-older">Wczytuję starszą historię…</p>'; }
    return h + '<div class="actions inw-older"><span class="meta">Wczytane są ruchy z ostatnich 3 miesięcy.</span><button type="button" class="btn btn-sm btn-ghost" data-act="inw-full">Wczytaj starsze</button></div>';
  };
  var _itemLog = itemLogHTML;
  itemLogHTML = function(id){
    var h = _itemLog(id);
    if (!h || !ACC() || !isStaff() || S.histFull) return h;
    return h + '<div class="actions inw-older"><span class="meta">Zmiany z ostatnich 3 miesięcy.</span><button type="button" class="btn btn-sm btn-ghost" data-act="inw-full">Wczytaj starsze</button></div>';
  };
  // Kopia zapasowa ma zawsze zawierać całą historię, nie tylko ostatnie 3 miesiące.
  var _backup = backupXlsx;
  backupXlsx = async function(){
    if (ACC() && isStaff() && !(S.histFull && !fullRes)){ toast("Wczytuję całą historię do kopii…"); await window.INW_FULL(); }
    return _backup();
  };

  /* ---------- katalog dla drużynowych (prowadzi go biuro/admin automatycznie) ---------- */
  function stable(v){ if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]"; if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function(k){ return JSON.stringify(k) + ":" + stable(v[k]); }).join(",") + "}"; return JSON.stringify(v); }
  function catalogNow(){
    var out = {};
    S.items.forEach(function(i){
      var e = {n:i.name, q:qtyOf(i), a:avail(i)}; if (i.photo) e.p = i.photo; var c = arr(i.codes); if (c.length) e.c = c;
      // gdzie leży: nazwa i kolejność pomieszczenia oraz pudło (drużynowy nie ma dostępu do samych pomieszczeń)
      var bx = i.boxId ? S.boxes.get(i.boxId) : null, rm = S.rooms.get(i.roomId || (bx && bx.roomId));
      if (rm){ e.r = rm.name; if (typeof rm.order === "number") e.ro = rm.order; }
      if (bx && bx.name) e.b = bx.name;
      if (i.cat) e.k = i.cat;
      out[i.id] = e;
    });
    return out;
  }
  var catT = 0, catBusy = false;
  function scheduleCatalogSync(){ if (!isStaff()) return; clearTimeout(catT); catT = setTimeout(syncCatalog, 1200); }
  async function syncCatalog(){
    if (!isStaff() || catBusy || !S.db || !S.got.items || !S.got.rooms || !S.got.boxes || !S.got.active || !S.got.issues || !S.got.catalog) return;
    var next = catalogNow(); if (stable(next) === stable(S.cat || {})) return;
    catBusy = true;
    try { await S.db.doc("public/catalog").set({items:next, at:now()}); } catch (e){ console.warn("katalog", e); }
    catBusy = false;
  }
  /* ---------- status wniosku nadąża za tym, co dzieje się z rzeczami (23.11) ----------
     zaplanowany → wydany → częściowo zwrócony → zwrócony; cofnięcie zwrotu cofa też status.
     Wniosek łączy się z wypożyczeniami przez reqId (nowe) albo przez planId (starsze). */
  var reqT = 0, reqBusy = false;
  function scheduleReqSync(){ if (!isStaff()) return; clearTimeout(reqT); reqT = setTimeout(syncRequests, 1500); }
  async function syncRequests(){
    if (!isStaff() || reqBusy || !S.db || !S.got.requests || !S.got.loans || !S.got.active || !S.got.plans) return;
    var cut = cutoffDate().toISOString(), ups = [];
    S.requests.forEach(function(r){
      var st = r.status || "nowy";
      if (["zaplanowany", "wydany", "czesciowo", "zwrocony"].indexOf(st) < 0) return;
      // starsze wypożyczenia mogą nie być wczytane (ostatnie 3 miesiące), więc ich nie oceniamy
      if (!S.histFull && r.issuedAt && r.issuedAt < cut) return;
      var L = S.loans.filter(function(l){ return l.reqId === r.id || (r.planId && l.planId === r.planId); });
      var planned = S.plans.some(function(p){ return p.requestId === r.id || (r.planId && p.id === r.planId); });
      var next, extra = {};
      if (L.length){
        var open = L.filter(function(l){ return l.open; }).length;
        next = open === L.length ? "wydany" : open === 0 ? "zwrocony" : "czesciowo";
        if (next === "zwrocony") extra.returnedAt = L.reduce(function(m, l){ return String(l.back || "") > m ? String(l.back) : m; }, "") || now();
      } else if (planned) next = "zaplanowany";
      else return;
      if (next !== st) ups.push([r.id, Object.assign({status:next, updatedAt:now()}, extra)]);
    });
    if (!ups.length) return;
    reqBusy = true;
    for (var k = 0; k < ups.length; k++){ try { await S.db.doc("requests/" + ups[k][0]).update(ups[k][1]); } catch (e){ console.warn("wniosek", e); } }
    reqBusy = false;
  }
  // odśwież widok, chyba że ktoś właśnie pisze w polu tekstowym (przełączniki i listy wyboru nie blokują odświeżania)
  scheduleRender = function(){
    var a = document.activeElement, m = $("#main");
    var typing = a && m && m.contains(a) && (a.matches("textarea") || (a.matches("input") && !/^(checkbox|radio|button|submit|file|range|color)$/i.test(a.type || "")));
    if (typing) S.pendingRender = true;
    else { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(render); }
    scheduleCatalogSync(); scheduleReqSync();
  };

  /* ---------- podmiany wspólnych elementów ---------- */
  var _updateRO = updateRO;
  updateRO = function(){ if (!ACC()) return _updateRO(); var ro = $("#ro"), rb = $("#role-btn"); if (ro) ro.hidden = true; if (rb) rb.hidden = true; };
  var _buildTabs = buildTabs;
  buildTabs = function(){
    if (!isDruz()) return _buildTabs();
    var t = $("#tabs"); if (!t) return;
    t.innerHTML = '<a class="tab" href="#" data-tab="home">' + IC.list + '<span>Sprzęt</span></a><a class="tab" href="#wnioski" data-tab="wnioski">' + IC.cal + '<span>Moje wnioski</span></a>';
    t.style.setProperty("--tabs", 2);
  };
  var _updateCartBar = updateCartBar;
  updateCartBar = function(){
    if (!isDruz()) return _updateCartBar();
    var b = $("#cartbar"); if (!b) return;
    var items = S.dcart.filter(function(c){ return S.cat[c.itemId]; });
    var show = items.length > 0 && S.dbState === "ok";
    b.hidden = !show; document.body.classList.toggle("has-cart", show);
    if (!show) return;
    var n = items.reduce(function(s, c){ return s + c.qty; }, 0);
    b.innerHTML = '<button type="button" class="sum sum-btn" data-act="d-cart" aria-label="Pokaż wniosek">' + IC.cart + '<span>Wniosek: <b>' + items.length + '</b> ' + pl(items.length, "pozycja", "pozycje", "pozycji") + (n !== items.length ? " · " + n + " szt." : "") + '</span></button><button type="button" class="btn btn-sm btn-ghost" data-act="d-cart">Edytuj</button><button type="button" class="btn btn-sm btn-primary" data-act="d-send">Wyślij wniosek</button>';
  };
  var _viewHome = viewHome;
  viewHome = function(){
    var h = _viewHome(); if (!isStaff()) return h;
    var nr = S.requests.filter(function(r){ return (r.status || "nowy") === "nowy"; }).length, pend = isAdmin() ? S.access.length : 0;
    var parts = [];
    if (nr) parts.push('<button type="button" class="inw-pill warn" data-act="inw-reqs">' + IC.mail + '<span>Nowe wnioski: <b>' + nr + '</b></span></button>');
    if (isAdmin()) parts.push('<a class="inw-pill" href="#uzytkownicy">' + IC.list + '<span>Użytkownicy' + (pend ? ' · prośby o dostęp: <b>' + pend + '</b>' : "") + '</span></a>');
    return parts.length ? '<div class="inw-strip">' + parts.join("") + '</div>' + h : h;
  };
  var _render = render;
  render = function(){
    if (!ACC()) return _render();
    if (isDruz()) return renderDruz();
    if (isAdmin() && location.hash === "#uzytkownicy" && !S.q.trim()){
      S.pendingRender = false; updateTabs(); var bb = $("#back-btn"); if (bb) bb.hidden = false;
      $("#main").innerHTML = viewUsers(); return;
    }
    return _render();
  };

  /* ---------- widok drużynowego ----------
     24.11: najpierw „co jest dostępne”: kafelki kategorii z liczbą wolnych rzeczy, po kliknięciu lista kategorii.
     Gdzie co leży jest na drugim planie: szary dopisek przy rzeczy i mniejsze kafelki „Według miejsca”. */
  function catList(){ return Object.keys(S.cat).map(function(id){ return Object.assign({id:id}, S.cat[id]); }); }
  function findCat(code){
    var c = String(code || "").toUpperCase(); if (S.cat[c]) return c;
    var hit = Object.keys(S.cat).find(function(id){ return (S.cat[id].c || []).indexOf(c) >= 0; }); return hit || null;
  }
  function dThumb(e){ return e && e.p ? '<img class="thumb" src="' + esc(INW_BLOB(e.p)) + '" data-blob="' + esc(e.p) + '" alt="" loading="lazy">' : '<span class="thumb ph">' + IC.item + '</span>'; }
  function availTxt(e){ return e.a > 0 ? (e.q > 1 ? "dostępne " + e.a + " z " + e.q : "dostępne") : "teraz niedostępne"; }
  var NOROOM = "Bez pomieszczenia", NOCAT_D = "Bez kategorii";
  function roomOf(e){ return e.r || NOROOM; }
  function catOf(e){ return e.k || NOCAT_D; }
  function locTxt(e, withRoom){ return [withRoom ? e.r : "", e.b ? "pudło: " + e.b : ""].filter(Boolean).join(" · "); }
  function inCart(id){ return S.dcart.find(function(x){ return x.itemId === id; }); }

  // Rzeczy numerowane („Namiot NS 4-osobowy nr 1”, „nr 2”, „nr 3”) to dla drużynowego jedna pozycja: „dostępne 2 z 3”.
  // Łączymy tylko pojedyncze sztuki o tej samej nazwie i kategorii, gdy w spisie są co najmniej dwie.
  var FAM_RE = /^(.*\S)[\s,]*(?:nr\.?|no\.?|#)\s*(\d+)$/i;
  function famsOf(all){
    var by = new Map(), out = {};
    all.forEach(function(e){
      var m = e.q === 1 ? FAM_RE.exec(String(e.n || "").trim()) : null; if (!m) return;
      var base = m[1].replace(/[\s,–-]+$/, ""), key = catOf(e) + "|" + norm(base);
      if (!by.has(key)) by.set(key, []); by.get(key).push({id:e.id, base:base, num:+m[2]});
    });
    by.forEach(function(l, key){ if (l.length > 1) l.forEach(function(x){ out[x.id] = {key:key, base:l[0].base, num:x.num}; }); });
    return out;
  }
  function entriesOf(list, fams){
    var out = [], fm = new Map();
    list.forEach(function(e){
      var f = fams[e.id];
      if (!f){ out.push({id:e.id, n:e.n, k:e.k, q:e.q, a:e.a, items:[e]}); return; }
      var d = fm.get(f.key);
      if (!d){ d = {id:"f:" + f.key, fam:f.key, n:f.base, k:e.k, q:0, a:0, items:[]}; fm.set(f.key, d); out.push(d); }
      d.items.push(e); d.q++; if (e.a > 0) d.a++;
    });
    return out.map(function(d){
      if (!d.fam) return d;
      if (d.items.length === 1){ var e = d.items[0]; return {id:e.id, n:e.n, k:e.k, q:e.q, a:e.a, items:[e]}; }
      d.items.sort(function(x, y){ return fams[x.id].num - fams[y.id].num; }); return d;
    });
  }
  function byAvail(a, b){ return (b.a > 0) - (a.a > 0) || a.n.localeCompare(b.n, "pl", {numeric:true}); }
  function catOrder(){ var cl = typeof catsList === "function" ? catsList() : []; return function(name){ if (name === NOCAT_D) return 1e6; var i = cl.indexOf(name); return i >= 0 ? i : 500; }; }
  function byCat(E){
    var m = new Map(), ord = catOrder();
    E.forEach(function(d){ var k = catOf(d); if (!m.has(k)) m.set(k, []); m.get(k).push(d); });
    return Array.from(m.entries()).map(function(p){ return {name:p[0], o:ord(p[0]), list:p[1]}; })
      .sort(function(a, b){ return a.o - b.o || a.name.localeCompare(b.name, "pl", {numeric:true}); });
  }
  // dostępność grupy: ile pozycji ma coś wolnego, a pasek pokazuje, jaka część sztuk leży teraz w magazynie
  function avOf(E){
    var t = E.length, a = 0, full = 0, fr = 0;
    E.forEach(function(d){ if (d.a > 0) a++; if (d.a >= d.q) full++; fr += d.q > 0 ? Math.min(1, Math.max(0, d.a / d.q)) : 0; });
    return {t:t, a:a, full:full, fr:t ? fr / t : 0};
  }
  function avLine(s){
    if (!s.t) return "pusto";
    if (s.full === s.t) return s.t === 1 ? "dostępne" : "wszystko dostępne";
    if (!s.a) return "teraz wszystko zajęte";
    return "dostępne <b>" + s.a + "</b> z " + s.t + (s.a === s.t ? ", część wydana" : "");
  }
  function avBar(s){ return '<span class="dk-bar" aria-hidden="true"><i style="width:' + Math.round(s.fr * 100) + '%"></i></span>'; }
  var CIC = (function(){
    var s = function(d){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; };
    return {
      tent: s('<path d="M12 4.5 3 19.5h18L12 4.5Z"/><path d="M9 19.5 12 14l3 5.5"/>'),
      pot: s('<path d="M5 10.5h14v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6Z"/><path d="M3 10.5h18M10 4.5c-.8.9-.8 1.9 0 2.8M14 4.5c-.8.9-.8 1.9 0 2.8"/>'),
      axe: s('<path d="M5 20 14 11"/><path d="M12 6.5 15 3.5c2.6 1.1 4.4 2.9 5.5 5.5l-3 3c-.6-2.3-2.2-4-5.5-5.5Z"/>'),
      tool: s('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z"/>'),
      plug: s('<path d="M9 3.5v4.5M15 3.5v4.5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8ZM12 17v3.5"/>'),
      flag: s('<path d="M5.5 21V4M5.5 4.5h12l-2.5 4 2.5 4h-12"/>'),
      chair: s('<path d="M7.5 3.5v9M16.5 3.5v9M7.5 7.5h9M5.5 12.5h13M7 12.5 6 20.5M17 12.5l1 8"/>'),
      aid: s('<rect x="3.5" y="7" width="17" height="12.5" rx="2"/><path d="M9 7V4.5h6V7M12 10.5v6M9 13.5h6"/>')
    };
  })();
  function catIcon(name){
    var n = norm(name);
    if (/biwak|namiot|nocleg|span/.test(n)) return CIC.tent;
    if (/kuch|gotow|garn/.test(n)) return CIC.pot;
    if (/pionier|siekier/.test(n)) return CIC.axe;
    if (/narzedz|warszt/.test(n)) return CIC.tool;
    if (/elektr|naglos|audio|multimed/.test(n)) return CIC.plug;
    if (/program|gry|zabaw|szkolen/.test(n)) return CIC.flag;
    if (/mebl|wyposaz/.test(n)) return CIC.chair;
    if (/pomoc|apteczk|medyc|ratown/.test(n)) return CIC.aid;
    return IC.box;
  }
  function dHref(kind, v){ return "#" + kind + (v != null ? "/" + encodeURIComponent(v) : ""); }
  function dRoute(h){
    if (h === "wszystko") return {t:"all"};
    if (h.indexOf("kategoria/") === 0) return {t:"cat", v:h.slice(10)};
    if (h.indexOf("miejsce/") === 0) return {t:"room", v:h.slice(8)};
    return null;
  }

  function dRow(e, scope){
    var c = inCart(e.id), loc = scope.t === "room" ? (e.b ? "pudło: " + e.b : "") : locTxt(e, true);
    var btn = '<button type="button" class="cart-btn' + (c ? " on" : "") + '" data-act="d-add" data-id="' + e.id + '" aria-label="' + (c ? "We wniosku, zmień" : "Dodaj do wniosku") + ': ' + esc(e.n) + '">' + (c ? (e.q > 1 ? '<span class="cq">×' + c.qty + '</span>' : IC.check) : IC.plus) + '</button>';
    return '<div class="row-wrap' + (e.a > 0 ? "" : " dk-na") + '"><button type="button" class="row" data-act="d-item" data-id="' + e.id + '">' + dThumb(e) + '<div class="row-main"><div class="row-title">' + esc(e.n) + '</div><div class="row-sub"><span class="chip ' + (e.a > 0 ? "ok" : "mute") + '">' + availTxt(e) + '</span>' + (loc ? ' <span class="d-loc">' + esc(loc) + '</span>' : "") + '</div></div></button>' + btn + '</div>';
  }
  function dRowE(d, scope){
    if (!d.fam) return dRow(d.items[0], scope);
    var nc = d.items.filter(function(e){ return inCart(e.id); }).length;
    var rooms = d.items.map(roomOf).filter(function(r, i, a){ return a.indexOf(r) === i; });
    var loc = scope.t === "room" ? "" : rooms.length === 1 ? rooms[0] : "w " + rooms.length + " miejscach";
    var p = d.items.find(function(e){ return e.p; }), room = scope.t === "room" ? ' data-r="' + esc(scope.v) + '"' : "";
    var chip = d.a > 0 ? "dostępne " + d.a + " z " + d.q : "teraz niedostępne";
    return '<div class="row-wrap' + (d.a > 0 ? "" : " dk-na") + '"><button type="button" class="row" data-act="d-fam" data-f="' + esc(d.fam) + '"' + room + '>' + dThumb(p) + '<div class="row-main"><div class="row-title">' + esc(d.n) + ' <span class="dk-szt">' + d.q + ' szt.</span></div><div class="row-sub"><span class="chip ' + (d.a > 0 ? "ok" : "mute") + '">' + chip + '</span>' + (loc ? ' <span class="d-loc">' + esc(loc) + '</span>' : "") + '</div></div></button>'
      + '<button type="button" class="cart-btn' + (nc ? " on" : "") + '" data-act="d-fam" data-f="' + esc(d.fam) + '"' + room + ' aria-label="' + (nc ? "We wniosku, zmień" : "Dodaj do wniosku") + ': ' + esc(d.n) + '">' + (nc ? '<span class="cq">×' + nc + '</span>' : IC.plus) + '</button></div>';
  }

  function renderDruz(){
    S.pendingRender = false;
    var h = decodeURIComponent(location.hash.replace(/^#/, "")), cur = h === "wnioski" ? "wnioski" : "home";
    $$("#tabs [data-tab]").forEach(function(t){ t.dataset.tab === cur ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current"); });
    var q = !!S.q.trim(), scope = cur === "home" ? dRoute(h) : null;
    // przycisk „Wróć” w miejscu logo, gdy jesteśmy w kategorii, w miejscu albo w wynikach wyszukiwania
    var sub = q || !!scope, bb = $("#back-btn"), br = $("#brand"); if (bb) bb.hidden = !sub; if (br) br.hidden = sub;
    updateCartBar();
    var html;
    if (!S.got.catalog || !S.got.myrequests) html = loadingView();
    else if (cur === "wnioski" && !q) html = viewMyRequests();
    else html = viewCatalog(scope, h && cur === "home" && !scope ? findCat(h) : null);
    $("#main").innerHTML = html;
  }
  function viewCatalog(scope, focusId){
    var all = catList(), fams = famsOf(all);
    if (focusId){ history.replaceState(null, "", location.pathname + location.search); setTimeout(function(){ dItem(focusId); }, 0); }
    if (!all.length) return '<div class="head"><div class="head-text"><div class="eyebrow">Sprzęt hufca</div><h1>Co jest w magazynie</h1></div></div><div class="empty"><h2>Spis jest jeszcze pusty</h2><p>Biuro hufca jeszcze nie dodało sprzętu.</p></div>';
    if (S.q.trim()) return dList({t:"q"}, all, fams);
    if (scope) return dList(scope, all, fams);
    return dHome(all, fams);
  }
  function dHome(all, fams){
    var E = entriesOf(all, fams), st = avOf(E);
    var html = '<div class="head"><div class="head-text"><div class="eyebrow">Sprzęt hufca</div><h1>Co jest w magazynie</h1></div></div>'
      + '<p class="hint dk-hint">Wybierz kategorię albo wpisz nazwę w wyszukiwarce u góry. Rzeczy dodajesz do wniosku przyciskiem +.</p>'
      + '<a class="dk-all" href="#wszystko"><span class="dk-ic">' + IC.list + '</span><span class="dk-t"><span class="dk-name">Cały sprzęt</span><span class="dk-av">' + avLine(st) + '</span>' + avBar(st) + '</span>' + IC.chev + '</a>';
    if (all.some(function(e){ return e.k; })){
      html += '<section class="sec"><div class="sec-head"><h2 class="sec-title">Kategorie</h2></div><div class="dk-grid">' + byCat(E).map(function(g){
        var s = avOf(g.list);
        return '<a class="dk-tile' + (s.a ? "" : " dk-none") + '" href="' + dHref("kategoria", g.name) + '"><span class="dk-ic">' + catIcon(g.name) + '</span><span class="dk-name">' + esc(g.name) + '</span><span class="dk-av">' + avLine(s) + '</span>' + avBar(s) + '</a>';
      }).join("") + '</div></section>';
    }
    // gdzie co leży: na drugim planie, mniejsze kafelki
    var rm = new Map();
    all.forEach(function(e){ var k = roomOf(e); if (!rm.has(k)) rm.set(k, {name:k, o:e.r ? (typeof e.ro === "number" ? e.ro : 999) : 1e6, items:[]}); rm.get(k).items.push(e); });
    var rooms = Array.from(rm.values()).sort(function(a, b){ return a.o - b.o || a.name.localeCompare(b.name, "pl", {numeric:true}); });
    if (rooms.length > 1 || !all.some(function(e){ return e.k; })){
      html += '<section class="sec"><div class="sec-head"><h2 class="sec-title">Według miejsca</h2></div><div class="dk-places">' + rooms.map(function(g){
        var n = entriesOf(g.items, fams).length;
        return '<a class="dk-place" href="' + dHref("miejsce", g.name) + '"><span class="dk-pn">' + esc(g.name) + '</span><span class="dk-pc">' + n + '</span></a>';
      }).join("") + '</div></section>';
    }
    return html;
  }
  function dList(scope, all, fams){
    var q = S.q.trim(), n = norm(q), cq = q.toUpperCase().replace(/[\s\-]/g, ""), items = all;
    if (scope.t === "cat") items = items.filter(function(e){ return catOf(e) === scope.v; });
    if (scope.t === "room") items = items.filter(function(e){ return roomOf(e) === scope.v; });
    if (n) items = items.filter(function(e){ return [e.n, e.b, e.k, e.r].some(function(v){ return norm(v || "").indexOf(n) >= 0; }) || (cq.length >= 3 && [e.id].concat(e.c || []).some(function(c){ return c.indexOf(cq) >= 0; })); });
    var E = entriesOf(items, fams), av = E.filter(function(d){ return d.a > 0; }).length;
    var shown = (S.dOnlyAvail ? E.filter(function(d){ return d.a > 0; }) : E).sort(byAvail);
    var eyebrow = scope.t === "cat" ? "Kategoria" : scope.t === "room" ? "Miejsce" : scope.t === "q" ? "Wyszukiwanie" : "Sprzęt hufca";
    var title = scope.t === "q" ? "Wyniki: " + q : scope.t === "all" ? "Cały sprzęt" : scope.v;
    var html = '<div class="head"><div class="head-text"><div class="eyebrow">' + eyebrow + '</div><h1>' + esc(title) + '</h1></div></div>';
    if (!E.length) return html + '<div class="empty"><h2>Nic nie pasuje</h2><p>' + (q ? "Spróbuj innej nazwy albo krótszego słowa." : "Tu nie ma jeszcze żadnego sprzętu.") + '</p><div class="actions"><a class="btn" href="#">Wszystkie kategorie</a></div></div>';
    html += '<div class="seg dk-seg" role="group" aria-label="Co pokazać"><button type="button" data-act="d-only" data-f="0" aria-pressed="' + !S.dOnlyAvail + '">Wszystko <span class="d-n">' + E.length + '</span></button><button type="button" data-act="d-only" data-f="1" aria-pressed="' + S.dOnlyAvail + '">Dostępne teraz <span class="d-n">' + av + '</span></button></div>';
    if (!shown.length) return html + '<div class="empty"><h2>Teraz nic tu nie jest wolne</h2><p>Wszystko jest wydane albo w naprawie. Możesz wysłać wniosek na późniejszy termin, biuro sprawdzi dostępność.</p><div class="actions"><button type="button" class="btn" data-act="d-only" data-f="0">Pokaż wszystko</button></div></div>';
    if (scope.t === "cat") return html + '<div class="list">' + shown.map(function(d){ return dRowE(d, scope); }).join("") + '</div>';
    var groups = byCat(shown);
    if (groups.length === 1) return html + '<div class="list">' + shown.map(function(d){ return dRowE(d, scope); }).join("") + '</div>';
    return html + groups.map(function(g){
      return '<section class="sec dk-sec"><div class="sec-head"><h2 class="sec-title">' + esc(g.name) + '<span class="n">' + g.list.length + '</span></h2></div><div class="list">' + g.list.map(function(d){ return dRowE(d, scope); }).join("") + '</div></section>';
    }).join("");
  }
  // rodzina numerowanych sztuk: drużynowy mówi, ile potrzebuje, a do wniosku trafiają najpierw wolne sztuki
  function dFam(key, room){
    var all = catList(), fams = famsOf(all);
    var M = all.filter(function(e){ return fams[e.id] && fams[e.id].key === key && (!room || roomOf(e) === room); }).sort(function(x, y){ return fams[x.id].num - fams[y.id].num; });
    if (!M.length) return;
    if (M.length === 1) return dItem(M[0].id);
    var base = fams[M[0].id].base, free = M.filter(function(e){ return e.a > 0; }), had = M.filter(function(e){ return inCart(e.id); }), p = M.find(function(e){ return e.p; });
    var mem = M.map(function(e){ return '<li><span class="dk-mn">nr ' + fams[e.id].num + '</span><span class="chip ' + (e.a > 0 ? "ok" : "mute") + '">' + (e.a > 0 ? "dostępny" : "teraz niedostępny") + '</span><span class="d-loc">' + esc(locTxt(e, true) || "—") + '</span></li>'; }).join("");
    openSheet(base, '<form class="f" novalidate>'
      + (p ? '<img class="d-photo" src="' + esc(INW_BLOB(p.p)) + '" data-blob="' + esc(p.p) + '" alt="">' : "")
      + '<p><span class="chip ' + (free.length ? "ok" : "mute") + '">' + (free.length ? "dostępne " + free.length + " z " + M.length : "teraz niedostępne") + '</span></p>'
      + (M[0].k ? '<p class="d-where"><b>Kategoria:</b> ' + esc(M[0].k) + '</p>' : "")
      + (!free.length ? '<p class="hint">Teraz wszystkie sztuki są wydane albo w naprawie. Możesz o nie poprosić na późniejszy termin, biuro sprawdzi dostępność.</p>' : "")
      + '<div class="field"><label for="d-qty">Ile sztuk potrzebujesz?</label><input id="d-qty" class="inp qty-in" type="number" inputmode="numeric" min="1" max="' + M.length + '" value="' + (had.length || 1) + '"><p class="hint" id="d-qh"></p></div>'
      + '<details class="dk-fam"><summary>Które sztuki i gdzie leżą</summary><ul class="dk-mem">' + mem + '</ul></details>'
      + '<div class="form-actions">' + (had.length ? '<button type="button" class="btn btn-ghost btn-danger" data-x="rm">Usuń z wniosku</button>' : "") + '<span class="spacer"></span><button type="button" class="btn" data-act="close-sheet">Zamknij</button><button type="submit" class="btn btn-primary">' + (had.length ? "Zapisz" : "Dodaj do wniosku") + '</button></div></form>', function(w){
      var f = $("form", w), qi = $("#d-qty", w), qh = $("#d-qh", w);
      var fl = free.length, upd = function(){ var v = clampInt(qi.value, 1, M.length); qh.textContent = v > fl ? (fl ? "Teraz " + pl(fl, "wolna jest", "wolne są", "wolnych jest") + " " + fl + " szt." : "Teraz żadna nie jest wolna.") + " Biuro sprawdzi, czy na Twój termin starczy." : ""; };
      qi.addEventListener("input", upd); upd();
      var ids = M.map(function(e){ return e.id; }), drop = function(){ S.dcart = S.dcart.filter(function(x){ return ids.indexOf(x.itemId) < 0; }); };
      var rm = $('[data-x="rm"]', w);
      if (rm) rm.addEventListener("click", function(){ drop(); saveDcart(); closeSheet(); render(); toast("Usunięto z wniosku: " + base); });
      f.addEventListener("submit", function(ev){
        ev.preventDefault();
        var qty = clampInt(qi.value, 1, M.length), rank = function(e){ return (e.a > 0 ? 0 : 2) + (inCart(e.id) ? 0 : 1); };
        var pick = M.slice().sort(function(x, y){ return rank(x) - rank(y) || fams[x.id].num - fams[y.id].num; }).slice(0, qty);
        drop(); pick.forEach(function(e){ S.dcart.push({itemId:e.id, qty:1}); });
        saveDcart(); closeSheet(); render(); toast(had.length ? "Zapisano: " + base + " ×" + qty : "Dodano do wniosku: " + base + (qty > 1 ? " ×" + qty : ""));
      });
    }, {noFocus:true});
  }
  function dItem(id){
    var e = S.cat[id]; if (!e) return;
    var c = S.dcart.find(function(x){ return x.itemId === id; });
    openSheet(e.n, '<form class="f" novalidate>'
      + (e.p ? '<img class="d-photo" src="' + esc(INW_BLOB(e.p)) + '" data-blob="' + esc(e.p) + '" alt="">' : "")
      + '<p><span class="chip ' + (e.a > 0 ? "ok" : "mute") + '">' + availTxt(e) + '</span></p>'
      + (e.r || e.b ? '<p class="d-where"><b>Gdzie leży:</b> ' + esc(locTxt(e, true)) + '</p>' : "")
      + (e.k ? '<p class="d-where"><b>Kategoria:</b> ' + esc(e.k) + '</p>' : "")
      + (e.a <= 0 ? '<p class="hint">Teraz wszystko jest wydane albo w naprawie. Możesz o to poprosić na późniejszy termin, biuro sprawdzi dostępność.</p>' : "")
      + (e.q > 1 ? '<div class="field"><label for="d-qty">Ile sztuk potrzebujesz?</label><input id="d-qty" class="inp qty-in" type="number" inputmode="numeric" min="1" max="' + e.q + '" value="' + (c ? c.qty : 1) + '"><p class="hint" id="d-qh"></p></div>' : "")
      + '<div class="form-actions">' + (c ? '<button type="button" class="btn btn-ghost btn-danger" data-act="d-rm" data-id="' + id + '">Usuń z wniosku</button>' : "") + '<span class="spacer"></span><button type="button" class="btn" data-act="close-sheet">Zamknij</button><button type="submit" class="btn btn-primary">' + (c ? "Zapisz" : "Dodaj do wniosku") + '</button></div></form>', function(w){
      var f = $("form", w), qi = $("#d-qty", w), qh = $("#d-qh", w);
      var upd = function(){ if (!qi || !qh) return; var v = clampInt(qi.value, 1, e.q); qh.textContent = v > e.a ? "Teraz wolnych jest " + e.a + " szt. Biuro sprawdzi, czy na Twój termin starczy." : ""; };
      if (qi){ qi.addEventListener("input", upd); upd(); }
      f.addEventListener("submit", function(ev){
        ev.preventDefault();
        var qty = qi ? clampInt(qi.value, 1, e.q) : 1, cur = S.dcart.find(function(x){ return x.itemId === id; });
        if (cur) cur.qty = qty; else S.dcart.push({itemId:id, qty:qty});
        saveDcart(); closeSheet(); render(); toast(cur ? "Zapisano ilość." : "Dodano do wniosku: " + e.n);
      });
    }, {noFocus:true});
  }
  function dCart(){
    var rows = function(){ var l = S.dcart.filter(function(c){ return S.cat[c.itemId]; }); return l.length ? l.map(function(c){ var e = S.cat[c.itemId]; return '<div class="lrow"><div class="lrow-top"><div class="lrow-main"><div class="row-title">' + esc(e.n) + '</div><div class="row-sub">' + esc([availTxt(e), locTxt(e, true)].filter(Boolean).join(" · ")) + '</div></div>' + (e.q > 1 ? '<input class="inp qty-in" type="number" inputmode="numeric" min="1" max="' + e.q + '" value="' + c.qty + '" data-dq="' + c.itemId + '" aria-label="Ile sztuk: ' + esc(e.n) + '">' : "") + '<button type="button" class="icon-btn" data-act="d-rm" data-id="' + c.itemId + '" data-keep="1" aria-label="Usuń: ' + esc(e.n) + '">' + IC.x + '</button></div></div>'; }).join("") : '<p class="muted">Wniosek jest pusty. Dodaj rzeczy przyciskiem + na liście sprzętu.</p>'; };
    openSheet("Twój wniosek", '<div class="f"><div class="lrows" id="dc-rows">' + rows() + '</div><div class="form-actions"><span class="spacer"></span><button type="button" class="btn" data-act="close-sheet">Dobierz jeszcze</button><button type="button" class="btn btn-primary" data-act="d-send">Dalej</button></div></div>', function(w){
      $(".f", w).addEventListener("change", function(ev){ var t = ev.target; if (!t.dataset || !t.dataset.dq) return; var c = S.dcart.find(function(x){ return x.itemId === t.dataset.dq; }), e = S.cat[t.dataset.dq]; if (!c || !e) return; c.qty = clampInt(t.value, 1, e.q); t.value = c.qty; saveDcart(); });
      w.refreshRows = function(){ var r = $("#dc-rows", w); if (r) r.innerHTML = rows(); };
    }, {noFocus:true});
  }
  function dDraft(){ try { return JSON.parse(localStorage.getItem("inwh-dreq") || "{}") || {}; } catch (_){ return {}; } }
  function dSend(){
    var list = S.dcart.filter(function(c){ return S.cat[c.itemId]; });
    if (!list.length){ toast("Najpierw dodaj rzeczy do wniosku."); return; }
    var d = dDraft(), today = todayYMD(), units = unitsList();
    var unitOpts = '<option value="">— wybierz —</option>' + units.map(function(u){ return '<option' + (d.unit === u ? " selected" : "") + '>' + esc(u) + '</option>'; }).join("") + '<option value="' + esc(PERSONAL) + '"' + (d.unit === PERSONAL ? " selected" : "") + '>' + esc(PERSONAL) + '</option>';
    openSheet("Wniosek o sprzęt", '<form class="f" novalidate>'
      + '<ul class="req-items">' + list.map(function(c){ var e = S.cat[c.itemId]; return '<li><span>' + esc(e.n) + (c.qty > 1 ? ' <span class="qty">×' + c.qty + '</span>' : "") + '</span><span class="' + (e.a >= c.qty ? "t-ok" : "t-late") + '">' + (e.a >= c.qty ? "dostępne teraz" : e.a > 0 ? "teraz wolne " + e.a : "teraz niedostępne") + '</span></li>'; }).join("") + '</ul>'
      + '<div class="field"><label for="dq-unit">Jednostka</label><select id="dq-unit">' + unitOpts + '</select></div>'
      + '<div class="grid2"><div class="field"><label for="dq-name">Kto odbiera</label><input id="dq-name" maxlength="60" value="' + esc(d.name || ACC().name) + '"></div><div class="field"><label for="dq-phone">Telefon <span class="opt">(opcjonalnie)</span></label><input id="dq-phone" type="tel" inputmode="tel" maxlength="20" value="' + esc(d.phone || "") + '"></div></div>'
      + '<div class="grid2"><div class="field"><label for="dq-from">Odbiór</label><input id="dq-from" type="date" min="' + today + '" value="' + esc(d.from && d.from >= today ? d.from : "") + '"></div><div class="field"><label for="dq-to">Zwrot do</label><input id="dq-to" type="date" min="' + today + '" value="' + esc(d.to && d.to >= today ? d.to : "") + '"></div></div>'
      + '<div class="field"><label for="dq-purpose">Na co <span class="opt">(opcjonalnie)</span></label><input id="dq-purpose" maxlength="120" placeholder="np. biwak drużyny" value="' + esc(d.purpose || "") + '"></div>'
      + '<div class="field"><label for="dq-note">Uwagi <span class="opt">(opcjonalnie)</span></label><textarea id="dq-note" rows="2" maxlength="500">' + esc(d.note || "") + '</textarea></div>'
      + '<div class="form-actions"><button type="button" class="btn" data-act="d-cart">Zmień rzeczy</button><span class="spacer"></span><button type="submit" class="btn btn-primary">Wyślij wniosek</button></div></form>', function(w){
      var f = $("form", w), from = $("#dq-from", w), to = $("#dq-to", w);
      var save = function(){ try { localStorage.setItem("inwh-dreq", JSON.stringify({unit:$("#dq-unit", w).value, name:$("#dq-name", w).value, phone:$("#dq-phone", w).value, from:from.value, to:to.value, purpose:$("#dq-purpose", w).value, note:$("#dq-note", w).value})); } catch (_){} };
      f.addEventListener("input", save); f.addEventListener("change", function(){ if (from.value) to.min = from.value; save(); });
      onSubmit(w, async function(){
        var unit = $("#dq-unit", w).value, name = $("#dq-name", w).value.trim(), fv = from.value, tv = to.value;
        if (!unit){ fieldErr(w, "#dq-unit", "Wybierz jednostkę."); return false; }
        if (!name){ fieldErr(w, "#dq-name", "Wpisz, kto odbiera."); return false; }
        if (!fv){ fieldErr(w, "#dq-from", "Podaj dzień odbioru."); return false; }
        if (!tv || tv < fv){ fieldErr(w, "#dq-to", "Podaj dzień zwrotu (nie wcześniej niż odbiór)."); return false; }
        var items = list.map(function(c){ return {itemId:c.itemId, itemName:S.cat[c.itemId].n, qty:c.qty}; });
        var personal = unit === PERSONAL, t = now();
        var docData = {source:"app", uid:ACC().uid, email:ACC().email, name:name, account:ACC().name, phone:$("#dq-phone", w).value.trim(), unit:personal ? "" : unit, personal:personal,
          items:items, what:items.map(function(x){ return x.itemName + (x.qty > 1 ? " ×" + x.qty : ""); }).join(", "), from:fv, to:tv,
          purpose:$("#dq-purpose", w).value.trim(), note:$("#dq-note", w).value.trim(), status:"nowy", at:t, updatedAt:t};
        await retry(function(){ return S.db.collection("requests").doc().set(docData); });
        S.dcart = []; saveDcart(); try { localStorage.removeItem("inwh-dreq"); } catch (_){}
        toast("Wysłano wniosek. Biuro hufca dostanie go w aplikacji.");
        setTimeout(function(){ go("wnioski"); }, 0);
        return true;
      });
    }, {noFocus:true});
  }
  function viewMyRequests(){
    var rs = S.myreq.slice().sort(function(a, b){ return String(b.at || "").localeCompare(String(a.at || "")); });
    var head = '<div class="head"><div class="head-text"><div class="eyebrow">Twoje prośby o sprzęt</div><h1>Moje wnioski</h1></div></div>';
    if (!rs.length) return head + '<div class="empty"><h2>Nie masz jeszcze wniosków</h2><p>Wybierz sprzęt w zakładce „Sprzęt” przyciskiem + i wyślij wniosek.</p><div class="actions"><a class="btn btn-primary" href="#">Przejdź do sprzętu</a></div></div>';
    return head + rs.map(function(r){
      var st = DSTATUS[r.status || "nowy"] || DSTATUS.nowy;
      var info = [];
      if (r.status === "zaplanowany") info.push("Przyjęty. Odbiór: " + fmtYMD(r.plannedPickup || r.from) + ((r.plannedDue || r.to) ? ", zwrot do " + fmtYMD(r.plannedDue || r.to) : "") + ".");
      if (r.status === "wydany") info.push("Sprzęt wydany" + (r.issuedAt ? " " + fmtDate(r.issuedAt) : "") + ".");
      if (r.status === "czesciowo") info.push("Sprzęt wydany" + (r.issuedAt ? " " + fmtDate(r.issuedAt) : "") + ". Część już wróciła do magazynu, reszta jest jeszcze u Was.");
      if (r.status === "zwrocony") info.push("Wszystko wróciło do magazynu" + (r.returnedAt ? " " + fmtDate(r.returnedAt) : "") + ". Dziękujemy!");
      if (r.status === "odrzucony") info.push("Biuro odrzuciło wniosek." + (r.reason ? " Powód: " + r.reason : ""));
      if (r.status === "nowy" || !r.status) info.push("Biuro hufca jeszcze go nie rozpatrzyło.");
      return '<section class="grp"><div class="grp-head"><div class="grp-who"><div class="who-big">' + esc(r.personal ? PERSONAL : (r.unit || "")) + '</div><p class="meta">' + esc(["termin " + rangeTxt(r.from, r.to), r.purpose ? "cel: " + r.purpose : "", r.at ? "wysłany " + fmtDate(r.at) : ""].filter(Boolean).join(" · ")) + '</p></div><span class="chip ' + st[0] + '">' + st[1] + '</span></div>'
        + '<ul class="req-items">' + (r.items || []).map(function(x){ return '<li><span>' + esc(x.itemName) + (x.qty > 1 ? ' <span class="qty">×' + x.qty + '</span>' : "") + '</span></li>'; }).join("") + '</ul>'
        + (r.status === "zaplanowany" && r.plannedItems && r.plannedItems !== r.what ? '<p class="meta">Przygotują: ' + esc(r.plannedItems) + '</p>' : "")
        + '<p class="meta">' + esc(info.join(" ")) + '</p>'
        + ((r.status || "nowy") === "nowy" ? '<div class="actions"><button type="button" class="btn btn-sm btn-ghost btn-danger" data-act="d-cancel" data-id="' + r.id + '">Anuluj wniosek</button></div>' : "")
        + '</section>';
    }).join("");
  }

  /* ---------- użytkownicy (admin) ---------- */
  var DATE = function(s){ try { return new Date(s).toLocaleDateString("pl-PL", {day:"numeric", month:"short", year:"numeric"}); } catch (_){ return ""; } };
  function roleSel(email, cur, dis){ return '<select class="u-role" data-email="' + esc(email) + '"' + (dis ? " disabled" : "") + ' aria-label="Rola: ' + esc(email) + '">' + ["druzynowy", "biuro", "admin"].map(function(r){ return '<option value="' + r + '"' + (r === cur ? " selected" : "") + '>' + ROLE_LBL[r] + '</option>'; }).join("") + '</select>'; }
  function userRows(){
    var me = ACC().email, byEmail = new Map(S.usersList.map(function(u){ return [String(u.email || "").toLowerCase(), u]; }));
    var q = norm(S.uq || ""), rows = Array.from(S.roles.entries()).map(function(p){ return Object.assign({email:p[0]}, p[1]); });
    if (q) rows = rows.filter(function(r){ var u = byEmail.get(r.email) || {}; return norm(r.email).indexOf(q) >= 0 || norm(u.name || r.name || "").indexOf(q) >= 0; });
    var order = {admin:0, biuro:1, druzynowy:2};
    rows.sort(function(a, b){ return (order[a.role] - order[b.role]) || a.email.localeCompare(b.email); });
    if (!rows.length) return '<p class="muted">Nikt nie pasuje.</p>';
    return rows.map(function(r){
      var u = byEmail.get(r.email), self = r.email === me;
      return '<div class="u-row"><div class="u-main"><div class="row-title">' + esc((u && u.name) || r.name || r.email.split("@")[0]) + (self ? ' <span class="chip mute">Ty</span>' : "") + '</div><div class="row-sub">' + esc(r.email) + ' · ' + (u && u.seen ? "ostatnio " + DATE(u.seen) : "jeszcze się nie logował(a)") + '</div></div>'
        + roleSel(r.email, r.role, self) + (self ? "" : '<button type="button" class="icon-btn" data-act="u-del" data-email="' + esc(r.email) + '" aria-label="Odbierz dostęp: ' + esc(r.email) + '">' + IC.x + '</button>') + '</div>';
    }).join("");
  }
  function viewUsers(){
    if (!S.got.roles || !S.got.access) return loadingView();
    var cnt = {admin:0, biuro:0, druzynowy:0}; S.roles.forEach(function(r){ if (cnt[r.role] != null) cnt[r.role]++; });
    var acc = S.config.get("access") || {};
    var pend = S.access.slice().sort(function(a, b){ return String(a.at).localeCompare(String(b.at)); });
    return '<div class="head"><div class="head-text"><div class="eyebrow">Tylko dla admina</div><h1>Użytkownicy</h1></div></div>'
      + (pend.length ? '<section class="sec"><div class="sec-head"><h2 class="sec-title">Prośby o dostęp<span class="n">' + pend.length + '</span></h2></div>' + pend.map(function(p){
          return '<div class="u-row pend"><div class="u-main"><div class="row-title">' + esc(p.name || p.email) + '</div><div class="row-sub">' + esc([p.email, p.unit, p.at ? DATE(p.at) : ""].filter(Boolean).join(" · ")) + '</div></div>' + roleSel(p.email, "druzynowy").replace('class="u-role"', 'class="u-prole" data-uid="' + esc(p.id) + '"') + '<button type="button" class="btn btn-sm btn-primary" data-act="u-approve" data-uid="' + esc(p.id) + '">Dodaj</button><button type="button" class="btn btn-sm btn-ghost" data-act="u-reject" data-uid="' + esc(p.id) + '">Odrzuć</button></div>';
        }).join("") + '</section>' : "")
      + '<section class="sec"><div class="sec-head"><h2 class="sec-title">Dodaj osoby</h2></div><div class="panel u-add">'
      + '<div class="field"><label for="u-mails">Maile</label><textarea id="u-mails" rows="3" placeholder="jeden w linii albo po przecinku; możesz wkleić kolumnę z Excela"></textarea></div>'
      + '<div class="field"><label for="u-newrole">Rola</label><select id="u-newrole"><option value="druzynowy">' + ROLE_LBL.druzynowy + '</option><option value="biuro">' + ROLE_LBL.biuro + '</option><option value="admin">' + ROLE_LBL.admin + '</option></select></div>'
      + '<div class="actions"><button type="button" class="btn btn-primary" data-act="u-add">Dodaj</button></div>'
      + '<p class="hint">Dodane osoby wchodzą na stronę, zakładają konto tym samym mailem (ustawiają własne hasło) i od razu mają dostęp. Jeśli ktoś jest już na liście, zmieni mu się rola.</p></div></section>'
      + '<section class="sec"><div class="sec-head"><h2 class="sec-title">Z dostępem<span class="n">' + S.roles.size + '</span></h2></div>'
      + '<p class="meta">admin: ' + cnt.admin + ' · biuro: ' + cnt.biuro + ' · drużynowi: ' + cnt.druzynowy + '</p>'
      + '<input id="u-q" class="inp" type="search" placeholder="Szukaj: mail albo nazwisko" value="' + esc(S.uq) + '" autocomplete="off" aria-label="Szukaj użytkownika">'
      + '<div class="u-list" id="u-list">' + userRows() + '</div></section>'
      + '<section class="sec"><div class="sec-head"><h2 class="sec-title">Ustawienia</h2></div><label class="chk"><input type="checkbox" id="u-biuro-add"' + (acc.biuroAddItems !== false ? " checked" : "") + '><span>Biuro może dodawać nowe rzeczy do spisu</span></label><p class="hint">Edytowanie i usuwanie rzeczy, pomieszczenia, import i etykiety zostają tylko dla admina.</p></section>';
  }
  async function usersAdd(){
    var txt = ($("#u-mails") || {}).value || "", r = ($("#u-newrole") || {}).value || "druzynowy";
    var mails = Array.from(new Set((txt.match(/[^\s,;<>"']+@[^\s,;<>"']+\.[^\s,;<>"']+/g) || []).map(function(m){ return m.toLowerCase(); })));
    if (!mails.length){ toast("Wklej co najmniej jeden adres e-mail.", "err"); return; }
    var added = 0, changed = 0, me = ACC().email;
    for (var k = 0; k < mails.length; k++){
      var m = mails[k]; if (m === me) continue;
      var cur = S.roles.get(m);
      try {
        if (cur){ if (cur.role !== r){ await retry(function(){ return S.db.doc("roles/" + m).update({role:r, changedAt:now(), changedBy:ACC().uid}); }); changed++; } }
        else { await retry(function(){ return S.db.doc("roles/" + m).set({role:r, name:"", addedAt:now(), addedBy:ACC().uid}); }); added++; }
        var p = S.access.find(function(a){ return String(a.email).toLowerCase() === m; }); if (p) await retry(function(){ return S.db.doc("access/" + p.id).delete(); });
      } catch (e){ handleErr(e); return; }
    }
    if (added || changed) logEv("users", "Nadano dostęp: " + mails.length + " " + pl(mails.length, "osoba", "osoby", "osób") + " (" + ROLE_LBL[r] + ")", {d:mails.join(", ")});
    var ta = $("#u-mails"); if (ta) ta.value = "";
    toast("Dodano: " + added + (changed ? ", zmieniono rolę: " + changed : "") + ".");
    render();
  }

  /* ---------- aplikacja na telefonie (iPhone i Android) ---------- */
  var installEvt = null;
  window.addEventListener("beforeinstallprompt", function(e){ e.preventDefault(); installEvt = e; scheduleRender(); });
  window.addEventListener("appinstalled", function(){ installEvt = null; try { localStorage.setItem("inwh-install-x", "1"); } catch (_){} toast("Gotowe: Wypożyczalnia jest na ekranie telefonu."); scheduleRender(); });
  function isStandalone(){ return window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches); }
  function isIOS(){ return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
  function isAndroid(){ return /Android/i.test(navigator.userAgent); }
  function appUrl(){ return location.origin + location.pathname.replace(/index\.html$/, ""); }
  var SHARE_IC = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style="vertical-align:-3px"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12M8 7l4-4 4 4M7 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
  var PHONE_IC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  function installSteps(){
    var ios = '<li>Otwórz ten adres w <b>Safari</b> (na iPhonie może być też Chrome).</li><li>Stuknij <b>Udostępnij</b> ' + SHARE_IC + ' na dole ekranu.</li><li>Wybierz <b>Do ekranu początkowego</b> i stuknij <b>Dodaj</b>.</li>';
    var and = '<li>Otwórz ten adres w <b>Chrome</b>.</li><li>Stuknij menu <b>⋮</b> w prawym górnym rogu.</li><li>Wybierz <b>Zainstaluj aplikację</b> (albo <b>Dodaj do ekranu głównego</b>).</li>';
    if (isIOS()) return '<p class="flabel">iPhone</p><ol class="ins-steps">' + ios + '</ol>';
    if (isAndroid()) return '<p class="flabel">Android</p><ol class="ins-steps">' + and + '</ol>';
    return '<p class="flabel">iPhone</p><ol class="ins-steps">' + ios + '</ol><p class="flabel">Android</p><ol class="ins-steps">' + and + '</ol>';
  }
  function installSheet(){
    var mobile = isIOS() || isAndroid();
    openSheet("Wypożyczalnia na telefonie", '<div class="f">'
      + '<p class="lead">Aplikacja trafia na ekran telefonu jak każda inna: otwiera się z ikony, na pełnym ekranie, i od razu jesteś zalogowany. Nic nie trzeba pobierać ze sklepu.</p>'
      + (mobile ? "" : '<div class="ins-qr">' + (typeof qrSvg === "function" ? qrSvg(appUrl()) : "") + '<div class="linkbox">' + esc(appUrl()) + '</div></div><p class="hint">Zeskanuj kod aparatem telefonu, otwórz stronę i dodaj ją do ekranu tak jak niżej. Ten kod możesz też pokazać albo wysłać drużynowym.</p>')
      + installSteps()
      + '<div class="form-actions"><button type="button" class="btn" data-act="inw-copy-link">Kopiuj link</button><span class="spacer"></span><button type="button" class="btn btn-primary" data-act="close-sheet">Gotowe</button></div></div>', null, {noFocus:true});
  }
  window.INW_INSTALL_HTML = function(){
    if (isStandalone()) return '<p class="hint">' + PHONE_IC.replace('<svg ', '<svg width="16" height="16" style="vertical-align:-3px" ') + ' Działa jako aplikacja z ekranu telefonu.</p>';
    return '<div class="actions"><button type="button" class="btn" data-act="inw-install">' + PHONE_IC.replace('<svg ', '<svg width="18" height="18" ') + '<span>' + (installEvt ? "Zainstaluj na tym urządzeniu" : "Aplikacja na telefonie") + '</span></button>' + (isStaff() ? '<button type="button" class="btn btn-ghost" data-act="inw-share">Link i kod QR dla drużynowych</button>' : "") + '</div>';
  };
  async function doInstall(){
    if (installEvt){ var e = installEvt; installEvt = null; try { e.prompt(); await e.userChoice; } catch (_){} scheduleRender(); return; }
    installSheet();
  }
  // pasek z zachętą: tylko na telefonie, poza zainstalowaną aplikacją i dopóki ktoś go nie zamknie
  function installStrip(){
    var dismissed = false; try { dismissed = localStorage.getItem("inwh-install-x") === "1"; } catch (_){}
    if (dismissed || isStandalone() || !(isIOS() || isAndroid() || installEvt)) return "";
    return '<div class="inw-install"><span class="ii-ic">' + PHONE_IC + '</span><span class="ii-t"><b>Dodaj Wypożyczalnię do ekranu</b>Będzie się otwierać z ikony, jak zwykła aplikacja.</span><button type="button" class="btn btn-sm btn-primary" data-act="inw-install">' + (installEvt ? "Zainstaluj" : "Jak?") + '</button><button type="button" class="icon-btn" data-act="inw-install-x" aria-label="Nie pokazuj więcej">' + IC.x + '</button></div>';
  }
  var _viewHome2 = viewHome;
  viewHome = function(){ var h = _viewHome2(); return ready() ? installStrip() + h : h; };
  var _viewCatalog = viewCatalog;
  viewCatalog = function(scope, focusId){ return (scope || S.q.trim() ? "" : installStrip()) + _viewCatalog(scope, focusId); };

  /* ---------- kliknięcia i zmiany ---------- */
  document.addEventListener("click", function(e){
    var b = e.target.closest("[data-act]"); if (!b || !ACC()) return;
    var act = b.dataset.act, id = b.dataset.id;
    switch (act){
      case "inw-pass": closeSheet(); if (window.INW_PASS) window.INW_PASS(); break;
      case "inw-full": b.disabled = true; b.textContent = "Wczytuję…"; window.INW_FULL(); break;
      case "inw-install": closeSheet(); doInstall(); break;
      case "inw-share": closeSheet(); installSheet(); break;
      case "inw-copy-link": copyText(appUrl()); break;
      case "inw-install-x": try { localStorage.setItem("inwh-install-x", "1"); } catch (_){} render(); toast("Instrukcję znajdziesz zawsze pod przyciskiem konta (inicjały w rogu)."); break;
      case "inw-reqs": S.lentFilter = "requests"; go("wypozyczone"); break;
      case "d-only": S.dOnlyAvail = b.dataset.f === "1"; render(); break;
      case "d-fam": dFam(b.dataset.f, b.dataset.r || ""); break;
      case "d-item": dItem(id); break;
      case "d-add": { var e2 = S.cat[id]; if (!e2) break; var c = S.dcart.find(function(x){ return x.itemId === id; }); if (e2.q > 1) dItem(id); else if (c){ S.dcart = S.dcart.filter(function(x){ return x.itemId !== id; }); saveDcart(); render(); toast("Usunięto z wniosku: " + e2.n); } else { S.dcart.push({itemId:id, qty:1}); saveDcart(); render(); toast("Dodano do wniosku: " + e2.n); } break; }
      case "d-rm": { S.dcart = S.dcart.filter(function(x){ return x.itemId !== id; }); saveDcart(); if (b.dataset.keep){ var w = $("#sheet"); if (w && w.refreshRows) w.refreshRows(); else closeSheet(); } else closeSheet(); render(); break; }
      case "d-cart": dCart(); break;
      case "d-send": dSend(); break;
      case "d-cancel": (async function(){ b.disabled = true; try { await retry(function(){ return S.db.doc("requests/" + id).update({status:"anulowany", updatedAt:now()}); }); toast("Anulowano wniosek."); } catch (err){ b.disabled = false; handleErr(err); } })(); break;
      case "u-add": if (isAdmin()) usersAdd(); break;
      case "u-approve": (async function(){ var p = S.access.find(function(a){ return a.id === b.dataset.uid; }); if (!p) return; var sel = document.querySelector('.u-prole[data-uid="' + CSS.escape(p.id) + '"]'), r = sel ? sel.value : "druzynowy", m = String(p.email).toLowerCase(); b.disabled = true;
          try { await retry(function(){ return S.db.doc("roles/" + m).set({role:r, name:p.name || "", addedAt:now(), addedBy:ACC().uid}); }); await retry(function(){ return S.db.doc("access/" + p.id).delete(); }); logEv("users", "Nadano dostęp: " + m + " (" + ROLE_LBL[r] + ")", {}); toast("Dodano: " + (p.name || m)); } catch (err){ b.disabled = false; handleErr(err); } })(); break;
      case "u-reject": (async function(){ b.disabled = true; try { await retry(function(){ return S.db.doc("access/" + b.dataset.uid).delete(); }); toast("Odrzucono prośbę."); } catch (err){ b.disabled = false; handleErr(err); } })(); break;
      case "u-del": { var em = b.dataset.email; openSheet("Odebrać dostęp?", '<div class="f"><p class="lead">' + esc(em) + ' straci dostęp od razu, także jeśli jest teraz zalogowany. Konto zostaje, więc dostęp możesz później przywrócić.</p><div class="form-actions"><button type="button" class="btn" data-act="close-sheet">Anuluj</button><button type="button" class="btn btn-danger-solid" data-act="u-del-do" data-email="' + esc(em) + '">Odbierz dostęp</button></div></div>', null, {noFocus:true}); break; }
      case "u-del-do": (async function(){ var em = b.dataset.email; b.disabled = true; try { await retry(function(){ return S.db.doc("roles/" + em).delete(); }); logEv("users", "Odebrano dostęp: " + em, {}); closeSheet(); toast("Odebrano dostęp."); } catch (err){ b.disabled = false; handleErr(err); } })(); break;
    }
  });
  document.addEventListener("change", function(e){
    var t = e.target; if (!ACC() || !isAdmin()) return;
    if (t.classList && t.classList.contains("u-role")){
      var em = t.dataset.email, r = t.value, prev = (S.roles.get(em) || {}).role;
      (async function(){ try { await retry(function(){ return S.db.doc("roles/" + em).update({role:r, changedAt:now(), changedBy:ACC().uid}); }); logEv("users", "Zmieniono rolę: " + em + " (" + (ROLE_LBL[prev] || prev) + " → " + ROLE_LBL[r] + ")", {}); toast("Zmieniono rolę: " + em); } catch (err){ t.value = prev; handleErr(err); } })();
    }
    if (t.id === "u-biuro-add"){
      var v = t.checked;
      (async function(){ try { await retry(function(){ return S.db.doc("config/access").set(Object.assign({}, S.config.get("access") || {}, {biuroAddItems:v, updatedAt:now(), updatedBy:ACC().uid})); }); toast(v ? "Biuro może dodawać rzeczy." : "Biuro nie dodaje już rzeczy."); } catch (err){ t.checked = !v; handleErr(err); } })();
    }
  });
  document.addEventListener("input", function(e){
    if (e.target && e.target.id === "u-q"){ S.uq = e.target.value; var l = $("#u-list"); if (l) l.innerHTML = userRows(); }
  });
})();
