// Ride-along watch channel (arch §7, spike 3). One WS per watcher at /watch/:session; frames come
// from Page.startScreencast (jpeg, q60, sized to the session's CURRENT viewport CSS×DPR, cap 1600 —
// don't hardcode dimensions, learning from agent-browser #632). Every CDP frame is acked IMMEDIATELY
// (back-pressure release) and broadcast to all watchers as a binary WS frame:
//   [uint32 LE metaLen][metaJSON][jpeg bytes]   meta = {ts, w, h, paused}
// Screencast is refcounted per session: start on the first watcher, stop when the last one leaves.
//
// Client→server text frames are human TAKEOVER — {click|key|scroll} → Input.dispatch*. These bypass
// the per-session serial queue on purpose (out-of-band; a paused page won't react until resumed, which
// the watch UI shows as a PAUSED badge) and are journaled as {event:'takeover', ...}.
import { wsHandshake } from './ws.mjs';

// Named keys we translate to a virtual keycode/code; anything else goes through as a text char.
const VK = {
  Enter: { vk: 13, code: 'Enter' }, Backspace: { vk: 8, code: 'Backspace' }, Tab: { vk: 9, code: 'Tab' },
  Escape: { vk: 27, code: 'Escape' }, Delete: { vk: 46, code: 'Delete' }, Home: { vk: 36, code: 'Home' },
  End: { vk: 35, code: 'End' }, ArrowLeft: { vk: 37, code: 'ArrowLeft' }, ArrowUp: { vk: 38, code: 'ArrowUp' },
  ArrowRight: { vk: 39, code: 'ArrowRight' }, ArrowDown: { vk: 40, code: 'ArrowDown' }, ' ': { vk: 32, code: 'Space' },
};

/** Current viewport CSS px × DPR, capped at 1600 — read live so a verify sweep's restore is respected. */
async function sizeFor(s) {
  const vp = s.page.viewportSize() || { width: 1280, height: 720 };
  let dpr = 1;
  try {
    const lm = await s.cdp.send('Page.getLayoutMetrics');
    const css = lm.cssLayoutViewport, dev = lm.layoutViewport;
    if (css?.clientWidth && dev?.clientWidth) dpr = Math.max(1, Math.round((dev.clientWidth / css.clientWidth) * 100) / 100);
  } catch { /* getLayoutMetrics can be unavailable while paused — DPR 1 is the safe floor */ }
  return {
    cssW: vp.width, cssH: vp.height,
    maxWidth: Math.min(1600, Math.round(vp.width * dpr)),
    maxHeight: Math.min(1600, Math.round(vp.height * dpr)),
  };
}

function broadcastFrame(s, p) {
  const w = s.watch;
  // Ack every CDP frame immediately — this is the screencast's back-pressure release, independent of
  // whether any watcher is currently drainable.
  s.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  if (!w || !w.watchers.size) return;
  const md = p.metadata || {};
  const meta = {
    ts: Date.now(),
    w: Math.round(md.deviceWidth || w.cssW || 0),
    h: Math.round(md.deviceHeight || w.cssH || 0),
    paused: !!(s.debug && s.debug.paused),
  };
  const metaJson = Buffer.from(JSON.stringify(meta), 'utf8');
  const jpeg = Buffer.from(p.data, 'base64');
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32LE(metaJson.length, 0);
  const frame = Buffer.concat([head, metaJson, jpeg]);
  for (const c of w.watchers) c.sendBinary(frame);
}

async function startScreencast(s) {
  const w = s.watch;
  if (w.started) return;
  w.started = true;
  const size = await sizeFor(s);
  w.cssW = size.cssW; w.cssH = size.cssH;
  w.onFrame = (p) => broadcastFrame(s, p);
  s.cdp.on('Page.screencastFrame', w.onFrame);
  await s.cdp.send('Page.enable').catch(() => {}); // idempotent/guarded per M3 handoff
  await s.cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 60, everyNthFrame: 1, maxWidth: size.maxWidth, maxHeight: size.maxHeight,
  }).catch(() => {});
  s.journal.log('watch', { phase: 'start', maxWidth: size.maxWidth, maxHeight: size.maxHeight });
}

async function stopScreencast(s) {
  const w = s.watch;
  if (!w || !w.started) return;
  w.started = false;
  if (w.onFrame) { try { s.cdp.off('Page.screencastFrame', w.onFrame); } catch { /* detached */ } w.onFrame = null; }
  await s.cdp.send('Page.stopScreencast').catch(() => {});
  s.journal.log('watch', { phase: 'stop' });
}

async function dispatchKey(cdp, m) {
  const key = String(m.key || '');
  if (m.text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: String(m.text), unmodifiedText: String(m.text) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
    return;
  }
  const vk = VK[key];
  const base = vk ? { key, code: vk.code, windowsVirtualKeyCode: vk.vk, nativeVirtualKeyCode: vk.vk } : { key };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function handleInput(s, data) {
  let m;
  try { m = JSON.parse(data.toString('utf8')); } catch { return; }
  const cdp = s.cdp;
  try {
    if (m.type === 'click') {
      const x = Number(m.x) || 0, y = Number(m.y) || 0;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      s.journal.log('takeover', { kind: 'click', x, y });
    } else if (m.type === 'scroll') {
      const x = Number(m.x) || 0, y = Number(m.y) || 0, dy = Number(m.dy) || 0;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
      s.journal.log('takeover', { kind: 'scroll', x, y, dy });
    } else if (m.type === 'key') {
      await dispatchKey(cdp, m);
      s.journal.log('takeover', { kind: 'key', key: m.key });
    }
  } catch { /* takeover is best-effort; a parked/paused page just won't react */ }
}

async function attachWatcher(s, conn) {
  const w = s.watch || (s.watch = { watchers: new Set(), started: false, onFrame: null, cssW: 0, cssH: 0 });
  w.watchers.add(conn);
  conn.on('message', (msg, isBinary) => { if (!isBinary) handleInput(s, msg); });
  conn.on('close', () => {
    w.watchers.delete(conn);
    if (w.watchers.size === 0) stopScreencast(s).catch(() => {});
  });
  if (!w.started) await startScreencast(s);
}

/**
 * Route a WS upgrade for /watch/:session (auth already checked by the daemon). Session-missing →
 * a 404 on the raw socket (there's no live WS to send a structured error over yet).
 */
export function handleWatchUpgrade(mgr, name, req, socket, head) {
  let s;
  try { s = mgr._get(name); } catch {
    try { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); } catch { /* gone */ }
    return;
  }
  const conn = wsHandshake(req, socket, head);
  if (!conn) return;
  attachWatcher(s, conn).catch(() => conn.close(1011));
}
