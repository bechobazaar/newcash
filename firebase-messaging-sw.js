// /firebase-messaging-sw.js
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

// Background (data-only) messages from our function
messaging.setBackgroundMessageHandler(function(payload) {
  const d = (payload && payload.data) || {};
  const title = d.title || 'BechoBazaar';
  const options = {
    body: d.body || '',
    icon: d.icon || '/logo-192.png',
    badge: d.badge || '/badge-72.png',
    tag: d.tag || '',
    data: { url: d.url || '/', ...d }
  };
  return self.registration.showNotification(title, options);
});

// Fallback for raw push events (just in case)
self.addEventListener('push', function(event){
  try{
    const j = event.data ? event.data.json() : null;
    if (j && j.data) {
      const d = j.data;
      const title = d.title || 'BechoBazaar';
      const opts = {
        body: d.body || '',
        icon: d.icon || '/logo-192.png',
        badge: d.badge || '/badge-72.png',
        tag: d.tag || '',
        data: { url: d.url || '/', ...d }
      };
      event.waitUntil(self.registration.showNotification(title, opts));
    }
  }catch(e){}
});

// Open the right page when the user clicks the notification
self.addEventListener('notificationclick', function(event){
