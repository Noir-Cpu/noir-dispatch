const enc = new TextEncoder();
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => (/^([0-9a-f]{2})+$/i.test(h) ? Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16)) : null);

const key = (secret: string, usage: KeyUsage[]) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);

export async function hmacHex(secret: string, message: string) {
  return toHex(await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), enc.encode(message)));
}

/** Constant-time verification (delegated to WebCrypto, not a string compare). */
export async function hmacVerify(secret: string, message: string, hex: string) {
  const sig = fromHex(hex);
  return sig ? crypto.subtle.verify("HMAC", await key(secret, ["verify"]), sig, enc.encode(message)) : false;
}

export async function sha256Hex(s: string) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
