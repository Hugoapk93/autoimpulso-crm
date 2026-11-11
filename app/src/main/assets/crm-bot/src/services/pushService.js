const webpush = require('web-push');
const { getSubscriptions, removeSubscription } = require('../database');

// Si las VAPID no están configuradas (o son inválidas), el push queda
// desactivado y el servidor sigue arrancando: antes, setVapidDetails()
// lanzaba y app.js lo llamaba sin try/catch, así que el bot no arrancaba.
let pushEnabled = false;

const initializePushNotifications = () => {
    const { VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
    if (!VAPID_EMAIL || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        console.warn('⚠️ Push desactivado: faltan VAPID_EMAIL, VAPID_PUBLIC_KEY o VAPID_PRIVATE_KEY en .env. El bot sigue sin notificaciones push.');
        pushEnabled = false;
        return false;
    }
    try {
        webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    } catch (e) {
        console.warn('⚠️ Push desactivado: las claves VAPID no son válidas:', e.message);
        pushEnabled = false;
        return false;
    }
    pushEnabled = true;
    return true;
};

const sendPushNotification = (title, body, url = '/index.html#activity') => {
    if (!pushEnabled) return;
    let subscriptions;
    try {
        subscriptions = getSubscriptions();
    } catch (e) {
        return;
    }
    const payload = JSON.stringify({ title, body, url });
    subscriptions.forEach(sub => {
        webpush.sendNotification(sub, payload).catch(err => {
            if (err.statusCode === 410 || err.statusCode === 404) {
                removeSubscription(sub.endpoint);
            }
        });
    });
};

const isPushEnabled = () => pushEnabled;

module.exports = { initializePushNotifications, sendPushNotification, isPushEnabled };
