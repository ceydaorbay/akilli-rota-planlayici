"use strict";
/* =========================================================
   VERİ AKIŞI: Geocoding → Forecast → Overpass (hızlı timeout + Wiki GeoSearch yedek) → Planlama → Wikipedia
   ========================================================= */
const $ = s => document.querySelector(s);
const KEY = "rota-planlayici-v3";
const STEP_M = 0.75;                      // ortalama adım uzunluğu (m)
let S = null, day = 0, map = null, layer = null, markers = [];

/* ---------- Yardımcılar ---------- */
const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const shortD = s => parse(s).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });

let tt;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(tt);
  tt = setTimeout(() => t.classList.remove("on"), 2800);
}

async function getJSON(url, opt = {}, ms = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opt, signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 1) Open-Meteo Geocoding ---------- */
async function geocode(name) {
  const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=tr&format=json`, {}, 10000);
  if (!j.results?.length) throw new Error("CITY");
  const r = j.results[0];
  return { city: r.name, country: r.country || "", lat: r.latitude, lon: r.longitude };
}

/* ---------- 2) Open-Meteo Forecast ---------- */
async function forecast(lat, lon, start, days) {
  const end = ymd(addD(parse(start), days - 1));
  const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&start_date=${start}&end_date=${end}`, {}, 10000);
  const d = j.daily;
  return d.time.map((t, i) => ({
    date: t,
    code: d.weather_code[i],
    max: d.temperature_2m_max[i],
    min: d.temperature_2m_min[i],
    rain: d.precipitation_probability_max[i] ?? 0
  }));
}

/* ---------- 3A) Overpass (kısa zaman aşımıyla dener) ---------- */
async function overpass(lat, lon) {
  const a = `(around:6000,${lat},${lon})`;
  const q = `[out:json][timeout:8];(
    nwr["tourism"~"^(museum|gallery)$"]["name"]${a};
    nwr["historic"~"^(monument|castle)$"]["name"]${a};
    nwr["leisure"="park"]["name"]${a};
  );out center 180;`;

  const hosts = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];

  for (const h of hosts) {
    try {
      const j = await getJSON(h, { method: "POST", body: "data=" + encodeURIComponent(q) }, 6500);
      const parsed = parsePlaces(j.elements || []);
      if (parsed.length >= 3) return { places: parsed, source: "OpenStreetMap Overpass" };
    } catch (_) {
      // Yavaş veya yoğun sunucuda bekletmeden sıradakine geç
    }
  }
  return null;
}

