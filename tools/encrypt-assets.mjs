/* ============================================================
   ENCRYPT ASSETS  —  run this whenever photos change.

     node tools/encrypt-assets.mjs

   It asks for the passphrase (never pass it as an argument —
   arguments land in your shell history and in the process list).

   What it does:
     photos/02-feb.jpg   ->  enc/photos/02-feb.jpg.enc
     gallery/IMG_1196.jpg->  enc/gallery/IMG_1196.jpg.enc
     audio/song.mp3      ->  enc/audio/song.mp3.enc
     + enc/manifest.json  (KDF parameters, canary, file list)

   The .enc files are what you commit. The originals stay on your
   machine and must NOT be committed — .gitignore covers them.

   Every byte is AES-256-GCM. The key comes from your passphrase
   through PBKDF2-SHA256, so the passphrase is the only thing that
   opens these files. There is no recovery: lose it and the photos
   are gone. Keep a copy in your password manager.
   ============================================================ */

import { webcrypto as crypto } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'enc');

/* PBKDF2 work factor. Higher = slower to unlock (once, on her phone)
   and proportionally slower to brute force. 600k is the current OWASP
   figure for PBKDF2-SHA256 and costs roughly a quarter-second. */
const ITERATIONS = 600_000;
const CANARY_TEXT = 'ldr-gate-v1';

/* Folders to encrypt. `gallery` is also listed in the manifest so the
   page can build the grid without asking GitHub for a directory listing. */
const SOURCES = [
  { dir: 'photos',  match: /\.(jpe?g|png|webp|gif)$/i },
  { dir: 'gallery', match: /\.(jpe?g|png|webp|gif)$/i, gallery: true },
  { dir: 'audio',   match: /\.(mp3|m4a|ogg|wav)$/i },
];

/* ---------- passphrase input (not echoed to the terminal) ----------
   Keys are compared by character code so this file stays plain ASCII —
   no literal control characters to get mangled by an editor or a shell. */
const KEY_CR = 13, KEY_LF = 10, KEY_EOT = 4, KEY_ETX = 3, KEY_DEL = 127, KEY_BS = 8;

function promptSecret(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('No terminal available. Run this in an interactive shell.'));
      return;
    }
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const finish = (fn, arg) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      fn(arg);
    };
    const onData = (ch) => {
      const code = ch.charCodeAt(0);
      if (code === KEY_CR || code === KEY_LF || code === KEY_EOT) return finish(resolve, buf);
      if (code === KEY_ETX) return finish(() => process.exit(130));       // ctrl-c
      if (code === KEY_DEL || code === KEY_BS) { buf = buf.slice(0, -1); return; }
      // Ignore escape sequences (arrow keys etc.) rather than storing the bytes.
      if (code < 32) return;
      buf += ch;
    };
    stdin.on('data', onData);
  });
}

/* A rough, deliberately pessimistic strength estimate. The point is only
   to stop a 4-digit code from being used, since that would undo the
   entire exercise — 10,000 guesses is minutes of work for an attacker. */
function estimateBits(pass) {
  const words = pass.trim().split(/\s+/).filter(Boolean);
  // 12 bits/word is conservative: a real diceware list gives 12.9, and even a
  // sloppy "4 random-ish words" clears this. 4 words => 48 bits.
  if (words.length >= 3) return words.length * 12;
  let pool = 0;
  if (/[a-z]/.test(pass)) pool += 26;
  if (/[A-Z]/.test(pass)) pool += 26;
  if (/[0-9]/.test(pass)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pass)) pool += 32;
  return pass.length * Math.log2(Math.max(pool, 2));
}

/* ---------- crypto ---------- */
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/* Output layout is  [12-byte IV][ciphertext + 16-byte GCM tag].
   A fresh IV per file is required — reusing one across files under the
   same key would leak the XOR of their plaintexts. */
async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

/* ---------- main ---------- */
async function collect() {
  const assets = [];
  const gallery = [];
  for (const src of SOURCES) {
    const abs = path.join(ROOT, src.dir);
    if (!existsSync(abs)) continue;
    const names = (await readdir(abs)).filter(n => src.match.test(n)).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (!(await stat(path.join(abs, name))).isFile()) continue;
      const rel = `${src.dir}/${name}`;
      assets.push(rel);
      if (src.gallery) gallery.push(rel);
    }
  }
  return { assets, gallery };
}

async function main() {
  const { assets, gallery } = await collect();
  if (assets.length === 0) {
    console.error('Nothing to encrypt — photos/, gallery/ and audio/ are all empty or missing.');
    process.exit(1);
  }
  console.log(`Found ${assets.length} file(s) to encrypt.\n`);

  /* LDR_PASSPHRASE exists so this can be re-run without a terminal. Prefer the
     prompt: an environment variable is readable by other processes running as
     you, and shells often log the command that set it. */
  let pass, again;
  if (process.env.LDR_PASSPHRASE) {
    pass = again = process.env.LDR_PASSPHRASE;
    console.log('Using LDR_PASSPHRASE from the environment.');
  } else {
    pass  = await promptSecret('Passphrase: ');
    if (!pass) { console.error('Empty passphrase — nothing done.'); process.exit(1); }
    again = await promptSecret('Again:      ');
  }
  if (pass !== again) { console.error('They do not match — nothing done.'); process.exit(1); }

  const bits = estimateBits(pass);
  if (bits < 45 && process.env.ALLOW_WEAK !== '1') {
    console.error(
      `\nThat passphrase is about ${Math.round(bits)} bits of entropy — too weak.\n` +
      `Everything here is public files, so an attacker can guess offline as fast as\n` +
      `their hardware allows. Use 4+ random words (e.g. "otter-lantern-brick-tuesday")\n` +
      `or 12+ mixed characters. Aim for 45+ bits.\n\n` +
      `To override anyway: ALLOW_WEAK=1 node tools/encrypt-assets.mjs\n`
    );
    process.exit(1);
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await deriveKey(pass, salt);

  await mkdir(OUT_DIR, { recursive: true });

  // Canary: lets the page tell a right passphrase from a wrong one without
  // storing a hash of the passphrase anywhere.
  await writeFile(
    path.join(OUT_DIR, 'canary.bin'),
    await encryptBytes(key, new TextEncoder().encode(CANARY_TEXT))
  );

  for (const rel of assets) {
    const bytes = await readFile(path.join(ROOT, rel));
    const dest  = path.join(OUT_DIR, rel + '.enc');
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await encryptBytes(key, bytes));
    console.log(`  ${rel}  ->  enc/${rel}.enc`);
  }

  const manifest = {
    version: 1,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: ITERATIONS,
      salt: Buffer.from(salt).toString('base64'),
    },
    canary: 'canary.bin',
    canaryText: CANARY_TEXT,
    assets,
    gallery,
  };
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(
    `\nDone — ${assets.length} file(s) encrypted into enc/.\n` +
    `Commit the enc/ folder. Do not commit photos/, gallery/ or audio/.\n` +
    `Everyone who had the old code is locked out until you give them this one.\n`
  );
}

main().catch(err => { console.error(err); process.exit(1); });
