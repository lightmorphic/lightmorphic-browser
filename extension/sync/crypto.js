// Zero-knowledge key derivation and envelope encryption.
//
// Mirrors the Bitwarden-style split: a single passphrase produces two
// independent secrets that never both exist server-side.
//
//   masterKey   = PBKDF2(passphrase, accountId, 600_000, SHA-256)  [stays local]
//   encKey      = HKDF(masterKey, info="enc")                     [stays local]
//   authKey     = HKDF(masterKey, info="auth")                    [sent to server at login/register,
//                                                                   itself useless for decrypting data]
//
// The server only ever stores: accountId, authKey (further hashed
// server-side), and AES-GCM encrypted blobs. It never sees passphrase,
// masterKey, or encKey. Losing the passphrase means losing the data —
// there is no recovery path, by design.

const PBKDF2_ITERATIONS = 600_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveMasterKey(passphrase, accountId) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: textEncoder.encode(accountId),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

async function hkdfExpand(masterKeyBytes, info, lengthBytes) {
  const key = await crypto.subtle.importKey("raw", masterKeyBytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: textEncoder.encode(info),
    },
    key,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

// Computes accountId, encKey (as a CryptoKey for AES-GCM), and authKey
// (base64, sent to the server) from a passphrase the user chose.
// accountId is derived from the passphrase too, so the server can look
// up a user's blobs without ever being told a human-chosen identifier.
export async function deriveIdentity(passphrase) {
  const accountIdBits = await crypto.subtle.digest("SHA-256", textEncoder.encode(`lightmorphic-account:${passphrase}`));
  const accountId = toBase64(new Uint8Array(accountIdBits)).replace(/[+/=]/g, "");

  const masterKeyBytes = await deriveMasterKey(passphrase, accountId);
  const encKeyBytes = await hkdfExpand(masterKeyBytes, "lightmorphic-enc", 32);
  const authKeyBytes = await hkdfExpand(masterKeyBytes, "lightmorphic-auth", 32);

  const encKey = await crypto.subtle.importKey("raw", encKeyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);

  return {
    accountId,
    encKey,
    authKey: toBase64(authKeyBytes),
  };
}

// Encrypts a JS value to a self-contained base64 envelope: iv || ciphertext.
export async function encryptBlob(encKey, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encKey, plaintext);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(combined);
}

export async function decryptBlob(encKey, envelopeBase64) {
  const combined = fromBase64(envelopeBase64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, encKey, ciphertext);
  return JSON.parse(textDecoder.decode(plaintext));
}
