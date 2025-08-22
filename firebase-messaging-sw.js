/* firebase-messaging-sw.js — root par hona chahiye */
importScripts('https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.0/firebase-messaging.js');

firebase.initializeApp({
  apiKey: "AIzaSyBknD854PogHpSh12VEVOFobZTG5q1o4_Y",
  authDomain: "bechobazaar.com",
  projectId: "olxhub-12479",
  messagingSenderId: "470888578176",
  appId: "1:470888578176:web:5f24b2dba3eebd39cefa65"
});

const messaging = firebase.messaging();

/* Background messages (tab band ho, site closed ho) */
messaging.setBackgroundMessageHandler(function(payload) {
  const data = payload.data || {};
  const title = data.title || 'New message';
  const body  = data.body  || '';
  const icon  = data.icon  || '/logo-192.png';

  // Chat deep link: /chat.html?chatId=...&u=...
  const url   = data.url   || '/';

  return self.registration.showNotification(title, {
    body, icon, badge: data.badge || '/badge-72.png',
    tag: data.tag || 'bechobazaar',
    data: { url }
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const c of list) { if (c.url.includes(url)) return c.focus(); }
    return clients.openWindow(url);
  }));
});
