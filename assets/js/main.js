(async function () {
  'use strict';

  const isSmall = window.matchMedia('(max-width: 768px)').matches;
  window.__BLACKGUARD_ENABLED ??= true; // kill switch
  window.__STALLGUARD_ENABLED ??= true; // kill switch
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

  // MOBILE LOADER — simple, persistent, sequential (NO unmounting, NO lazy)
  if (isSmall) {
    const frames = Array.from(document.querySelectorAll('.frame'));
    const eagerCount        = Math.min(1, frames.length);
    const interDelayMs      = 380;   // spacing between mounts
    const loadTimeoutMs     = 12000; // give iOS time

    function mountIframe(frame) {
      if (!frame || frame.dataset.mounted === '1') return null;
      const src = frame.dataset.embed; if (!src) return null;
      const ifr = document.createElement('iframe');
      ifr.src = src;
      ifr.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      // NO loading="lazy" on mobile
      Object.assign(ifr.style, { border:'0', position:'absolute', inset:'0', width:'100%', height:'100%' });
      frame.style.position = 'relative';
      frame.appendChild(ifr);
      frame.dataset.mounted = '1';
      // register for playback orchestration (defined below)
      if (typeof registerMobilePlayer === 'function') registerMobilePlayer(ifr);
      return ifr;
    }

    (async () => {
      // tiny eager burst
      for (let i = 0; i < eagerCount; i++) {
        mountIframe(frames[i]);
        await new Promise(r => setTimeout(r, 220));
      }
      // strict sequential mounting
      for (let i = eagerCount; i < frames.length; i++) {
        const f = frames[i];
        if (f.dataset.mounted === '1') continue;
        const ifr = mountIframe(f);
        await new Promise((resolve) => {
          let settled = false;
          const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, loadTimeoutMs);
          if (ifr) {
            ifr.addEventListener('load', () => { if (!settled) { clearTimeout(t); settled = true; } resolve(); }, { once: true });
          } else {
            clearTimeout(t); resolve();
          }
        });
        await new Promise(r => setTimeout(r, interDelayMs));
      }
    })();
  }

  // MOBILE PLAYBACK ORCHESTRATOR — small, reliable, single instance
  if (isSmall) {
    // Avoid duplicates if hot-reloaded
    window.__mobOrchestrator && window.__mobOrchestrator.stop && window.__mobOrchestrator.stop();

    const registry = []; // { el, player, lastTime, lastUpdate, ensuring, ready, lastPlayedAt }
    const NEAR_PX        = 2000;  // treat ± ~2.5 screens as "near"
    const FAR_PX         = 3400;  // only pause if well outside this
    const MAX_ACTIVE     = 5;     // try current + 2 above + 2 below
    const TICK_MS        = 1100;  // slower cadence = less churn
    const RESUME_CHECK_MS= 600;
    const NUDGE_SECS     = 0.10;  // slightly stronger resume nudge
    const SOFT_KEEP_MS   = 1500;  // keep newly-started clips alive briefly

    function registerMobilePlayer(ifr) {
      if (!window.Vimeo || !window.Vimeo.Player) return;
      try {
        const p = new Vimeo.Player(ifr);
        const rec = { el: ifr, player: p, lastTime: 0, lastUpdate: performance.now(), ensuring: false, ready: false, lastPlayedAt: 0 };
        registry.push(rec);
        p.on('timeupdate', (data) => {
          rec.lastTime   = (data && typeof data.seconds === 'number') ? data.seconds : rec.lastTime;
          rec.lastUpdate = performance.now();
          rec.ready = true;
        });
        // try to set moderate quality if available (non-fatal if not supported)
        p.getQualities && p.getQualities().then(qs => {
          if (Array.isArray(qs) && qs.includes('540p')) { p.setQuality('540p').catch(()=>{}); }
        }).catch(()=>{});
      } catch {}
    }
    // expose for the loader to call
    window.registerMobilePlayer = registerMobilePlayer;

    function distToCenter(el) {
      const r = el.getBoundingClientRect();
      const c = r.top + r.height/2;
      return Math.abs(c - window.innerHeight/2);
    }

    async function ensurePlaying(rec) {
      if (rec.ensuring) return;
      rec.ensuring = true;
      try {
        const before = await rec.player.getCurrentTime().catch(()=>null);
        await rec.player.play().catch(()=>{});
        await new Promise(r => setTimeout(r, RESUME_CHECK_MS));
        const after = await rec.player.getCurrentTime().catch(()=>null);
        const progressed = (typeof before==='number' && typeof after==='number' && after > before + 0.01);
        if (!progressed) {
          // gentle nudge forward + play again
          if (typeof before === 'number') {
            const jitter = Math.random() * 0.02;
            await rec.player.setCurrentTime(Math.max(0, before + NUDGE_SECS + jitter)).catch(()=>{});
          }
          await rec.player.play().catch(()=>{});
        }
        rec.lastPlayedAt = performance.now();
      } catch {}
      rec.ensuring = false;
    }

    async function ensurePaused(rec) {
      try {
        const r = rec.el.getBoundingClientRect();
        const center = r.top + r.height/2;
        const d = Math.abs(center - window.innerHeight/2);
        const justPlayed = (performance.now() - (rec.lastPlayedAt || 0)) < SOFT_KEEP_MS;
        if (d <= FAR_PX || justPlayed) return; // keep it running
        await rec.player.pause().catch(()=>{});
      } catch {}
    }

    function tick() {
      if (!registry.length) return;
      // Rank by distance to viewport center
      const ranked = registry.filter(r => r.el && r.el.isConnected)
        .map(r => ({ r, d: distToCenter(r.el) }))
        .sort((a,b) => a.d - b.d);

      // Choose near candidates
      const actives = [];
      for (const item of ranked) {
        if (item.d <= NEAR_PX && actives.length < MAX_ACTIVE) actives.push(item.r);
      }
      // Apply
      const activeSet = new Set(actives);
      for (const { r } of ranked) {
        if (activeSet.has(r)) ensurePlaying(r);
        else ensurePaused(r);
      }
    }

    const id = setInterval(tick, TICK_MS);
    window.addEventListener('scroll', () => tick(), { passive: true });
    window.addEventListener('resize', () => tick());
    window.addEventListener('load', () => tick());
    tick();

    window.__mobOrchestrator = {
      stop() { clearInterval(id); }
    };

    // Console diagnostics helper
    window.mobStatus = () => {
      try {
        const els = Array.from(document.querySelectorAll('.frame iframe'));
        const playing = [];
        const paused  = [];
        return Promise.all(els.map(el => {
          try {
            const p = new Vimeo.Player(el);
            return p.getPaused().then(isPaused => {
              (isPaused ? paused : playing).push(el);
            }).catch(()=>{});
          } catch { }
        })).then(() => ({ playing: playing.length, paused: paused.length, total: els.length }));
      } catch { return { playing: 0, paused: 0, total: 0 }; }
    };
  }

  // -------- DESKTOP: rAF heartbeat loader (unchanged) --------
  if (!isSmall) {
    const frames = Array.from(document.querySelectorAll('.frame'));

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

      return true;
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

    let inFlight = 0;
    let nextIndex = 0;
    let lastBeat = 0;

    // Eager burst
    for (let i = 0; i < Math.min(desktopConfig.initialBurstCount, frames.length); i++) {
      if (inFlight >= desktopConfig.maxConcurrent) break;
      const mounted = mountIframe(frames[i], /* eager */ true);
      if (mounted) inFlight++;
    }
    nextIndex = desktopConfig.initialBurstCount;

    function mountWithTimeout(frame) {
      if (!frame || frame.dataset.mounted === '1') return false;
      if (inFlight >= desktopConfig.maxConcurrent) return false;
      const ok = mountIframe(frame, /* eager */ false);
      if (!ok) return false;
      inFlight++;
      let settled = false;
      const ifr = frame.querySelector('iframe');
      const t = setTimeout(() => { if (!settled) { settled = true; inFlight = Math.max(0, inFlight - 1); } }, desktopConfig.loadTimeoutMs);
      if (ifr) {
        ifr.addEventListener('load', () => { if (!settled) { clearTimeout(t); settled = true; inFlight = Math.max(0, inFlight - 1); } }, { once: true });
      } else {
        clearTimeout(t); inFlight = Math.max(0, inFlight - 1);
      }
      return true;
    }

    function beat(ts) {
      if (!lastBeat || (ts - lastBeat) >= desktopConfig.heartbeatMs) {
        lastBeat = ts;
        let mountedThisBeat = 0;
        while (mountedThisBeat < desktopConfig.batchSize && nextIndex < frames.length) {
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
        }
      }
    }, desktopConfig.finalSweepMs);
  }

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

  // BlackGuard: Detect and revive black (non-playing) iframes on mobile
  if (isSmall && window.__BLACKGUARD_ENABLED) {
    // Stop any prior instance (hot reload safety)
    if (window.__blackGuard && typeof window.__blackGuard.stop === 'function') {
      window.__blackGuard.stop();
    }

    const BG = {
      recs: new Map(),            // iframe -> record
      TICK_MS: 1200,              // sweep cadence
      BLACK_MS: 6000,             // no timeupdate within 6s of mount => BLACK
      ACTION_COOLDOWN_MS: 1500,   // min time between actions for the same clip
      REMOUNT_COOLDOWN_MS: 30000  // min 30s between remounts per clip
    };

    function getRec(ifr) {
      let r = BG.recs.get(ifr);
      if (!r) {
        r = {
          ifr,
          player: null,
          mountedAt: performance.now(),
          firstTimeUpdateAt: 0,
          lastActionAt: 0,
          remounts: 0,
          lastRemountAt: 0
        };
        try {
          r.player = new Vimeo.Player(ifr);
          r.player.on('timeupdate', () => {
            if (!r.firstTimeUpdateAt) r.firstTimeUpdateAt = performance.now();
          });
        } catch (_) {}
        BG.recs.set(ifr, r);
      }
      return r;
    }

    function seed() {
      document.querySelectorAll('.frame iframe').forEach(ifr => getRec(ifr));
    }

    async function apiPlay(rec) {
      try { await rec.player.play().catch(()=>{}); } catch {}
    }

    function hardRemount(rec) {
      const now = performance.now();
      if (now - rec.lastRemountAt < BG.REMOUNT_COOLDOWN_MS) return false;
      const frame = rec.ifr && rec.ifr.parentElement;
      if (!frame) return false;

      try { rec.ifr.remove(); } catch {}
      const src = frame.dataset.embed;
      if (!src) return false;

      const ifr = document.createElement('iframe');
      ifr.src = src;
      ifr.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      Object.assign(ifr.style, { border:'0', position:'absolute', inset:'0', width:'100%', height:'100%' });
      frame.style.position = 'relative';
      frame.appendChild(ifr);
      frame.dataset.mounted = '1';

      const newRec = getRec(ifr);
      newRec.remounts = (rec.remounts || 0) + 1;
      newRec.lastRemountAt = now;
      BG.recs.delete(rec.ifr);
      return true;
    }

    function stateOf(rec) {
      const now = performance.now();
      if (!rec.ifr || !rec.ifr.isConnected) return 'MISSING';
      if (!rec.firstTimeUpdateAt && (now - rec.mountedAt) > BG.BLACK_MS) return 'BLACK';
      return 'OK';
    }

    let id = null;
    async function tick() {
      seed(); // pick up any newly mounted iframes
      const now = performance.now();

      BG.recs.forEach(async (rec) => {
        const st = stateOf(rec);
        if (st !== 'BLACK') return;

        if (now - rec.lastActionAt < BG.ACTION_COOLDOWN_MS) return;
        rec.lastActionAt = now;

        // 1) Try API play() first
        await apiPlay(rec);

        // If still black next sweep, remount (guarded by cooldown)
        // We check "still black" implicitly on the next tick via stateOf(rec)
        // This tick only triggers play(); the next tick may remount if needed.
      });
    }

    // On the NEXT tick (after a prior play() attempt), if still BLACK, remount
    async function remountPass() {
      const now = performance.now();
      BG.recs.forEach((rec) => {
        const st = stateOf(rec);
        if (st !== 'BLACK') return;
        if (now - rec.lastActionAt < BG.ACTION_COOLDOWN_MS) return;
        rec.lastActionAt = now;
        hardRemount(rec);
      });
    }

    function start() {
      seed();
      const main = setInterval(tick, BG.TICK_MS);
      const rmnt = setInterval(remountPass, BG.TICK_MS * 2); // slower than main tick
      window.addEventListener('load', tick);
      window.addEventListener('scroll', () => tick(), { passive: true });
      window.addEventListener('resize', () => tick());

      window.__blackGuard = {
        stop() { clearInterval(main); clearInterval(rmnt); }
      };
    }

    start();

    // Console helper: see how many are alive vs black
    window.mobBlack = () => {
      let total = 0, alive = 0, black = 0;
      BG.recs.forEach(rec => {
        total++;
        if (rec.firstTimeUpdateAt) alive++; else black++;
      });
      const out = { total, alive, black };
      console.log('BlackGuard', out);
      return out;
    };
  }

  // StallGuard: Detect and revive clips that started but later freeze (mobile only)
  if (isSmall && window.__STALLGUARD_ENABLED) {
    // Stop any prior instance (hot reload safety)
    if (window.__stallGuard && typeof window.__stallGuard.stop === 'function') {
      window.__stallGuard.stop();
    }

    // Tunables (safe defaults)
    const TICK_MS   = 1200;  // sweep cadence
    const STALL_MS  = 2200;  // no progress for >2.2s => stalled
    const COOLDOWN  = 3000;  // min time between actions per clip
    const STEP      = 0.08;  // small seek forward
    const MAX_API_PER_30S = 1;  // api-recover at most once per 30s
    const API_WINDOW_MS   = 30000;
    const NEAR_PX = 1800;   // only help clips near viewport

    function distToCenter(el) {
      const r = el.getBoundingClientRect();
      const c = r.top + r.height / 2;
      return Math.abs(c - window.innerHeight / 2);
    }

    // Track last progress + last actions per iframe
    const seen = new WeakMap(); // iframe -> { lastUpdate, lastNudge, lastApi, apiCountWindowStart }

    function attachProgressTracker(ifr) {
      let s = seen.get(ifr);
      if (!s) {
        s = { lastUpdate: performance.now(), lastNudge: 0, lastApi: 0, apiCountWindowStart: performance.now(), apiCount: 0 };
        seen.set(ifr, s);
        try {
          const p = new Vimeo.Player(ifr);
          p.on('timeupdate', () => { s.lastUpdate = performance.now(); });
        } catch {}
      }
      return s;
    }

    async function nudgeForward(p) {
      try {
        const cur = await p.getCurrentTime().catch(()=>null);
        if (typeof cur === 'number') {
          const jitter = Math.random() * 0.02;
          await p.setCurrentTime(Math.max(0, cur + STEP + jitter)).catch(()=>{});
        }
        await p.play().catch(()=>{});
      } catch {}
    }

    async function apiRecoverLimited(ifr) {
      const s = seen.get(ifr) || attachProgressTracker(ifr);
      const now = performance.now();
      // reset count window if elapsed
      if (now - s.apiCountWindowStart > API_WINDOW_MS) {
        s.apiCountWindowStart = now; s.apiCount = 0;
      }
      if (s.apiCount >= MAX_API_PER_30S) return false;
      try {
        const p = new Vimeo.Player(ifr);
        await p.play().catch(()=>{});
        s.lastApi = now; s.apiCount++;
        return true;
      } catch { return false; }
    }

    async function tick() {
      const ifrs = document.querySelectorAll('.frame iframe');
      const now = performance.now();

      for (const ifr of ifrs) {
        // Only consider iframes that have already produced timeupdate (BlackGuard handles never-started)
        const s = attachProgressTracker(ifr);
        const d = distToCenter(ifr);
        if (d > NEAR_PX) continue; // only help nearby clips

        const stalled = (now - s.lastUpdate) > STALL_MS;
        if (!stalled) continue;

        // Respect per-clip cooldown
        if (now - s.lastNudge < COOLDOWN) continue;

        s.lastNudge = now;

        // 1) gentle play() request
        try { await new Vimeo.Player(ifr).play().catch(()=>{}); } catch {}

        // 2) if still stalled next pass, apply forward nudge
        setTimeout(async () => {
          const s2 = seen.get(ifr) || s;
          if ((performance.now() - s2.lastUpdate) > STALL_MS) {
            await nudgeForward(new Vimeo.Player(ifr));
          }
        }, 400);

        // 3) if STILL stalled on a later sweep, allow one API recover per 30s
        setTimeout(async () => {
          const s3 = seen.get(ifr) || s;
          if ((performance.now() - s3.lastUpdate) > (STALL_MS * 2)) {
            await apiRecoverLimited(ifr);
          }
        }, 1000);
      }
    }

    const id = setInterval(tick, TICK_MS);
    window.addEventListener('scroll', () => tick(), { passive: true });
    window.addEventListener('resize', () => tick());
    window.addEventListener('load', () => tick());

    window.__stallGuard = { stop(){ clearInterval(id); } };

    // Console helper: quick snapshot of stalled vs total near viewport
    window.mobStall = () => {
      const out = { near: 0, stalled: 0 };
      document.querySelectorAll('.frame iframe').forEach(ifr => {
        const s = seen.get(ifr);
        if (!s) return;
        if (distToCenter(ifr) <= NEAR_PX) {
          out.near++;
          if ((performance.now() - s.lastUpdate) > STALL_MS) out.stalled++;
        }
      });
      console.log('StallGuard:', out);
      return out;
    };
  }
})();