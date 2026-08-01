/* ============================================================
   PASSCODE GATE  —  shared by index.html, photobooth.html and
   bucketlist.html. Loaded synchronously in <head> so the
   `unlocked` class lands before first paint and the gate never
   flashes.

   HOW THIS ACTUALLY PROTECTS ANYTHING
   -----------------------------------
   The old gate only hid the page. Every photo still sat at a
   public URL, so the gate was decoration. Now the photos are not
   on the server at all — only AES-256-GCM ciphertext is. The key
   is derived from the passphrase (PBKDF2-SHA256) inside the
   browser and never leaves it. Someone who downloads every byte
   of this site gets noise unless they know the passphrase.

   There is no hash of the passphrase anywhere. A wrong guess is
   rejected because it fails to decrypt a small canary file, which
   costs a full PBKDF2 derivation per attempt.

   TO CHANGE THE PASSPHRASE
     node tools/encrypt-assets.mjs      (asks for the new one)
     commit the regenerated enc/ folder
   Devices holding the old key relock themselves: the stored key
   stops decrypting the canary.
   ============================================================ */
(function () {
  'use strict';

  var KEY_STORE = 'ldr_key_v1';   // base64 raw AES key — "remember this device"
  var ENC_DIR   = 'enc/';

  /* Pre-paint: if this device has a key, show the content immediately.
     If the key turns out to be stale it is revoked a moment later. */
  var storedKey = null;
  try { storedKey = localStorage.getItem(KEY_STORE); } catch (e) { /* private mode */ }
  if (storedKey) document.documentElement.classList.add('unlocked');

  var manifestPromise = null;
  var cryptoKey       = null;      // CryptoKey once unlocked, in memory only
  var assetCache      = Object.create(null);

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function manifest() {
    if (!manifestPromise) {
      manifestPromise = fetch(ENC_DIR + 'manifest.json', { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('manifest ' + r.status);
          return r.json();
        });
    }
    return manifestPromise;
  }

  function deriveKey(pass, kdf) {
    return crypto.subtle.importKey(
      'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']
    ).then(function (base) {
      return crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: b64ToBytes(kdf.salt),
          iterations: kdf.iterations,
          hash: kdf.hash
        },
        base,
        { name: 'AES-GCM', length: 256 },
        true,                       // extractable: needed to remember the device
        ['decrypt']
      );
    });
  }

  /* Files are [12-byte IV][ciphertext+tag]. GCM authenticates, so a wrong
     key throws rather than returning garbage — that is what makes the
     canary check reliable. */
  function decrypt(key, buf) {
    var bytes = new Uint8Array(buf);
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
      key,
      bytes.subarray(12)
    );
  }

  function checkCanary(key, m) {
    return fetch(ENC_DIR + m.canary, { cache: 'no-cache' })
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) { return decrypt(key, buf); })
      .then(function (plain) {
        return new TextDecoder().decode(plain) === m.canaryText;
      })
      .catch(function () { return false; });   // wrong key: GCM tag mismatch
  }

  function rememberKey(key) {
    return crypto.subtle.exportKey('raw', key).then(function (raw) {
      try { localStorage.setItem(KEY_STORE, bytesToB64(new Uint8Array(raw))); }
      catch (e) { /* private mode — this visit only */ }
    });
  }

  function forgetKey() {
    try { localStorage.removeItem(KEY_STORE); } catch (e) {}
    cryptoKey = null;
    document.documentElement.classList.remove('unlocked');
  }

  /* Restore the remembered key, then confirm it still opens the canary.
     Re-encrypting with a new passphrase invalidates every stored key. */
  var readyPromise = (function () {
    if (!storedKey) return Promise.resolve(false);
    return crypto.subtle.importKey(
      'raw', b64ToBytes(storedKey), { name: 'AES-GCM' }, true, ['decrypt']
    ).then(function (key) {
      return manifest().then(function (m) {
        return checkCanary(key, m).then(function (ok) {
          if (!ok) { forgetKey(); return false; }
          cryptoKey = key;
          return true;
        });
      });
    }).catch(function () { forgetKey(); return false; });
  })();

  /* A Blob with no type reports as text/plain. Images survive that because
     browsers sniff them, but <audio> can refuse to play an untyped blob, so
     put the real type back on. */
  var MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav'
  };
  function mimeFor(relPath) {
    var ext = relPath.split('.').pop().toLowerCase();
    return MIME[ext] || 'application/octet-stream';
  }

  /* Decrypt one asset and hand back an object URL. Cached, because the
     lightbox re-requests the same photo every time it opens. */
  function assetURL(relPath) {
    if (!cryptoKey) return Promise.reject(new Error('locked'));
    if (assetCache[relPath]) return assetCache[relPath];
    assetCache[relPath] = fetch(ENC_DIR + relPath + '.enc', { cache: 'force-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error(relPath + ' ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) { return decrypt(cryptoKey, buf); })
      .then(function (plain) {
        return URL.createObjectURL(new Blob([plain], { type: mimeFor(relPath) }));
      })
      .catch(function (err) { delete assetCache[relPath]; throw err; });
    return assetCache[relPath];
  }

  /* Swap every <img data-enc="photos/x.jpg"> (and audio/video) for its
     decrypted blob. Safe to call repeatedly — handled nodes are marked. */
  function hydrate(root) {
    var nodes = (root || document).querySelectorAll('[data-enc]:not([data-enc-done])');
    return Promise.all(Array.prototype.map.call(nodes, function (el) {
      el.setAttribute('data-enc-done', '');
      return assetURL(el.getAttribute('data-enc'))
        .then(function (url) { el.src = url; })
        .catch(function () { el.removeAttribute('data-enc-done'); });
    }));
  }

  function unlock(pass) {
    return manifest().then(function (m) {
      return deriveKey(String(pass), m.kdf).then(function (key) {
        return checkCanary(key, m).then(function (ok) {
          if (!ok) return false;
          cryptoKey = key;
          document.documentElement.classList.add('unlocked');
          return rememberKey(key).then(function () { return true; });
        });
      });
    }).catch(function () { return false; });
  }

  /* Wrong passphrase: shake, clear, refocus. No error text, same as before. */
  function shake(input) {
    input.value = '';
    input.classList.remove('shake');
    void input.offsetWidth;              // reflow, so a repeat wrong code re-animates
    input.classList.add('shake');
    input.addEventListener('animationend', function () {
      input.classList.remove('shake');
    }, { once: true });
    input.focus();
  }

  window.LDRGate = {
    ready:     readyPromise,          // resolves true if this device is already unlocked
    unlocked:  function () { return !!cryptoKey; },
    unlock:    unlock,
    lock:      forgetKey,
    manifest:  manifest,
    assetURL:  assetURL,
    hydrate:   hydrate,
    shake:     shake
  };
})();
