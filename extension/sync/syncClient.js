// Talks to a lightmorphic-sync server (hosted or self-hosted). Handles
// registration/login and per-collection get/put with optimistic
// concurrency. Encryption/decryption happens in crypto.js -- this module
// only ever sees ciphertext envelopes.

import { deriveIdentity, encryptBlob, decryptBlob } from "./crypto.js";

const DEFAULT_SERVER = "https://sync.lightmorphic.co.uk";

async function getSettings() {
  const { syncServer, syncToken, syncAccountId } = await chrome.storage.local.get([
    "syncServer",
    "syncToken",
    "syncAccountId",
  ]);
  return {
    server: syncServer || DEFAULT_SERVER,
    token: syncToken || null,
    accountId: syncAccountId || null,
  };
}

async function request(server, path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${server}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    throw new Error(`sync request failed: ${res.status}`);
  }
  return res;
}

// Called once, when the user sets up sync with a passphrase (either
// creating a new account or logging into an existing one on a new
// device). encKey is kept only in memory / chrome.storage.session, never
// persisted alongside the passphrase.
export async function setupSync({ passphrase, server = DEFAULT_SERVER, isNewAccount }) {
  const { accountId, encKey, authKey } = await deriveIdentity(passphrase);

  const res = await request(server, isNewAccount ? "/v1/register" : "/v1/login", {
    method: "POST",
    body: { accountId, authKey },
  });
  if (!res.ok) throw new Error(isNewAccount ? "registration failed" : "invalid passphrase");

  const { token } = await res.json();
  await chrome.storage.local.set({ syncServer: server, syncToken: token, syncAccountId: accountId });
  await chrome.storage.session.set({ syncEncKeyRaw: await crypto.subtle.exportKey("raw", encKey) });
  return { accountId };
}

async function getEncKey() {
  const { syncEncKeyRaw } = await chrome.storage.session.get("syncEncKeyRaw");
  if (!syncEncKeyRaw) throw new Error("sync is locked -- re-enter passphrase");
  return crypto.subtle.importKey("raw", syncEncKeyRaw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Fetches, decrypts, and returns a collection's current value + version.
export async function pull(collection) {
  const { server, token } = await getSettings();
  if (!token) return { value: null, version: 0 };

  const res = await request(server, `/v1/collections/${collection}`, { token });
  if (res.status === 404) return { value: null, version: 0 };

  const { blob, version } = await res.json();
  const encKey = await getEncKey();
  return { value: await decryptBlob(encKey, blob), version };
}

// Encrypts and writes a collection. Returns the new version on success,
// or { conflict: true, version } if another device wrote first --
// callers should pull(), merge, and retry.
export async function push(collection, value, baseVersion) {
  const { server, token } = await getSettings();
  if (!token) throw new Error("sync is not set up");

  const encKey = await getEncKey();
  const blob = await encryptBlob(encKey, value);

  const res = await request(server, `/v1/collections/${collection}`, {
    method: "PUT",
    token,
    body: { blob, baseVersion },
  });
  const data = await res.json();
  if (res.status === 409) return { conflict: true, version: data.version };
  return { conflict: false, version: data.version };
}

export async function isConfigured() {
  const { token } = await getSettings();
  return Boolean(token);
}
