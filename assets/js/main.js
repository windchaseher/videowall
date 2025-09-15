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

  // ---- rAF HEARTBEAT STAGGERED LOADER (NO SCROLL DEPENDENCY) ----
  const frames = Array.from(document.querySelectorAll('.frame'));

  // Device-tuned knobs (feel free to tweak later)
  const initialBurstCount   = isSmall ? 4  : 12;  // eager upfront
  const batchSize           = isSmall ? 3  : 5;   // per heartbeat
  const maxConcurrentLoads  = isSmall ? 3  : 12;  // simultaneous loads cap
  const loadTimeoutMs       = 7000;               // settle even if 'load' never fires
  const heartbeatMs         = 80;                 // rAF cadence
  const watchdogMs          = 1500;               // backup timer if rAF throttled
  const finalSweepMs        = 12000;              // force-mount leftover after this
  const jitterMs            = isSmall ? 40 : 20;  // tiny random delay to avoid bursts aligning

  let inFlight = 0;
  let nextIndex = 0;
  let lastBeat = 0;

  // Mount one frame (optionally eager = no lazy hint)
  function mountIframe(frame, eager = false) {
    if (!frame || frame.dataset.mounted === '1') return;
    const src = frame.dataset.embed; if (!src) return;
    if (inFlight >= maxConcurrentLoads) return;

    inFlight++;

    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    if (!eager) iframe.setAttribute('loading', 'lazy');
    Object.assign(iframe.style, { border:'0', position:'absolute', inset:'0', width:'100%', height:'100%' });

    frame.style.position = 'relative';
    frame.appendChild(iframe);
    frame.dataset.mounted = '1';

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      inFlight = Math.max(0, inFlight - 1);
    };
    const t = setTimeout(settle, loadTimeoutMs);
    iframe.addEventListener('load', () => { clearTimeout(t); settle(); }, { once: true });
  }

  // 0) Eager burst (desktop strong, mobile lighter)
  for (let i = 0; i < Math.min(initialBurstCount, frames.length); i++) {
    mountIframe(frames[i], /* eager */ true);
  }
  nextIndex = initialBurstCount;

  // 1) rAF heartbeat: keeps loading even if user never scrolls
  function beat(ts) {
    if (!lastBeat || (ts - lastBeat) >= heartbeatMs) {
      lastBeat = ts;
      let mountedThisBeat = 0;
      while (mountedThisBeat < batchSize && nextIndex < frames.length) {
        const f = frames[nextIndex];
        const before = inFlight;
        // add a tiny jitter to smooth spikes
        const delay = Math.random() * jitterMs;
        setTimeout(() => mountIframe(f), delay);
        // Count it only if we actually started (checked next tick)
        // We optimistically advance the index to keep cadence
        mountedThisBeat++;
        nextIndex++;
      }
    }
    if (nextIndex < frames.length) requestAnimationFrame(beat);
  }
  requestAnimationFrame(beat);

  // 2) Watchdog: fires batches even if rAF is throttled (iOS background/tab)
  function tickWatchdog() {
    if (nextIndex >= frames.length) { clearInterval(watchdog); return; }
    let mountedThisTick = 0;
    while (mountedThisTick < Math.max(1, Math.floor(batchSize / 2)) && nextIndex < frames.length) {
      const before = inFlight;
      mountIframe(frames[nextIndex]);
      if (inFlight > before) { mountedThisTick++; nextIndex++; }
      else break;
    }
  }
  const watchdog = setInterval(tickWatchdog, watchdogMs);

  // 3) Final sweep: ensure nothing is stranded after N seconds
  setTimeout(() => {
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].dataset.mounted !== '1') {
        const before = inFlight;
        mountIframe(frames[i]);
        if (inFlight === before) {
          // last resort: attach even if over concurrency cap
          const iframe = document.createElement('iframe');
          iframe.src = frames[i].dataset.embed;
          iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
          Object.assign(iframe.style, { border:'0', position:'absolute', inset:'0', width:'100%', height:'100%' });
          frames[i].style.position = 'relative';
          frames[i].appendChild(iframe);
          frames[i].dataset.mounted = '1';
        }
      }
    }
  }, finalSweepMs);

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