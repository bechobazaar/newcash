/* global importScripts, firebase, self, clients */
importScripts('https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.0/firebase-messaging.js');

firebase.initializeApp({
  apiKey: "AIzaSyBknD854PogHpSh12VEVOFobZTG5q1o4_Y",
  authDomain: "olxhub-12479.firebaseapp.com",
  databaseURL: "https://olxhub-12479-default-rtdb.firebaseio.com",
  projectId: "olxhub-12479",
  storageBucket: "olxhub-12479.appspot.com",
  messagingSenderId: "470888578176",
  appId: "1:470888578176:web:5f24b2dba3eebd39cefa65",
  measurementId: "G-FDNWXBM2MY"
});

const messaging = firebase.messaging();

// --- constants (canonical host) ---
const CANON = 'https://www.bechobazaar.com';
const HOMEPAGE = `${CANON}/`;
const CHATLIST = `${CANON}/chat-list.html`;

// Utility: make absolute URL on canonical host
function toCanonUrl(raw) {
  try {
    // If admin sent absolute URL, keep it (even if external)
    const abs = new URL(raw);
    return abs.toString();
  } catch {
    // Otherwise treat as relative path against canonical host
    try {
      return new URL(raw, CANON).toString();
    } catch {
      return HOMEPAGE;
    }
  }
}

/* Background show (data or notification payloads) */
messaging.setBackgroundMessageHandler((payload) => {
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || 'BechoBazaar';

  const options = {
    body: n.body || d.text || '',
    icon: '/icons/icon-192.png?v=6',
    badge: '/icons/badge-72.png?v=6',
    // Store raw link + normalized fallback in data for click handler
    data: {
      ...d,
      // If admin push provides a link, keep it; otherwise mark for chatlist
      __target__: d.link || d.url || d.deepLink || '', // raw from admin if any
      __isAdmin__: Boolean(d.link || d.url || d.deepLink)
    }
  };

  // Support optional image
  if (n.image || d.imageUrl) options.image = n.image || d.imageUrl;

  return self.registration.showNotification(title, options);
});

/* Click → open the right page */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification && event.notification.data) || {};
  const isAdmin = !!data.__isAdmin__;

  // Decide destination:
  // - admin push → the link admin sent
  // - normal message → chat list
  const rawTarget = isAdmin ? (data.__target__ || '') : '';
  const targetUrl = rawTarget ? toCanonUrl(rawTarget) : CHATLIST;

  event.waitUntil((async () => {
    // Try to focus an existing tab whose URL starts with the destination (or at least same site)
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer an exact or prefix match
    const match = all.find(c => c.url === targetUrl || c.url.startsWith(targetUrl))
               || all.find(c => c.url.startsWith(CANON));

    if (match) {
      // Focus the best match; if it’s already on the right host but not the right page,
      // try to navigate (only works same-origin), otherwise just open a new window below.
      await match.focus();
      try {
        const target = new URL(targetUrl);
        const current = new URL(match.url);
        if (target.origin === current.origin && match.navigate) {
          await match.navigate(targetUrl);
          return;
        }
      } catch {}
      // If we couldn’t navigate (cross-origin or blocked), fall through to openWindow
    }

    // Open (works across origins; user gesture from notification click)
    return clients.openWindow(targetUrl);
  })());
}); 
