// bugzoo watch fixture (M6). A fixed-position button whose click mutates a second button's text —
// so the ride-along proof can (a) verify a forwarded TAKEOVER click landed by reading #result via
// observe, and (b) set a breakpoint in onHit to verify PAUSED screencast metadata. External file
// (not inline) so a URL-suffix breakpoint (`--file watch.js`) resolves cleanly, like debug.js.
function onHit() {
  const label = 'watch-clicked';
  window.__watchClicked = true;
  document.getElementById('result').textContent = label;
}
document.getElementById('hit').addEventListener('click', onHit);
