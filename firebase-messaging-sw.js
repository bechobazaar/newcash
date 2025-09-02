/* global importScripts, firebase, self, clients */
importScripts('https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.0/firebase-messaging.js');


// Use the same config you have in your pages
firebase.initializeApp({
apiKey: "AIzaSyBknD854PogHpSh12VEVOFobZTG5q1o4_Y",
authDomain: "olxhub-12479.firebaseapp.com",
databaseURL: "https://olxhub-12479-default-rtdb.firebaseio.com",
projectId: "olxhub-12479",
storageBucket: "olxhub-12479.appspot.com",
messagingSenderId: "470888578176",
appId: "1:470888578176:web:5f24b2dba3eebd39cefa65"
});


const messaging = firebase.messaging();


// Background handler: show a system notification when a push arrives and the app is closed
messaging.setBackgroundMessageHandler(function(payload){
const title = (payload.notification && payload.notification.title) || 'New message';
const options = {
body: (payload.notification && payload.notification.body) || (payload.data && payload.data.text) || '',
icon: '/icons/icon-192.png',
badge: '/icons/badge-72.png',
data: payload.data || {}
};
return self.registration.showNotification(title, options);
});


// Clicking the notification should open/focus the right chat
self.addEventListener('notificationclick', function(event){
event.notification.close();
const chatId = event.notification && event.notification.data && event.notification.data.chatId;
const url = chatId ? `/chat.html?chatId=${encodeURIComponent(chatId)}` : '/chat-list.html';
event.waitUntil((async () => {
const allClients = await clients.matchAll({ type:'window', includeUncontrolled:true });
for (const c of allClients){
if (c.url.includes(url) && 'focus' in c) return c.focus();
}
return clients.openWindow(url);
})());
});