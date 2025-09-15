(async function () {
  'use strict';

  const isSmall = window.matchMedia('(max-width: 768px)').matches;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Helper to enforce Vimeo params while preserving any existing ones
  function buildVimeoUrl(base) {
    try {
      const url = new URL(base);
      const p = url.searchParams;
      p.set('autoplay','1');
      p.set('muted','1');
      p.set('loop','1');
      p.set('background','1');
      p.set('autopause','0');   // <-- important for many players at once
      p.set('playsinline','1'); // <-- iOS inline
      url.search = p.toString();
      return url.toString();
    } catch {
      const sep = base.includes('?') ? '&' : '?';
      return base + sep + 'autoplay=1&muted=1&loop=1&background=1&autopause=0&playsinline=1';
    }
  }

  // Load manifest with cache-bust
  let manifest;
  try {
    const res = await fetch(`./assets/js/manifest.json?ts=${Date.now()}`, { cache: 'no-store' });
    manifest = await res.json();
    if (!manifest || !Array.isArray(manifest.clips)) return;
  } catch (_) { return; }

  const reel = document.getElementById('reel');
  reel.innerHTML = '';

  // Build DOM from manifest
  const clips = manifest.clips.map((c, i) => {
    const wrap = document.createElement('section');
    wrap.className = 'clip';
    wrap.dataset.title = (c.title || '');
    let ov = (typeof c.overlap === 'number' ? c.overlap : -10);
    ov = Math.max(isSmall ? -8 : -12, Math.min(isSmall ? -4 : -6, ov));
    if (i > 0) wrap.style.marginTop = `${ov}px`;
    wrap.style.marginBottom = '4px';
    
    const baseSpeed = Number(c.parallax || 0);
    const speed = (isSmall || prefersReduced) ? baseSpeed * 0.6 : baseSpeed;
    wrap.dataset.speed = String(speed);

    const frame = document.createElement('div');
    frame.className = 'frame';
    if (c.aspect && typeof c.aspect === 'number') frame.style.aspectRatio = `${c.aspect} / 1`;
    const finalUrl = buildVimeoUrl(c.embedUrl);
    frame.dataset.embed = finalUrl; // defer actual iframe creation
    frame.style.background = '#000';
    wrap.appendChild(frame);
    
    reel.appendChild(wrap);
    return wrap;
  });

  // -------- DESKTOP: keep rAF heartbeat loader --------
  const frames = Array.from(document.querySelectorAll('.frame'));

  function mountIframeEager(frame) {
    if (!frame || frame.dataset.mounted === '1') return false;
    const src = frame.dataset.embed; if (!src) return false;

    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    // no loading="lazy" on mobile for reliability
    Object.assign(iframe.style, { border:'0', position:'absolute', inset:'0', width:'100%', height:'100%' });
    frame.style.position = 'relative';
    frame.appendChild(iframe);
    frame.dataset.mounted = '1';

    // If you have registerPlayer(iframe) for freeze-nudge, call it here ONLY on mobile
    if (typeof registerPlayer === 'function' && isSmall) { registerPlayer(iframe); }

    return true;
  }
  function unmountIframe(frame) {
    if (!frame || frame.dataset.mounted !== '1') return;
    const ifr = frame.querySelector('iframe');
    if (ifr) try { ifr.remove(); } catch {}
    frame.dataset.mounted = '0';
  }

  function clipIndexFor(el) { return frames.indexOf(el); }
  function nearestIndexToViewportCenter() {
    let best = 0, bestD = Infinity;
    const vhc = window.innerHeight / 2;
    frames.forEach((f, i) => {
      const r = f.getBoundingClientRect();
      const c = r.top + r.height / 2;
      const d = Math.abs(c - vhc);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  const desktopConfig = {
    initialBurstCount: 12,
    batchSize: 5,
    maxConcurrent: 12,
    loadTimeoutMs: 7000,
    heartbeatMs: 80,
    watchdogMs: 1500,
    finalSweepMs: 12000
  };

  const mobileConfig = {
    // We'll load strictly one-by-one for reliability
    loadTimeoutMs: 8000,
    initialBurstCount: 3 // optional: eager mount a couple before sequential
  };

  // Shared mount primitive
  let inFlight = 0;
  function mountIframe(frame, eager = false) {
    if (!frame || frame.dataset.mounted === '1') return false;
    const src = frame.dataset.embed;
    if (!src) return false;

    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    if (!eager) iframe.setAttribute('loading', 'lazy');
    Object.assign(iframe.style, { border:'0', position:'absolute', inset:'0', width:'100%', height:'100%' });

    frame.style.position = 'relative';
    frame.appendChild(iframe);
    frame.dataset.mounted = '1';
    if (isSmall) { registerPlayer(iframe); }

    return true;
  }

  // --- FreezeGuard registry (MOBILE ONLY) ---
  const players = []; // { el, player, lastTime, lastUpdate, freezeHits, title }
  function registerPlayer(iframeEl) {
    if (!isSmall) return; // mobile only
    if (!window.Vimeo || !window.Vimeo.Player) return;
    try {
      const p = new Vimeo.Player(iframeEl);
      const clipEl = iframeEl.closest('.clip');
      const title = (clipEl && clipEl.dataset && clipEl.dataset.title) ? clipEl.dataset.title : '';
      const rec = { el: iframeEl, player: p, lastTime: 0, lastUpdate: performance.now(), freezeHits: 0, title };
      players.push(rec);
      p.on('timeupdate', (data) => {
        rec.lastTime   = (data && typeof data.seconds === 'number') ? data.seconds : rec.lastTime;
        rec.lastUpdate = performance.now();
        rec.freezeHits = 0; // reset when progressing
      });
    } catch(_) {}
  }

  const PROBLEM_TITLES = new Set([
    'Hybrid — CU',
    'Hybrid — Field',
    'Hybrid — Sky',
    'Hybrid — House',
    'TEW — Twist',
    'TEW — CU',
    'TEW — Pull',
    'Jump — Push In',
    'Jump — Whip Pan',
    'Jump — Oner',
    'Jump — Joyrider',
    'Jump — Lineup',
    'Journey — Beach',
    'Journey — Cliff',
    'Journey — Piano',
    'Journey — Whale'
  ]);


  // --- DESKTOP: rAF heartbeat loader (parallel + staggered), unchanged behavior ---
  function desktopHeartbeatLoad() {
    const cfg = desktopConfig;
    let nextIndex = 0;
    let lastBeat = 0;

    // Eager burst
    for (let i = 0; i < Math.min(cfg.initialBurstCount, frames.length); i++) {
      if (inFlight >= cfg.maxConcurrent) break;
      const mounted = mountIframe(frames[i], /* eager */ true);
      if (mounted) inFlight++;
    }
    nextIndex = cfg.initialBurstCount;

    function mountWithTimeout(frame) {
      if (!frame || frame.dataset.mounted === '1') return false;
      if (inFlight >= cfg.maxConcurrent) return false;
      const ok = mountIframe(frame, /* eager */ false);
      if (!ok) return false;
      inFlight++;
      let settled = false;
      const ifr = frame.querySelector('iframe');
      const t = setTimeout(() => { if (!settled) { settled = true; inFlight = Math.max(0, inFlight - 1); } }, cfg.loadTimeoutMs);
      if (ifr) {
        ifr.addEventListener('load', () => { if (!settled) { clearTimeout(t); settled = true; inFlight = Math.max(0, inFlight - 1); } }, { once: true });
      } else {
        clearTimeout(t); inFlight = Math.max(0, inFlight - 1);
      }
      return true;
    }

    function beat(ts) {
      if (!lastBeat || (ts - lastBeat) >= cfg.heartbeatMs) {
        lastBeat = ts;
        let mountedThisBeat = 0;
        while (mountedThisBeat < cfg.batchSize && nextIndex < frames.length) {
          const before = inFlight;
          const ok = mountWithTimeout(frames[nextIndex]);
          if (ok && inFlight > before) { mountedThisBeat++; nextIndex++; }
          else break;
        }
      }
      if (nextIndex < frames.length) requestAnimationFrame(beat);
    }
    requestAnimationFrame(beat);

    const watchdog = setInterval(() => {
      if (nextIndex >= frames.length) { clearInterval(watchdog); return; }
      let mountedThisTick = 0;
      while (mountedThisTick < Math.max(1, Math.floor(desktopConfig.batchSize / 2)) && nextIndex < frames.length) {
        const before = inFlight;
        const ok = mountWithTimeout(frames[nextIndex]);
        if (ok && inFlight > before) { mountedThisTick++; nextIndex++; }
        else break;
      }
    }, desktopConfig.watchdogMs);

    // Final sweep
    setTimeout(() => {
      for (let i = 0; i < frames.length; i++) {
        if (frames[i].dataset.mounted !== '1') {
          mountIframe(frames[i], /* eager */ true);
          const iframe = frames[i].querySelector('iframe');
          if (iframe && isSmall) { registerPlayer(iframe); }
        }
      }
    }, desktopConfig.finalSweepMs);
  }

  // Entry point: choose loader per device
  if (isSmall) {
    const frames = Array.from(document.querySelectorAll('.frame'));

    const eagerCount          = Math.min(1, frames.length); // tiny eager burst
    const interMountDelayMs   = 400;  // spacing between mounts
    const loadTimeoutMs       = 12000; // give iOS time
    const apiSettleWaitMs     = 700;  // wait after API recovery before moving on
    const maxApiRetries       = 2;    // per clip

    // Helper: mount one iframe (NO lazy on mobile)
    function mountIframeEager(frame) {
      if (!frame || frame.dataset.mounted === '1') return null;
      const src = frame.dataset.embed; if (!src) return null;

      const iframe = document.createElement('iframe');
      iframe.src = src;
      iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      // IMPORTANT: no loading="lazy" on mobile
      Object.assign(iframe.style, { border:'0', position:'absolute', inset:'0', width:'100%', height:'100%' });

      frame.style.position = 'relative';
      frame.appendChild(iframe);
      frame.dataset.mounted = '1';

      // Register for freeze-nudge (mobile only)
      if (typeof registerPlayer === 'function') registerPlayer(iframe);

      return iframe;
    }

    // Helper: API-based recovery for a stuck player (no UI)
    async function apiRecover(frame) {
      if (!window.Vimeo || !window.Vimeo.Player) return false;
      const ifr = frame.querySelector('iframe');
      if (!ifr) return false;
      try {
        const p = new Vimeo.Player(ifr);
        // Try a gentle nudge first (play); if that fails, unload and resume
        await p.play().catch(()=>{});
        // Wait briefly; if still not progressing, do unload cycle
        await new Promise(r => setTimeout(r, 300));
        const before = await p.getCurrentTime().catch(()=>null);
        await new Promise(r => setTimeout(r, 300));
        const after  = await p.getCurrentTime().catch(()=>null);
        const progressed = (typeof before==='number' && typeof after==='number' && after > before + 0.01);
        if (progressed) return true;

        await p.unload().catch(()=>{});
        await new Promise(r => setTimeout(r, 200));
        await p.play().catch(()=>{});
        await new Promise(r => setTimeout(r, apiSettleWaitMs));
        return true;
      } catch { return false; }
    }

    (async () => {
      // 0) tiny eager burst so page shows life
      for (let i = 0; i < eagerCount; i++) {
        mountIframeEager(frames[i]);
        await new Promise(r => setTimeout(r, 250));
      }

      // 1) strict sequential mounting with timeout + API recovery (no unmounting)
      for (let i = eagerCount; i < frames.length; i++) {
        const f = frames[i];
        if (!f || f.dataset.mounted === '1') continue;

        const ifr = mountIframeEager(f);

        // Wait for 'load' OR timeout; then attempt API recovery up to 2x if needed
        let loaded = await new Promise((resolve) => {
          let settled = false;
          const t = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, loadTimeoutMs);
          if (ifr) {
            ifr.addEventListener('load', () => {
              if (!settled) { clearTimeout(t); settled = true; }
              resolve(true);
            }, { once: true });
          } else {
            clearTimeout(t); resolve(false);
          }
        });

        if (!loaded) {
          // iframe didn't fire 'load'—try API recovery cycles
          let recovered = false;
          for (let r = 0; r < maxApiRetries && !recovered; r++) {
            recovered = await apiRecover(f);
          }
        }

        // spacing before next mount
        await new Promise(r => setTimeout(r, interMountDelayMs));
      }

      // 2) final sweep at ~15s: eagerly attach any that somehow missed
      setTimeout(() => {
        frames.forEach(f => {
          if (f.dataset.mounted !== '1') mountIframeEager(f);
        });
      }, 15000);
    })();

    // (Optional) if your freeze-nudge loop isn't already running mobile-only, start it:
    if (typeof nudgeFrozenPlayers === 'function' && !window.__nudgeLoopStarted) {
      window.__nudgeLoopStarted = true;
      // Use whatever constants you defined earlier; example interval name shown:
      // setInterval(nudgeFrozenPlayers, FREEZE_CHECK_MS);
    }
  } else {
    desktopHeartbeatLoad();
  }

  // Optional console helper for you
  window.reportVimeoMounts = () => {
    const total = frames.length;
    const mounted = frames.filter(f => f.dataset.mounted === '1').length;
    return { total, mounted, inFlight };
  };

  // Subtle per-clip parallax
  let ticking = false;
  function applyParallax() {
    const viewportCenter = window.innerHeight / 2;
    // Use a cached NodeList each frame to avoid layout thrash
    document.querySelectorAll('.clip').forEach(el => {
      const s = parseFloat(el.dataset.speed || '0') || 0;
      if (!s) { el.style.transform = ''; return; }
      const rect = el.getBoundingClientRect();
      const elCenter = rect.top + rect.height / 2;
      const delta = viewportCenter - elCenter; // positive when element is below center
      el.style.transform = `translateY(${delta * s}px)`;
    });
    ticking = false;
  }
  // Keep the same scroll listener but also listen to resize and load:
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(applyParallax); } };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  window.addEventListener('load', onScroll);
  applyParallax();

  // Background audio: robust click-to-start
  let audioStarted = false, audio;
  function ensureAudio() {
    if (!audio) {
      audio = new Audio('./assets/audio/bg.mp3');
      audio.loop = true;
      audio.preload = 'auto';
      audio.volume = 1.0;
    }
    return audio;
  }
  async function startAudioOnce() {
    if (audioStarted) return;
    audioStarted = true;
    const a = ensureAudio();
    try { await a.play(); }
    catch { try { a.load(); setTimeout(() => a.play().catch(()=>{}), 60); } catch {}
    }
  }
  ['click','pointerdown','touchstart','keydown'].forEach(ev =>
    window.addEventListener(ev, startAudioOnce, { once: true, passive: true })
  );

  // --- FreezeGuard (stall detection + nudge + API recovery + last-resort remount). MOBILE ONLY ---
  if (isSmall) {
    // Tunables (safe defaults)
    const BASE_FREEZE_WINDOW_MS = 2000;
    const BASE_NUDGE_SECS       = 0.08;
    const BASE_NUDGE_CAP_SECS   = 0.20;

    const STRONG_FREEZE_WINDOW_MS = 1500; // for problem clips
    const STRONG_NUDGE_SECS       = 0.12;
    const STRONG_NUDGE_CAP_SECS   = 0.25;

    const CHECK_MS               = 900;  // how often to check for stalls
    const BACKOFF_MS             = 600;  // brief wait after each nudge
    const API_RETRIES            = 2;    // API recovery attempts per stall episode
    const HARD_REMOUNT_AFTER_HITS = 3;   // if repeated nudges fail, remount iframe

    async function apiRecover(rec) {
      try {
        await rec.player.play().catch(()=>{});
        await new Promise(r => setTimeout(r, 300));
        const t1 = await rec.player.getCurrentTime().catch(()=>null);
        await new Promise(r => setTimeout(r, 300));
        const t2 = await rec.player.getCurrentTime().catch(()=>null);
        if (typeof t1 === 'number' && typeof t2 === 'number' && t2 > t1 + 0.01) return true;

        await rec.player.unload().catch(()=>{});
        await new Promise(r => setTimeout(r, 200));
        await rec.player.play().catch(()=>{});
        await new Promise(r => setTimeout(r, 500));
        return true;
      } catch { return false; }
    }

    function hardRemount(rec) {
      const frame = rec.el && rec.el.parentElement;
      if (!frame) return false;
      try { rec.el.remove(); } catch {}
      const src = frame.dataset.embed; if (!src) return false;
      const ifr = document.createElement('iframe');
      ifr.src = src;
      ifr.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      Object.assign(ifr.style, { border:'0', position:'absolute', inset:'0', width:'100%', height:'100%' });
      frame.style.position = 'relative';
      frame.appendChild(ifr);
      frame.dataset.mounted = '1';
      registerPlayer(ifr);
      return true;
    }

    async function nudgeOne(rec) {
      const strong = PROBLEM_TITLES.has(rec.title);
      const windowMs = strong ? STRONG_FREEZE_WINDOW_MS : BASE_FREEZE_WINDOW_MS;
      const baseStep = strong ? STRONG_NUDGE_SECS       : BASE_NUDGE_SECS;
      const capStep  = strong ? STRONG_NUDGE_CAP_SECS   : BASE_NUDGE_CAP_SECS;

      const now = performance.now();
      if (now - rec.lastUpdate <= windowMs) return; // not frozen

      const step = Math.min(capStep, baseStep + rec.freezeHits * 0.04);
      try {
        const cur = await rec.player.getCurrentTime().catch(()=>null);
        if (typeof cur === 'number') {
          const jitter = Math.random() * 0.02;
          await rec.player.setCurrentTime(Math.max(0, cur + step + jitter)).catch(()=>{});
        }
        await rec.player.play().catch(()=>{});
      } catch {}

      rec.freezeHits++;
      await new Promise(r => setTimeout(r, BACKOFF_MS));

      if (rec.freezeHits === 2) {
        let ok = false;
        for (let i = 0; i < API_RETRIES && !ok; i++) ok = await apiRecover(rec);
      }
      if (rec.freezeHits >= HARD_REMOUNT_AFTER_HITS) {
        hardRemount(rec);
        rec.freezeHits = 0;
      }
    }

    function FreezeGuardTick() {
      if (!players.length) return;
      players.forEach(rec => {
        if (!rec.el || !rec.el.isConnected) return;
        nudgeOne(rec);
      });
    }

    if (!window.__FreezeGuardTimer) {
      window.__FreezeGuardTimer = setInterval(FreezeGuardTick, CHECK_MS);
    }
  }

  // --- MountGuard (handles truly missing/never-mounted iframes). MOBILE ONLY ---
  if (isSmall) {
    // Tunables for mount assurance
    const MOUNT_CHECK_MS    = 2000;  // re-check cadence for missing iframes
    const MOUNT_START_DELAY = 4000;  // wait a bit for normal loader to do its job
    const MOUNT_DEADLINE_MS = 20000; // after this, aggressively attach any remaining

    function mountIfMissing(frame) {
      if (!frame) return;
      if (frame.querySelector('iframe')) return; // already mounted
      const src = frame.dataset.embed; if (!src) return;
      const ifr = document.createElement('iframe');
      ifr.src = src;
      ifr.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      // no loading="lazy" on mobile for reliability
      Object.assign(ifr.style, { border:'0', position:'absolute', inset:'0', width:'100%', height:'100%' });
      frame.style.position = 'relative';
      frame.appendChild(ifr);
      frame.dataset.mounted = '1';
      registerPlayer(ifr);
    }

    // Periodic assurance pass (lightweight)
    function MountGuardTick() {
      document.querySelectorAll('.frame').forEach(frame => {
        mountIfMissing(frame);
      });
    }

    // Start after a short delay, then repeat periodically
    setTimeout(() => {
      if (!window.__MountGuardTimer) {
        window.__MountGuardTimer = setInterval(MountGuardTick, MOUNT_CHECK_MS);
      }
    }, MOUNT_START_DELAY);

    // Aggressive deadline sweep: ensure absolutely everything has an iframe
    setTimeout(() => {
      document.querySelectorAll('.frame').forEach(frame => {
        mountIfMissing(frame);
      });
    }, MOUNT_DEADLINE_MS);
  }
})();