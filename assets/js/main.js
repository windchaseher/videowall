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

  // --- Lazy embed stabilized ---
  const frames = Array.from(document.querySelectorAll('.frame'));
  const maxConcurrentLoads = isSmall ? 3 : 10;           // more parallel loads
  const rootMarginY         = isSmall ? '1600px' : '3200px'; // start earlier
  const eagerMountCount     = isSmall ? 3 : 6;           // instant start clips
  const retryCount = new WeakMap(); // frame -> number

  let inFlight = 0;
  const queue = [];
  const mounted = new Set(); // track frames that currently have an iframe

  function mountIframe(frame) {
    if (!frame || frame.dataset.mounted === '1') return;
    const src = frame.dataset.embed;
    if (!src) return;

    // Prevent duplicate queueing
    if (frame.dataset.mounted === '1' || frame.dataset.queued === '1') return;

    // Desktop-only recycling
    if (!isSmall) {
      const maxMountedIframes = 9;
      if (mounted.size >= maxMountedIframes) {
        unmountFarthest();
      }
    }

    if (inFlight >= maxConcurrentLoads) {
      frame.dataset.queued = '1';
      queue.push(frame);
      return;
    }
    frame.dataset.queued = '0';
    inFlight++;

    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    iframe.setAttribute('loading', 'lazy');
    Object.assign(iframe.style, { border:'0', position:'absolute', inset:'0', width:'100%', height:'100%' });

    frame.style.position = 'relative';
    frame.appendChild(iframe);
    frame.dataset.mounted = '1';
    mounted.add(frame);

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      inFlight = Math.max(0, inFlight - 1);
      const next = queue.shift();
      if (next) mountIframe(next);
    };

    // Retry if load doesn't fire in time
    const maxRetries = 2;
    const t = setTimeout(() => {
      if (settled) return;
      const n = (retryCount.get(frame) || 0);
      if (n < maxRetries) {
        // Tear down and retry with small delay
        try { iframe.remove(); } catch {}
        frame.dataset.mounted = '0';
        retryCount.set(frame, n + 1);
        inFlight = Math.max(0, inFlight - 1);
        setTimeout(() => mountIframe(frame), 400 + n * 400);
      } else {
        // Give up and settle so queue continues
        settle();
      }
    }, 7000);

    iframe.addEventListener('load', () => { clearTimeout(t); settle(); }, { once: true });
  }

  function unmountIframe(frame) {
    if (!isSmall) {
      if (frame.dataset.mounted !== '1') return;
      const iframe = frame.querySelector('iframe');
      if (iframe) iframe.remove();
      frame.dataset.mounted = '0';
      mounted.delete(frame);
      // keep placeholder
    }
  }

  function canRecycle(frame) {
    const hasRetry = retryCount.get(frame) > 0;
    if (hasRetry) return false;
    const r = frame.getBoundingClientRect();
    const far = (r.top > window.innerHeight + 4000) || (r.bottom < -4000);
    return far;
  }

  function unmountFarthest() {
    if (!isSmall) {
      if (!mounted.size) return;
      // Unmount the frame whose center is farthest from viewport center
      const viewportCenter = window.scrollY + window.innerHeight / 2;
      let worst = null, worstDist = -1;
      mounted.forEach(f => {
        if (!canRecycle(f)) return;
        const r = f.getBoundingClientRect();
        const center = window.scrollY + r.top + r.height / 2;
        const d = Math.abs(center - viewportCenter);
        if (d > worstDist) { worstDist = d; worst = f; }
      });
      if (worst) unmountIframe(worst);
    }
  }

  const io = ('IntersectionObserver' in window)
    ? new IntersectionObserver((entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) mountIframe(e.target);
        });
      }, { root: null, rootMargin: `${rootMarginY} 0px`, threshold: 0.01 })
    : null;

  frames.forEach((f, idx) => {
    if (idx < eagerMountCount) mountIframe(f);
  });

  frames.forEach((f) => { if (io) io.observe(f); else mountIframe(f); });

  // Add idle-time warming so a few upcoming iframes mount even before they intersect
  const warmBufferAhead = isSmall ? 2 : 4;         // how many extra to keep mounted beyond what's visible
  const warmIntervalMs  = 900;                     // gentle pace to avoid jank

  function warmUpNext() {
    // Find the highest index frame that is already mounted or intersecting, then pre-mount the next few.
    let topIdx = -1;
    frames.forEach((f, idx) => { if (f.dataset.mounted === '1') topIdx = Math.max(topIdx, idx); });
    // If nothing mounted yet, rely on eagerMountCount — nothing else to do.
    if (topIdx < 0) return;

    for (let i = 1; i <= warmBufferAhead; i++) {
      const target = frames[topIdx + i];
      if (target && target.dataset.mounted !== '1') mountIframe(target);
    }
  }

  let warmTimer = null;
  function scheduleWarm() {
    if (warmTimer) return;
    // Prefer requestIdleCallback when available, else timeout
    if ('requestIdleCallback' in window) {
      warmTimer = requestIdleCallback(() => { warmUpNext(); warmTimer = null; }, { timeout: warmIntervalMs });
    } else {
      warmTimer = setTimeout(() => { warmUpNext(); warmTimer = null; }, warmIntervalMs);
    }
  }

  // Run warm-up on load/scroll/settle:
  window.addEventListener('load', scheduleWarm, { passive: true });
  window.addEventListener('scroll', scheduleWarm, { passive: true });
  window.addEventListener('resize', scheduleWarm);

  // Add an "end-of-page eager mount" that triggers when close to the bottom and also when only a few remain
  function eagerMountTail() {
    const doc = document.documentElement;
    const distanceToBottom = (doc.scrollHeight - doc.scrollTop - window.innerHeight);
    const remaining = frames.filter(f => f.dataset.mounted !== '1');
    if (remaining.length && (remaining.length <= 4 || distanceToBottom < 2000)) {
      remaining.forEach(f => mountIframe(f));
    }
  }
  window.addEventListener('scroll', eagerMountTail, { passive: true });
  window.addEventListener('load', eagerMountTail);
  window.addEventListener('resize', eagerMountTail);

  // Add a tiny diagnostic helper
  window.reportVimeoMounts = () => {
    const unmounted = frames.filter(f => f.dataset.mounted !== '1').length;
    const queued = frames.filter(f => f.dataset.queued === '1').length;
    return { total: frames.length, unmounted, queued };
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