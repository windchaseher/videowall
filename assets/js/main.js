(async function () {
  'use strict';

  const isSmall = window.matchMedia('(max-width: 768px)').matches;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Helper to enforce Vimeo params while preserving any existing ones
  function buildVimeoUrl(base) {
    try {
      const url = new URL(base);
      const p = url.searchParams;
      p.set('autoplay','1'); p.set('muted','1'); p.set('loop','1'); p.set('background','1');
      url.search = p.toString();
      return url.toString();
    } catch {
      return base + (base.includes('?') ? '&' : '?') + 'autoplay=1&muted=1&loop=1&background=1';
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

    return true;
  }

  // --- MOBILE: sequential, one-by-one loader (no concurrency, no scroll dependency) ---
  async function mobileSequentialLoad() {
    // optional tiny eager burst
    for (let i = 0; i < Math.min(mobileConfig.initialBurstCount, frames.length); i++) {
      mountIframe(frames[i], /* eager */ true);
      await new Promise(r => setTimeout(r, 200)); // tiny spacing
    }

    for (let i = mobileConfig.initialBurstCount; i < frames.length; i++) {
      const f = frames[i];
      if (f.dataset.mounted === '1') continue;

      // Mount and wait for load or timeout
      const ok = mountIframe(f, /* eager */ false);
      if (!ok) continue;

      await new Promise((resolve) => {
        let settled = false;
        const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, mobileConfig.loadTimeoutMs);
        const ifr = f.querySelector('iframe');
        if (ifr) {
          ifr.addEventListener('load', () => {
            if (!settled) { clearTimeout(t); settled = true; }
            resolve();
          }, { once: true });
        } else {
          clearTimeout(t); resolve();
        }
      });

      // brief spacing to avoid back-to-back handshake spikes
      await new Promise(r => setTimeout(r, 250));
    }

    // Final sweep: ensure everything is present
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].dataset.mounted !== '1') {
        mountIframe(frames[i], /* eager */ true);
        await new Promise(r => setTimeout(r, 120));
      }
    }
  }

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
        if (frames[i].dataset.mounted !== '1') mountIframe(frames[i], /* eager */ true);
      }
    }, desktopConfig.finalSweepMs);
  }

  // Entry point: choose loader per device
  if (isSmall) {
    mobileSequentialLoad();
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
})();