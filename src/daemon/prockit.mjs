// Windows process helpers shared by the daemon (startup orphan sweep) and the CLI
// (kill-all reaper). PID-reuse-safe: we never kill a PID without first confirming its
// command line is ours. Chromium strays are found by the --user-data-dir marker, per
// research 07 §5 (taskkill /T /F is the field-tested recipe; no Job Objects for v1).
import { execFileSync } from 'node:child_process';
import { CHROME_MARKER } from '../protocol.mjs';

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15000,
  });
}

/** Full command line of a PID, or '' if it can't be read (gone / access denied). */
export function commandLineFor(pid) {
  try {
    return ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`).trim();
  } catch {
    return '';
  }
}

/** True only if PID is one of our daemon processes — the PID-reuse guard before any kill. */
export function verifyGlassboxPid(pid) {
  const cl = commandLineFor(pid).toLowerCase();
  return cl.includes('daemon.mjs') && cl.includes(CHROME_MARKER);
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not signalable
  }
}

/** taskkill the whole tree of a PID. Returns true on success. */
export function taskkillTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * PIDs of every chromium (main + children) launched by glassbox, found via cmdline marker.
 * The query is retried once: a WMI call can fail transiently — most likely exactly while eight
 * chromium processes are tearing down — and the failure path returns the reassuring answer, zero.
 * A counter that says "clean" when it means "I could not look" is the one thing an orphan check
 * must never do.
 */
export function listGlassboxChromium() {
  const filter = "Name='chrome.exe' OR Name='headless_shell.exe'";
  const like = `*${CHROME_MARKER}*chrome-data*`;
  const query = () => ps(
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
      `Where-Object { $_.CommandLine -like '${like}' } | ` +
      `ForEach-Object { $_.ProcessId }`
  );
  let out;
  try { out = query(); } catch { try { out = query(); } catch { return []; } }
  return out
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * PIDs of every glassbox DAEMON process, found the same way chromium strays are: by command line,
 * never by a bare PID. The discovery file names one daemon; a daemon whose file was already
 * removed (a kill-all that raced a starting daemon) is invisible to it and keeps holding a browser
 * — which is how a "clean" precondition check finds seven chromium processes it cannot explain.
 */
export function listGlassboxDaemons() {
  const like = `*${CHROME_MARKER}*daemon.mjs*`;
  try {
    const out = ps(
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `Where-Object { $_.CommandLine -like '${like}' } | ` +
        `ForEach-Object { $_.ProcessId }`
    );
    return out
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Reap every glassbox chromium stray. Returns the count found before killing. */
export function sweepOrphans() {
  const pids = listGlassboxChromium();
  for (const pid of pids) taskkillTree(pid);
  return pids.length;
}