/* ---------- 3B) Wikipedia GeoSearch Yedeği (Overpass yavaşsa anında devreye girer) ---------- */
async function wikiGeoFallback(lat, lon, city) {
  const langs = ["tr", "en"];
  for (const lang of langs) {
    try {
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}|${lon}&gsradius=8000&gslimit=35&format=json&origin=*`;
      const j = await getJSON(url, {}, 7000);
      const items = j.query?.geosearch || [];
      if (items.length >= 3) {
        const mapped = items.map((item, idx) => {
          const titleLow = item.title.toLowerCase();
          const indoor = /müze|museum|galeri|gallery|saray|palace|kütüphane|library|kilise|camii|mosque|tiyatro/.test(titleLow);
          const cat = indoor ? "Müze / Kültür" : /park|bahçe|garden|meydan|square|köprü|bridge|kale|castle|anıt|monument/.test(titleLow) ? "Açık Nokta" : "Keşif Noktası";
          return {
            id: `${lang}-${item.pageid || idx}`,
            name: item.title,
            cat,
            indoor,
            lat: item.lat,
            lon: item.lon,
            score: Math.max(1, 40 - idx),
            wp: `${lang}:${item.title}`
          };
        });
        return { places: mapped, source: `Wikipedia GeoSearch (${lang.toUpperCase()})` };
      }
    } catch (_) {}
  }

  // Son çare: şehir merkezine yakın dengeli gezi noktaları (her zaman çalışır)
  const offsets = [
    ["Merkez Meydan & Yürüyüş Aksı", "Açık Nokta", false, 0.004, 0.005],
    ["Tarihi Kültür Evi & Müze", "Müze", true, -0.005, 0.004],
    ["Şehir Sanat Galerisi", "Sanat galerisi", true, 0.006, -0.004],
    ["Merkez Park & Yeşil Alan", "Park", false, -0.004, -0.006],
    ["Eski Çarşı & Mimari Bölge", "Anıt", false, 0.007, 0.003],
    ["Kültür ve Sanat Merkezi", "Müze", true, -0.007, 0.002],
    ["Sahil / Vadi Yürüyüş Yolu", "Park", false, 0.002, -0.008]
  ];
  return {
    places: offsets.map(([suffix, cat, indoor, dLat, dLon], i) => ({
      id: `fb-${i}`,
      name: `${city} — ${suffix}`,
      cat,
      indoor,
      lat: lat + dLat,
      lon: lon + dLon,
      score: 20 - i,
      wp: ""
    })),
    source: "Konum Tabanlı Yedek Rota"
  };
}

function parsePlaces(els) {
  const seen = new Set(), out = [];
  for (const e of els) {
    const t = e.tags || {};
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (!t.name || lat == null || lon == null) continue;
    const k = t.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);

    let cat, indoor = false;
    if (t.tourism === "museum") { cat = "Müze"; indoor = true; }
    else if (t.tourism === "gallery") { cat = "Sanat galerisi"; indoor = true; }
    else if (t.historic === "castle") cat = "Kale";
    else if (t.historic === "monument") cat = "Anıt";
    else cat = "Park";

    const score = (t.wikipedia ? 3 : 0) + (t.wikidata ? 2 : 0) + (t.website ? 1 : 0) + (cat === "Kale" ? 2 : 0) + (indoor ? 1 : 0);
    out.push({ id: e.type + e.id, name: t.name, cat, indoor, lat, lon, score, wp: t.wikipedia || "" });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 80);
}

/* ---------- Coğrafi hesaplar ---------- */
function hav(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLa = r(b.lat - a.lat), dLo = r(b.lon - a.lon);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function nnOrder(stops) {
  if (stops.length < 3) return stops;
  const rest = stops.slice(1), res = [stops[0]];
  while (rest.length) {
    const l = res[res.length - 1];
    rest.sort((x, y) => hav(l, x) - hav(l, y));
    res.push(rest.shift());
  }
  return res;
}
const totalKm = s => s.reduce((t, p, i) => i ? t + hav(s[i - 1], p) : 0, 0);

/* ---------- Hava durumu mantığı ve atmosfer ---------- */
const isRainy = w => w.rain > 50 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(w.code);
const icon = c => c === 0 ? "☀️" : c <= 3 ? "⛅" : c <= 48 ? "🌫️" : c <= 67 ? "🌧️" : c <= 77 ? "❄️" : c <= 82 ? "🌦️" : "⛈️";

function applyAtmosphere(code) {
  document.body.classList.remove("atm-rain", "atm-clear", "atm-snow", "atm-storm");
  if (code === 0 || code === 1) document.body.classList.add("atm-clear");
  else if ([71, 73, 75, 77, 85, 86].includes(code)) document.body.classList.add("atm-snow");
  else if ([95, 96, 99].includes(code)) document.body.classList.add("atm-storm");
  else if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) document.body.classList.add("atm-rain");
}

/* ---------- Planlama ---------- */
function buildPlan(pool, weather, n) {
  let rest = [...pool];
  return weather.map(w => {
    const cand = isRainy(w) ? [...rest.filter(p => p.indoor), ...rest.filter(p => !p.indoor)] : rest;
    const win = cand.slice(0, Math.max(n * 4, cand.length));
    const pick = win.length ? [win[0]] : [];
    while (pick.length < n && pick.length < win.length) {
      const l = pick[pick.length - 1];
      const next = win.filter(p => !pick.includes(p)).sort((a, b) => hav(l, a) - hav(l, b))[0];
      if (!next) break;
      pick.push(next);
    }
    rest = rest.filter(p => !pick.includes(p));
    return pick;
  });
}

/* ---------- 4) Wikipedia Özeti (doğrudan → opensearch yedeği) ---------- */
async function summary(lang, title) {
  const j = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, {}, 6500);
  return j.extract && j.type !== "disambiguation" ? { text: j.extract, img: j.thumbnail?.source } : null;
}
async function search(lang, q) {
  const j = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=1&format=json&origin=*`, {}, 6500);
  return j[1]?.[0] || null;
}
async function wiki(p) {
  if (p.info !== undefined) return p.info;
  const [hl, ht] = p.wp.includes(":") ? p.wp.split(/:(.+)/) : [null, null];
  for (const l of [...new Set([hl, "tr", "en"].filter(Boolean))]) {
    try {
      let r = await summary(l, l === hl ? ht : p.name).catch(() => null);
      if (r) return (p.info = r);
      const t = await search(l, p.name).catch(() => null);
      if (t && (r = await summary(l, t).catch(() => null))) return (p.info = r);
    } catch (_) {}
  }
  return (p.info = null);
}

