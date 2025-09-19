(async function () {
  'use strict';

  const isSmall = window.matchMedia('(max-width: 768px)').matches;
  window.__BLACKGUARD_ENABLED ??= true; // kill switch
  window.__STALL_NUDGE_ENABLED ??= true;
  window.__OVERLAP_ENABLED ??= true;
  window.__PARALLAX_ENABLED ??= true;
  window.__PARALLAX_GAIN ??= 2.0;
  // Global parallax smoothing
  const LERP_DESKTOP = 0.12;   // previously 0.10
  const LERP_MOBILE  = 0.16;   // previously 0.14
  // Cap how far the eased value can move per frame (in pixels)
  const MAX_STEP_PX  = 60;     // previously 80
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
  const PROD_VERSION = '1.0.0';   // bump when you change manifest
  let manifest;
  try {
    const res = await fetch(`./assets/js/manifest.json?v=${PROD_VERSION}`, { cache: 'no-store' });
    manifest = await res.json();
    if (!manifest || !Array.isArray(manifest.clips)) return;
  } catch (_) { return; }

  const reel = document.getElementById('reel');
  reel.innerHTML = '';

  // Build DOM from manifest
  const clips = manifest.clips.map((c, i) => {
    const wrap = document.createElement('section');
    wrap.className = 'clip';
    
    // Read overlap (pixels) from manifest; store for debug
    const ov = (typeof c.overlap === 'number') ? c.overlap : parseFloat(c.overlap || '0') || 0;
    wrap.dataset.title = c.title || '';
    wrap.dataset.overlap = String(ov);
    
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
    
    // Apply overlap to the INNER frame (no conflict with parallax on wrapper)
    if (window.__OVERLAP_ENABLED) {
      // Negative ov pulls the frame upward; positive pushes it down
      const prev = frame.style.transform || '';
      // Ensure we don't overwrite any existing frame transform (rare); append translate
      frame.style.transform = `${prev ? prev + ' ' : ''}translate3d(0, ${ov}px, 0)`;
      frame.style.willChange = 'transform';
    }
    
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
    window.__mobOrchestrator?.stop?.();

    const registry = []; // { el, player, lastTime, lastUpdate, ensuring, ready, lastPlayedAt }
    const NEAR_PX        = 2000;  // treat ± ~2.5 screens as "near"
    const FAR_PX         = 3400;  // only pause if well outside this
    const MAX_ACTIVE     = 5;     // try current + 2 above + 2 below
    const TICK_MS        = 1100;  // slower cadence = less churn
    const RESUME_CHECK_MS= 600;
    const NUDGE_SECS     = 0.10;  // slightly stronger resume nudge
    const SOFT_KEEP_MS   = 1500;  // keep newly-started clips alive briefly

    // Registry of progress per active iframe
    const __mobReg = new WeakMap(); // iframe -> record

    function regFor(ifr){
      let rec = __mobReg.get(ifr);
      if (!rec) {
        rec = {
          player: null,
          firstUpdateAt: 0,
          lastUpdateAt: 0,
          lastActionAt: 0,
          apiCount: 0,
          apiWindowStart: performance.now()
        };
        try {
          rec.player = new Vimeo.Player(ifr);
          rec.player.on('timeupdate', () => {
            rec.firstUpdateAt ||= performance.now();
            rec.lastUpdateAt = performance.now();
          });
        } catch(_) {}
        __mobReg.set(ifr, rec);
      }
      return rec;
    }

    async function apiPlay(p){ try { await p.play().catch(()=>{}); } catch {} }
    async function nudgeForward(p, step){
      try {
        const cur = await p.getCurrentTime().catch(()=>null);
        if (typeof cur === 'number') {
          const jitter = Math.random()*0.02;
          await p.setCurrentTime(Math.max(0, cur + step + jitter)).catch(()=>{});
        }
        await p.play().catch(()=>{});
      } catch {}
    }
    function withinWindow(now, start, win){ return (now - start) <= win; }

    // Mobile stall-nudge settings (safe defaults)
    const STALL_MS        = 2200;   // consider stalled if no progress for >2.2s
    const COOLDOWN_MS     = 3000;   // min gap between actions for the same clip
    const NUDGE_STEP_SECS = 0.08;   // tiny seek forward
    const API_WINDOW_MS   = 30000;  // per-clip window
    const MAX_API_PER_WIN = 1;      // one API recover per 30s per clip

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

    async function tick() {
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

      // Integrated stall-nudge for active iframes
      if (isSmall && window.__STALL_NUDGE_ENABLED) {
        const now = performance.now();
        const activeIframes = actives.map(r => r.el).filter(el => el);
        
        for (const ifr of activeIframes) {
          if (!ifr || !ifr.isConnected) continue;
          const rec = regFor(ifr);
          if (!rec.player) continue;

          // respect per-clip cooldown
          if (now - rec.lastActionAt < COOLDOWN_MS) continue;

          const sinceProg = now - (rec.lastUpdateAt || 0);
          const started   = !!rec.firstUpdateAt;

          // Light keep-alive: always request play on actives
          await apiPlay(rec.player);

          // If started and appears stalled, escalate gently
          if (started && sinceProg > STALL_MS) {
            rec.lastActionAt = now;

            // 1) small forward nudge after a short wait if still stalled
            setTimeout(async () => {
              const since = performance.now() - (rec.lastUpdateAt || 0);
              if (since > STALL_MS) {
                await nudgeForward(rec.player, NUDGE_STEP_SECS);
              }
            }, 500);

            // 2) limited API recover on a later pass if still stalled
            setTimeout(async () => {
              const now2 = performance.now();
              const since2 = now2 - (rec.lastUpdateAt || 0);
              if (since2 > STALL_MS * 2) {
                if (now2 - rec.apiWindowStart > API_WINDOW_MS) { rec.apiWindowStart = now2; rec.apiCount = 0; }
                if (rec.apiCount < MAX_API_PER_WIN) {
                  await apiPlay(rec.player);
                  rec.apiCount++;
                }
              }
            }, 1000);
          }
        }
      }
    }

    const ORCH_ID = setInterval(tick, TICK_MS);
    window.addEventListener('scroll', () => tick(), { passive: true });
    window.addEventListener('resize', () => tick());
    window.addEventListener('load', () => tick());
    tick();

    window.__mobOrchestrator = {
      stop() { clearInterval(ORCH_ID); }
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
    const wh = window.innerHeight;
    const clips = document.querySelectorAll('.clip');
    clips.forEach(wrap => {
      if (!window.__PARALLAX_ENABLED) return;

      // Per-clip speed from manifest (string -> number)
      const speed = parseFloat(wrap.dataset.speed || '0') || 0; // 0 = static
      if (!speed) { 
        // still ensure transform is stable to avoid flicker
        return;
      }

      const rect = wrap.getBoundingClientRect();
      // Distance of clip center from viewport center (px): positive if below center
      const rel = (rect.top + rect.height / 2) - (wh / 2);

      // Apply global gain so JSON values make a visible difference
      const gain = window.__PARALLAX_GAIN || 1;

      // Raw pixel offset; negative sign so positive 'rel' moves wrap up
      let offsetPx = -(rel * speed * gain);

      // Safety cap so it never looks jumpy on mobile (max 25vh)
      const capPx = Math.max(60, Math.round(0.25 * wh)); // 25% of viewport height, min 60px
      if (offsetPx > capPx) offsetPx = capPx;
      if (offsetPx < -capPx) offsetPx = -capPx;

      // Apply transform on the wrapper (parallax element)
      // Round to 0.5px to keep GPU-friendly but stable
      const target = Math.round(offsetPx * 2) / 2;
      const prev   = wrap.__parallaxY ?? target;
      const lerp = isSmall ? LERP_MOBILE : LERP_DESKTOP;
      // compute next = current + (target - current) * lerp
      // then clamp the step to ±MAX_STEP_PX before assigning:
      const step = (target - prev) * lerp;
      const clamped = Math.max(-MAX_STEP_PX, Math.min(MAX_STEP_PX, step));
      const next = prev + clamped;

      wrap.__parallaxY = next;
      wrap.style.transform = `translate3d(0, ${next}px, 0)`;
      wrap.style.willChange = 'transform';
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
  function startBackgroundAudio() {
    startAudioOnce();
  }
  ['click','pointerdown','touchstart','keydown'].forEach(ev =>
    window.addEventListener(ev, startAudioOnce, { once: true, passive: true })
  );

  // Initialize audio unlock overlay
  (function initAudioUnlock(){
    const cc = document.getElementById('clickCatcher');
    if (!cc) return;
    const unlock = () => {
      try { if (typeof startBackgroundAudio === 'function') startBackgroundAudio(); } catch(e){}
      cc.remove();  // permanently remove overlay after the first interaction
    };
    // Capture the first interaction only; do not preventDefault so scrolling stays normal
    cc.addEventListener('click',      unlock, { once: true });
    cc.addEventListener('touchstart', unlock, { once: true, passive: true });
    cc.addEventListener('keydown',    (e) => { if (e.key === 'Enter' || e.key === ' ') unlock(); }, { once: true });
    // Optional accessibility focus for keyboard users:
    cc.tabIndex = 0;
  })();

  // BlackGuard: Detect and revive black (non-playing) iframes on mobile
  if (isSmall && window.__BLACKGUARD_ENABLED) {
    // Stop any prior instance (hot reload safety)
    window.__blackGuard?.stop?.();

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
      return out;
    };
  }

})();