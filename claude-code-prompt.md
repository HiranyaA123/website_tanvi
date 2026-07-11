# Task: Add a star map background to the timeline + build a synced two-device photobooth page

This repo is a single-page romantic website (`index.html`) hosted on GitHub Pages at `https://justfortan.beauty`. It's a gift for my girlfriend. Vanilla HTML/CSS/JS only — no build step, no frameworks. Everything must keep working as static files on GitHub Pages.

## Existing design system (reuse it, don't invent new styles)

CSS variables in `:root` of index.html: `--night` (#1a1129), `--night-2`, `--plum`, `--coral` (#f0846a), `--sunset` (#f4a261), `--rose`, `--cream` (#f4ede4), `--cream-dim`, `--sage`, `--line`, `--line-strong`. Fonts: `--serif` (Fraunces, italic for headings) and `--sans` (Manrope). Dark dusk aesthetic, grain overlay, generous spacing. Match this exactly on anything new.

Read index.html fully before editing. I have made manual changes — do not regress them.

---

## Part 1 — Star map background for the timeline section (#story)

Render the **real night sky over 4 Foulis Ct, Wynn Vale SA (lat -34.789, lon 138.686) on 26 March 2026 at 9:00 PM ACDT (UTC+10:30)** — the night I asked her out — as a subtle canvas background behind the timeline.

Implementation requirements:
- Full-bleed `<canvas>` absolutely positioned behind the timeline content (z-index below the cards/polaroids, `pointer-events: none` EXCEPT for the secret star, see below).
- Embed a small star catalog in JS: the ~200–300 brightest stars (name optional, RA in hours, Dec in degrees, visual magnitude). Use a real catalog (e.g. condensed from the Yale Bright Star Catalog / HYG) — do not invent coordinates.
- Convert RA/Dec → altitude/azimuth for that exact date, time, and location using standard formulas (compute Julian date → GMST → LST → hour angle → alt/az). Show only stars above the horizon.
- Project alt/az onto the canvas (stereographic or simple equidistant projection is fine). Star size and brightness scale with magnitude (brighter = larger, mag > 5 can be skipped or very faint).
- Style: tiny cream/white dots at low opacity (0.15–0.5) so it reads as texture, not decoration that fights the content. A few of the brightest stars can have a very soft glow. Optional: faint constellation lines for 2–3 recognizable southern constellations (Crux / Southern Cross especially — this is Adelaide) at ~0.08 opacity.
- Add a small caption in the corner of the section, serif italic, cream-dim, e.g. "the sky over wynn vale · 26 march" — subtle.
- Canvas redraws on resize. Keep it performant (draw once, it's static — no animation loop needed except optional slow twinkle on a few stars).

### The secret star
- Pick one bright star in the rendered sky and make it special: slightly larger, coral-tinted, with a gentle pulsing glow (CSS or canvas animation).
- It is CLICKABLE (this element alone must accept pointer events — implement as a small absolutely-positioned element/button overlaying the canvas at the star's computed position, recalculated on resize).
- Clicking it navigates to `photobooth.html`.
- On hover/tap-hold, show a tiny tooltip in serif italic: "ours". No other explanation anywhere — it's an easter egg.

---

## Part 2 — Photobooth page (photobooth.html)

New page, same design language (same nav, same fonts/colors, grain, dusk gradients). A **synced two-device photobooth**: my girlfriend and I open the page on our own devices (she's in Adelaide, I'm in Sydney), both cameras turn on locally, we hit ready, a synchronized countdown fires on BOTH devices via Supabase Realtime, each device captures frames locally at the same moments, both upload, and the site composes a side-by-side photobooth strip.

**There is NO live video between devices. No WebRTC.** Each person only sees their own camera preview. The sync is only for the countdown timing and session coordination.

### Supabase config
Put these constants at the top of the photobooth script (I will paste real values):
```js
const SUPABASE_URL = 'PASTE_URL_HERE';
const SUPABASE_ANON_KEY = 'PASTE_ANON_KEY_HERE';
```
Load supabase-js v2 from CDN (`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`). Storage bucket is named `strips` (public read). Also create any SQL I need to run (e.g. a `strips` table for metadata, RLS policies for the bucket/table) and put it in a `supabase-setup.sql` file in the repo root with comments, so I can paste it into the Supabase SQL editor.

### PIN gate
- Before anything loads, a simple entry screen styled like the site: one input, "our pin". 
- Define `const PIN = '2603';` (I'll change it). Compare client-side; on success store a flag in sessionStorage so it doesn't re-ask constantly on the same device.
- This is a gift site, not a bank — keep it simple, but do NOT skip it, since the bucket is writable from the client.

### Photobooth flow
1. Page asks for camera via `getUserMedia` (front camera preferred: `facingMode: 'user'`). Show my own live preview in a styled frame. Handle permission-denied with a friendly message.
2. Two modes, chosen by simple toggle at the top:
   - **Together** (default): waits for both devices.
   - **Solo**: works alone, captures a normal single-column strip (so the page is still fun if only one of us is on).
3. Together mode session logic via one Supabase Realtime broadcast channel (e.g. `photobooth-room`):
   - Each device announces presence (use Realtime Presence). UI shows "waiting for her…" until 2 devices are present, then "she's here ♡".
   - Either person taps the big shutter button → broadcast a `start` event containing a start timestamp a few seconds in the future (use server-ish time: `Date.now()` is fine given both devices sync to NTP; add 3s lead).
   - Both devices run the SAME countdown locally against that shared timestamp: 3…2…1…snap, repeated for **4 frames** with ~2.5s between snaps. Big animated countdown numbers, flash effect on capture.
   - Each device captures its 4 frames from its own video stream onto canvases.
4. After capture, each device uploads its 4 frames (JPEG, reasonable quality/size, e.g. 720px wide) to the `strips` bucket under a shared session id: `sessions/{sessionId}/{deviceId}-{frameIndex}.jpg`.
5. When both devices' frames exist (poll storage or coordinate via broadcast `done` events), EACH device composes the final strip on a canvas:
   - Classic photobooth strip layout: 4 rows. In Together mode each row is the two photos side by side (her frame | my frame, same snap index). In Solo mode each row is one photo.
   - Frame the strip in the site palette: cream border like a real photobooth print, small caption at the bottom in serif italic: "justfortan.beauty · {date}". Slight warm filter on photos to match the aesthetic.
   - The device that initiated uploads the composed strip as `strips/{sessionId}.jpg` and inserts a row in the `strips` table (id, created_at, storage path).
6. Show the finished strip with two buttons: **keep** (already saved — just confirms and adds to gallery) and **delete** (removes strip + session frames from storage and the table row).
7. **Gallery** below the booth: grid of all kept strips, newest first, loaded from the `strips` table/bucket. Click to view full-size in a lightbox (match the lightbox style that exists on index.html). Each strip has a small delete button (with a confirm step).
8. Also add a **download** button on each strip (download the jpg) — she'll want them on her phone.

### Edge cases to handle
- Partner disconnects mid-session → timeout after ~20s waiting for their frames, offer to save a solo version of my half instead.
- Camera on mobile: preview and captures must not be distorted (respect aspect ratio; crop center-square for each frame so the strip is uniform).
- iOS Safari quirks: `playsinline` on the video element, resume after visibility change.
- Two people pressing start at nearly the same time: first `start` event wins; ignore a second `start` if a session is active.

---

## Part 3 — Navigation

- Convert the existing nav in index.html into a shared pattern across both pages: same markup on both, with links: Home, Our Story, Photos, Bucket List (these anchor to index.html sections — from photobooth.html they must be `index.html#story` etc.) plus **Photobooth** → photobooth.html.
- Highlight the current page/section link subtly (coral).
- Keep the existing mobile nav behavior/styling.

## General constraints
- Vanilla JS only (supabase-js from CDN is the one allowed dependency).
- Don't break anything that currently works: splash + music, countdown, timeline polaroids, masonry gallery + lightbox, bucket list.
- Match the writing voice used on the site: lowercase, serif italic headings, understated.
- Test hooks: it should be possible to test Solo mode fully on localhost with a webcam before Supabase is configured (guard Supabase calls so Solo capture + compose + download works even if the constants are unset; Together mode and the gallery can require Supabase).
- Commit in logical steps with clear messages.