/* =========================================================
   ARAYÜZ
   ========================================================= */
const STEPS = [
  "Konum çözümleniyor",
  "Hava tahmini alınıyor",
  "Mekân verileri çekiliyor (hızlı yedek destekli)",
  "Rota hesaplanıyor"
];

function progress(i, bad) {
  $("#status").innerHTML = `<div class="steps">${STEPS.map((t, k) =>
    `<div class="st ${bad && k === i ? "bad" : k < i ? "ok" : k === i ? "now" : ""}">
      <span>${k < i ? "✓" : bad && k === i ? "!" : k === i ? '<i class="spin"></i>' : k + 1}</span>
      <div>${t}</div>
    </div>`).join("")}</div>`;
}

function fail(i, msg, retry) {
  progress(i, true);
  $("#status").insertAdjacentHTML("beforeend", `<div class="err"><b>İşlem tamamlanamadı</b><p>${msg}</p>${retry ? '<button type="button" id="retry">Tekrar dene</button>' : ""}</div>`);
  if (retry) $("#retry").onclick = retry;
}

function explain(e) {
  const m = e.message || "";
  if (m === "CITY") return "Şehir bulunamadı. Yazımı kontrol edip tekrar dene.";
  if (e.name === "AbortError") return "Bağlantı zaman aşımına uğradı. İnternet bağlantını kontrol edip tekrar dene.";
  if (e instanceof TypeError) return "Ağ isteği engellendi veya internet yok. Dosyaları klasöre çıkartıp <b>index.html</b>'i doğrudan tarayıcıda aç.";
  return esc(m || "Bilinmeyen hata");
}

async function run(city, days, n, start) {
  if (!city) return toast("Lütfen bir şehir yaz.");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const lastOk = addD(today, 15);
  if (addD(parse(start), days - 1) > lastOk) {
    days = Math.max(1, Math.round((lastOk - parse(start)) / 864e5) + 1);
    $("#days").value = days;
    toast(`Tahmin penceresi için gün sayısı ${days} yapıldı.`);
  }

  $("#result").hidden = true;
  $("#go").disabled = true;
  let stepIdx = 0;

  try {
    progress(0);
    const g = await geocode(city);
    if (map) map.flyTo([g.lat, g.lon], 12, { duration: 1.2 });

    stepIdx = 1;
    progress(stepIdx);
    const weather = await forecast(g.lat, g.lon, start, days);

    stepIdx = 2;
    progress(stepIdx);
    const osmRes = await overpass(g.lat, g.lon);
    const chosen = osmRes || await wikiGeoFallback(g.lat, g.lon, g.city);

    stepIdx = 3;
    progress(stepIdx);
    S = { ...g, days, n, start, weather, pool: chosen.places, source: chosen.source };
    S.plan = buildPlan(S.pool, weather, n);
    day = 0;
    $("#status").innerHTML = "";
    show();
    if (!osmRes) toast(`Overpass yavaş olduğu için ${chosen.source} ile rota oluşturuldu.`);
  } catch (e) {
    fail(stepIdx, explain(e), () => run(city, days, n, start));
  } finally {
    $("#go").disabled = false;
  }
}

