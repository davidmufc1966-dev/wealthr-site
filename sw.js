const CACHE = "wealthr-v11";

self.addEventListener("install", e => { self.skipWaiting(); });

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  if (e.request.url.includes("coingecko") || e.request.url.includes("blockstream") ||
      e.request.url.includes("fonts.google") || e.request.url.includes("twelvedata") ||
      e.request.url.includes("allorigins") || e.request.url.includes("corsproxy") ||
      e.request.url.includes("er-api")) {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }))
    );
  }
});

// ── PERIODIC BACKGROUND SYNC ────────────────────────────────────────
self.addEventListener("periodicsync", e => {
  if (e.tag === "bill-reminders") {
    e.waitUntil(checkBillsAndNotify());
  }
});

// ── PUSH (fallback if periodic sync not supported) ──────────────────
self.addEventListener("push", e => {
  e.waitUntil(checkBillsAndNotify());
});

// ── NOTIFICATION CLICK ──────────────────────────────────────────────
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow("/app");
    })
  );
});

// ── CORE LOGIC ──────────────────────────────────────────────────────
async function checkBillsAndNotify() {
  try {
    // Read bills from localStorage via client messaging, or IndexedDB
    // We store a copy of bills in IDB so SW can read without a client
    const db = await openDB();
    const bills = await getFromDB(db, "bills");
    const isPro = await getFromDB(db, "isPro");
    if (!isPro || !bills || !bills.length) return;

    const today = new Date(); today.setHours(0,0,0,0);

    for (const b of bills) {
      const days = billDaysUntil(b, today);
      const remind = b.remindDays || 3;
      if (days >= 0 && days <= remind) {
        const msg = days === 0
          ? `${b.name} is due today — £${b.amount.toFixed(2)}`
          : days === 1
          ? `${b.name} is due tomorrow — £${b.amount.toFixed(2)}`
          : `${b.name} is due in ${days} days — £${b.amount.toFixed(2)}`;

        await self.registration.showNotification("🔔 Wealthr Bill Reminder", {
          body: msg,
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
          tag: "bill-" + b.id,
          renotify: false,
          data: { url: "/app" }
        });
      }
    }
  } catch(e) {
    console.error("Bill check failed:", e);
  }
}

function billDaysUntil(bill, today) {
  let d = new Date(bill.nextDue);
  while (d < today) {
    d = billAdvanceDate(d, bill.cycle);
  }
  return Math.ceil((d - today) / 86400000);
}

function billAdvanceDate(d, cycle) {
  const n = new Date(d);
  if (cycle === "monthly")    { n.setMonth(n.getMonth()+1); }
  else if (cycle === "4weekly")  { n.setDate(n.getDate()+28); }
  else if (cycle === "weekly")   { n.setDate(n.getDate()+7); }
  else if (cycle === "quarterly"){ n.setMonth(n.getMonth()+3); }
  else if (cycle === "annually") { n.setFullYear(n.getFullYear()+1); }
  return n;
}

// ── INDEXEDDB helpers (SW can't access localStorage) ────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("wealthr-sw", 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv");
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

function getFromDB(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putToDB(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    const req = tx.objectStore("kv").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
