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
const FIXED_TITLE = 'New message received';

/**
 * Background handler (app बंद/closed)
 * - adminPush: title/body/image दिखेगा, क्लिक पर data.link खुलेगा
 * - chat default: सिर्फ fixed title, body खाली; क्लिक पर chat-list खुलेगा
 */
messaging.setBackgroundMessageHandler((payload) => {
  const data = payload.data || {};

  // ---- ADMIN PUSH ----
  if (data.type === 'adminPush') {
    const n = payload.notification || {};
    const title = n.title || 'BechoBazaar';
    const body  = n.body  || '';
    const image = n.image || data.imageUrl || null;

    const options = {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      data: { ...data, link: data.link || '/' },
      vibrate: [70, 30, 70],
      tag: 'admin-push',
      renotify: true,
      ...(image ? { image } : {})
    };
    return self.registration.showNotification(title, options);
  }

  // ---- CHAT (privacy: no snippet) ----
  return self.registration.showNotification(FIXED_TITLE, {
    body: '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: data || {},
    vibrate: [60, 25, 60],
    tag: data.chatId ? `chat-${data.chatId}` : 'chat',
    renotify: true
  });
});

/**
 * Notification click
 * - adminPush ⇒ data.link (absolute/relative दोनों चलेंगे)
 * - chat default ⇒ हमेशा /chat-list.html
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const d = (event.notification && event.notification.data) || {};
  let target;

  if (d.type === 'adminPush' && d.link) {
    target = d.link;                         // e.g. https://bechobazaar.com/sale or /some/page
  } else {
    target = '/chat-list.html';              // always open chat list for chat pushes
  }

  // focus existing tab if already open, else open new
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(target) && 'focus' in c) return c.focus();
    }
    return clients.openWindow(target);
  })());
});
