// End-to-End Encryption (E2EE) Module
// Uses Web Crypto API: PBKDF2 for key derivation + AES-GCM 256-bit for data encryption

const CryptoE2EE = {
  cryptoKey: null,
  isInitialized: false,

  async init(passphraseOrRoomId) {
    try {
      const enc = new TextEncoder();
      const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(passphraseOrRoomId),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
      );

      // Salt derived deterministically from the room identifier
      const salt = enc.encode("nexusmeet-e2ee-salt-" + passphraseOrRoomId);

      this.cryptoKey = await window.crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: salt,
          iterations: 100000,
          hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );

      this.isInitialized = true;
      console.log("🔒 End-to-End Encryption initialized with AES-GCM 256-bit.");
      return true;
    } catch (err) {
      console.warn("Could not initialize E2EE crypto:", err);
      this.isInitialized = false;
      return false;
    }
  },

  async encrypt(dataObj) {
    if (!this.isInitialized || !this.cryptoKey) {
      return { ciphertext: JSON.stringify(dataObj), iv: null, is_encrypted: false };
    }

    try {
      const enc = new TextEncoder();
      const encodedData = enc.encode(JSON.stringify(dataObj));
      const iv = window.crypto.getRandomValues(new Uint8Array(12));

      const encryptedBuffer = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        this.cryptoKey,
        encodedData
      );

      // Convert buffer and IV to Base64
      const ciphertext = btoa(String.fromCharCode(...new Uint8Array(encryptedBuffer)));
      const ivBase64 = btoa(String.fromCharCode(...iv));

      return { ciphertext, iv: ivBase64, is_encrypted: true };
    } catch (err) {
      console.error("Encryption error:", err);
      return { ciphertext: JSON.stringify(dataObj), iv: null, is_encrypted: false };
    }
  },

  async decrypt(ciphertext, ivBase64) {
    if (!ivBase64 || !this.isInitialized || !this.cryptoKey) {
      try {
        return typeof ciphertext === "string" ? JSON.parse(ciphertext) : ciphertext;
      } catch {
        return ciphertext;
      }
    }

    try {
      const iv = Uint8Array.from(atob(ivBase64), c => c.charCodeAt(0));
      const data = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));

      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        this.cryptoKey,
        data
      );

      const dec = new TextDecoder();
      const jsonStr = dec.decode(decryptedBuffer);
      return JSON.parse(jsonStr);
    } catch (err) {
      console.warn("Decryption error (key mismatch or corrupted data):", err);
      return null;
    }
  }
};
