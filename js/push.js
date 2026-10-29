// Web Push subscription for the morning brief and evening review alerts.
// The subscription is saved in the private repo, where the scheduled runs
// read it (scripts/web_push.mjs in personal-assistant). The private VAPID key
// lives only in the cloud environment.

export const VAPID_PUBLIC_KEY =
  "BL5kMgWm6VEtc0PPvLb6faE93pdj2rnx-BCHkm7ZgmBIK6IYchUEFMvczC85lYeDvgrhCGby4ytAtDytCcjd_TQ";
const PATH = "config/push-subscriptions.json";

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function deviceName() {
  const ua = navigator.userAgent;
  const model = /Android [\d.]+; ([^;)]+)/.exec(ua);
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Browser";
  return model && model[1] !== "K" ? `${os} ${model[1]}` : os;
}

// A subscription made with an older VAPID key can no longer receive pushes.
function usesCurrentKey(sub) {
  const key = sub.options && sub.options.applicationServerKey;
  if (!key) return true;
  const a = new Uint8Array(key);
  const b = keyBytes(VAPID_PUBLIC_KEY);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Returns { sub, stale }: stale is true when the phone holds a subscription
// for an old key and needs to subscribe again.
export async function currentSubscription() {
  if (!pushSupported()) return { sub: null, stale: false };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub && !usesCurrentKey(sub)) return { sub: null, stale: true };
  return { sub, stale: false };
}

function upsert(text, sub) {
  const list = text ? JSON.parse(text) : [];
  const json = sub.toJSON();
  const entry = { device: deviceName(), added: new Date().toISOString().slice(0, 10), endpoint: json.endpoint, keys: json.keys };
  const next = list.filter((s) => s.endpoint !== json.endpoint).concat(entry);
  return JSON.stringify(next, null, 2) + "\n";
}

function remove(text, endpoint) {
  const list = text ? JSON.parse(text) : [];
  return JSON.stringify(list.filter((s) => s.endpoint !== endpoint), null, 2) + "\n";
}

export async function enablePush(repo) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知權限被拒絕。請到手機設定 → 應用程式 → Chrome（或助理）→ 通知，允許後再試");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  let oldEndpoint = null;
  if (sub && !usesCurrentKey(sub)) {
    oldEndpoint = sub.endpoint;
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  await repo.updateFile(PATH, (text) => upsert(oldEndpoint ? remove(text, oldEndpoint) : text, sub), "Add push subscription");
  return sub;
}

export async function disablePush(repo) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await repo.updateFile(PATH, (text) => remove(text, endpoint), "Remove push subscription");
}

export async function showLocalTest() {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification("🔔 測試通知", {
    body: "這是手機本機的測試，代表通知權限正常",
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png",
    tag: "pa-local-test",
    data: { url: "./#/today" },
  });
}