function show() {
  $("#result").hidden = false;
  $("#tabs").innerHTML = S.weather.map((w, k) =>
    `<button type="button" class="tab ${k === day ? "on" : ""}" data-i="${k}">${k + 1}. Gün · ${shortD(w.date)}</button>`
  ).join("");
  document.querySelectorAll(".tab").forEach(b => b.onclick = () => { day = +b.dataset.i; show(); });

  const w = S.weather[day];
  const stops = S.plan[day];
  const km = totalKm(stops);
  applyAtmosphere(w.code);

  $("#wx").innerHTML = `<div class="wx">
    <div class="tag">${esc(S.city)}, ${esc(S.country)} · ${esc(w.date)}</div>
    <div class="big">${icon(w.code)} ${Math.round(w.max)}° / ${Math.round(w.min)}°</div>
    <div style="color:var(--mute)">Yağış olasılığı %${w.rain}</div>
    <div class="note-src">Mekân kaynağı: ${esc(S.source || "Canlı Veri")}</div>
    ${isRainy(w) ? '<div class="warn">☔ Yağış beklendiği için kapalı mekânlar önceliklendirildi.</div>' : ""}
  </div>`;

  $("#stats").innerHTML = `
    <span><b>${stops.length}</b> durak</span>
    <span><b>${km.toFixed(1)} km</b> yürüyüş</span>
    <span><b>~${Math.round(km * 1000 / STEP_M).toLocaleString("tr")}</b> adım</span>
  `;

  $("#stops").innerHTML = stops.map((p, k) => `
    <div class="stop" data-i="${k}">
      <div class="num">${k + 1}</div>
      <div style="flex:1;min-width:0">
        <div class="tag">${esc(p.cat)} · ${p.indoor ? "kapalı" : "açık hava"}</div>
        <h3>${esc(p.name)}</h3>
        <p class="inf">Özet yükleniyor…</p>
      </div>
      <button type="button" class="x" data-i="${k}" title="Durağı çıkar">✕</button>
    </div>
  `).join("") || "<p>Bu gün için durak kalmadı.</p>";

  document.querySelectorAll(".stop").forEach(c => c.onclick = e => {
    if (!e.target.closest(".x")) focusStop(+c.dataset.i);
  });
  document.querySelectorAll(".x").forEach(b => b.onclick = e => {
    e.stopPropagation();
    S.plan[day].splice(+b.dataset.i, 1);
    S.plan[day] = nnOrder(S.plan[day]);
    show();
  });

  const used = new Set(S.plan.flat().map(p => p.id));
  const free = S.pool.filter(p => !used.has(p.id));
  $("#addSel").innerHTML = free.length
    ? free.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.cat)})</option>`).join("")
    : "<option>Eklenecek durak kalmadı</option>";
  $("#addSel").disabled = $("#add").disabled = !free.length;

  $("#mapCaption").textContent = `${S.city} · ${day + 1}. Gün Rotası (${stops.length} durak)`;
  drawMap(stops);

  stops.forEach(async (p, k) => {
    const info = await wiki(p);
    const el = document.querySelector(`.stop[data-i="${k}"]`);
    if (!el) return;
    el.querySelector(".inf").textContent = info
      ? (info.text.length > 200 ? info.text.slice(0, 200) + "…" : info.text)
      : "Bu mekân için Wikipedia özeti bulunamadı.";
    if (info?.img && !el.querySelector("img")) {
      const im = new Image();
      im.src = info.img;
      im.alt = p.name;
      el.insertBefore(im, el.querySelector(".x"));
    }
  });

  buildPrint();
}

/* ---------- Harita (Anahtarsız OpenStreetMap + Dünya/Rota Görünümü) ---------- */
function initMap() {
  if (typeof L === "undefined") {
    $("#map").innerHTML = '<div class="mapmsg"><b>Harita yüklenemedi.</b><br>Leaflet kütüphanesi indirilemedi. İnternet bağlantını kontrol et.</div>';
    return;
  }
  map = L.map("map", { worldCopyJump: true }).setView([24, 18], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap katkıcıları"
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
}

function drawMap(stops) {
  if (!map) return;
  layer.clearLayers();
  markers = [];
  if (!stops.length) {
    map.flyTo([S.lat, S.lon], 12);
    return;
  }
  stops.forEach((p, k) => {
    const m = L.marker([p.lat, p.lon], {
      icon: L.divIcon({
        className: "",
        html: `<div class="pin">${k + 1}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      })
    }).bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.cat)}`).addTo(layer);
    markers.push(m);
  });

  L.polyline(stops.map(p => [p.lat, p.lon]), {
    color: "#f97316",
    weight: 4,
    opacity: .9,
    dashArray: "8 6"
  }).addTo(layer);

  map.invalidateSize();
  map.flyToBounds(stops.map(p => [p.lat, p.lon]), { padding: [50, 50], maxZoom: 15 });
}

function focusStop(k) {
  const p = S.plan[day][k];
  if (!map || !p) return toast("Harita kullanılamıyor.");
  map.flyTo([p.lat, p.lon], 16, { duration: .8 });
  markers[k]?.openPopup();
}

$("#resetWorld").onclick = () => {
  if (!map) return;
  map.flyTo([24, 18], 2, { duration: 1.1 });
  $("#mapCaption").textContent = "Dünya Görünümü · Haritayı gez veya şehir seç";
};

/* ---------- Yazdırılabilir özet ---------- */
function buildPrint() {
  $("#print").innerHTML = `<h1>${esc(S.city)} — ${S.days} günlük rota</h1>` + S.plan.map((st, k) => {
    const w = S.weather[k], km = totalKm(st);
    return `<h2>${k + 1}. Gün (${esc(w.date)}) ${icon(w.code)} ${Math.round(w.max)}°/${Math.round(w.min)}° · yağış %${w.rain}</h2>
      <ol>${st.map(p => `<li>${esc(p.name)} (${esc(p.cat)})</li>`).join("")}</ol>
      <p>Toplam: ${km.toFixed(1)} km · ~${Math.round(km * 1000 / STEP_M)} adım</p>`;
  }).join("");
}

/* ---------- Olaylar ---------- */
function submit() {
  run($("#city").value.trim(), +$("#days").value, +$("#tempo").value, $("#startDate").value);
}

$("#f").onsubmit = e => { e.preventDefault(); submit(); };
document.querySelectorAll(".chip").forEach(c => c.onclick = () => {
  $("#city").value = c.dataset.c;
  submit();
});

$("#add").onclick = () => {
  const p = S.pool.find(x => x.id === $("#addSel").value);
  if (!p) return;
  S.plan[day] = nnOrder([...S.plan[day], p]);
  show();
  toast(`“${p.name}” eklendi`);
};

$("#save").onclick = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
    toast("Rota kaydedildi ✓");
  } catch (_) {
    toast("Kaydedilemedi: tarayıcı depolamaya izin vermiyor.");
  }
};

$("#load").onclick = () => {
  let raw;
  try {
    raw = localStorage.getItem(KEY);
  } catch (_) {
    return fail(0, "Tarayıcı depolamaya erişimi engelliyor. Dosyayı doğrudan tarayıcıda aç.", null);
  }
  if (!raw) {
    return $("#status").innerHTML = '<div class="err info"><b>Kayıtlı rota yok</b><p>Önce bir rota oluşturup “Kaydet”e bas.</p></div>';
  }
  try {
    S = JSON.parse(raw);
    day = 0;
    $("#status").innerHTML = "";
    $("#city").value = S.city;
    $("#days").value = S.days;
    $("#tempo").value = S.n;
    $("#startDate").value = S.start;
    show();
    toast("Kayıtlı rota açıldı");
  } catch (_) {
    fail(0, "Kayıtlı veri bozuk, okunamadı.", null);
  }
};

$("#json").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 2)], { type: "application/json" }));
  a.download = `rota-${S.city}.json`;
  a.click();
  toast("JSON indirildi ✓");
};

$("#prn").onclick = () => window.print();
window.addEventListener("error", e => {
  if (e.message) toast("Hata: " + e.message);
});

/* ---------- Başlangıç ---------- */
(function init() {
  const today = new Date();
  const sd = $("#startDate");
  sd.value = sd.min = ymd(today);
  sd.max = ymd(addD(today, 14));
  initMap();
})();