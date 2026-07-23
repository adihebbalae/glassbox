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

/** PIDs of every chromium (main + children) launched by glassbox, found via cmdline marker. */
export function listGlassboxChromium() {
  const filter = "Name='chrome.exe' OR Name='headless_shell.exe'";
  const like = `*${CHROME_MARKER}*chrome-data*`;
  try {
    const out = ps(
      `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
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
