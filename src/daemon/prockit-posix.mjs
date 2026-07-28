// POSIX process helpers — the Linux/macOS twin of prockit-win32.mjs, same six exports, same
// contract. Everything is read from /proc rather than shelled out to `ps`, so it works in a
// stripped container image with no procps installed and costs no subprocess per query.
//
// Why this file has to exist at all: without it, every one of these functions returned [] or false
// on Linux (powershell.exe throws), which meant the suite's opening `0 precondition clean` check
// and its closing `zero strays` check both PASSED VACUOUSLY — a green run that had verified
// nothing, while browsers leaked from one test to the next. A counter that says "clean" when it
// means "I could not look" is the one thing an orphan check must never do (prockit-win32.mjs says
// the same thing about a transient WMI failure); the Linux path was doing exactly that.
import fs from 'node:fs';
import { CHROME_MARKER, chromeDataDir } from '../platform.mjs';
import { DAEMON_ENTRY } from '../protocol.mjs';

const PROC = '/proc';

/** Full command line of a PID, or '' if it can't be read (gone / not permitted). */
export function commandLineFor(pid) {
  try {
    return fs.readFileSync(`${PROC}/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

/** True only if PID is one of our daemon processes — the PID-reuse guard before any kill. */
export function verifyGlassboxPid(pid) {
  const cl = commandLineFor(pid);
  // Match the RESOLVED daemon entry path, not the loose string 'glassbox': a repo checked out to
  // any other directory name would otherwise never verify, and an unverifiable PID is never killed
  // — so kill-all would quietly stop reaping anything at all.
  return cl.includes(DAEMON_ENTRY) || (cl.toLowerCase().includes('daemon.mjs') && cl.toLowerCase().includes(CHROME_MARKER));
}

/**
 * A ZOMBIE IS NOT ALIVE. `process.kill(pid, 0)` succeeds on a zombie — the process is dead and its
 * exit status is simply waiting to be collected — so the naive check reports a killed process as
 * running. In a container whose PID 1 is not a reaping init, an orphaned child stays a zombie
 * indefinitely, and every "is the tree down yet?" loop spins to its timeout and then reports a leak
 * that does not exist. Read the state field instead of trusting the signal.
 */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false; // ESRCH: gone. EPERM: exists but not ours to signal.
    return true;
  }
  return !isZombie(pid);
}

function isZombie(pid) {
  try {
    const stat = fs.readFileSync(`${PROC}/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] === 'Z';
  } catch {
    return false; // unreadable: assume alive rather than invent a death
  }
}

/** Numeric PID directory names under /proc, or [] if /proc is unreadable. */
function pids() {
  try {
    return fs.readdirSync(PROC).filter((d) => /^\d+$/.test(d)).map(Number);
  } catch {
    return [];
  }
}

/** Parent PID from /proc/<pid>/stat, or 0. The comm field can contain spaces AND parens, so the
 *  only safe split is after the LAST ')'. */
function ppidOf(pid) {
  try {
    const stat = fs.readFileSync(`${PROC}/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(rest[1]) || 0; // state, ppid, ...
  } catch {
    return 0;
  }
}

/**
 * Kill a PID and every descendant. Windows gets this from `taskkill /T`; here we walk /proc for
 * the tree, kill leaves first so a parent cannot re-parent its children away mid-sweep, then try
 * the process group as a backstop (glassbox spawns detached, so a daemon is its own group leader
 * and one negative-PID kill catches anything the walk missed). Name kept from the win32 twin so
 * every call site stays identical.
 */
export function taskkillTree(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 1) return false;

  const all = pids();
  const parent = new Map(all.map((p) => [p, ppidOf(p)]));
  const kids = new Map();
  for (const [p, pp] of parent) {
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  const tree = [];
  const stack = [target];
  const seen = new Set([target]);
  while (stack.length) {
    const p = stack.pop();
    tree.push(p);
    for (const k of kids.get(p) || []) if (!seen.has(k)) { seen.add(k); stack.push(k); }
  }

  let killedAny = false;
  for (const p of tree.reverse()) {          // leaves first
    try { process.kill(p, 'SIGKILL'); killedAny = true; } catch { /* already gone */ }
  }
  try { process.kill(-target, 'SIGKILL'); killedAny = true; } catch { /* not a group leader */ }
  return killedAny;
}

/** Every PID whose command line matches a predicate. One /proc pass, no subprocesses. */
function scan(match) {
  const out = [];
  for (const pid of pids()) {
    const cl = commandLineFor(pid);
    if (cl && match(cl.toLowerCase(), cl)) out.push(pid);
  }
  return out;
}

/**
 * PIDs of every chromium (main + children) launched by glassbox, found via the --user-data-dir
 * marker — never a bare PID, never a bare process name (this box may well be running a chromium
 * that is nothing to do with us).
 */
export function listGlassboxChromium() {
  const udd = chromeDataDir();
  return scan((lc, raw) =>
    (lc.includes('chrome') || lc.includes('chromium') || lc.includes('headless_shell')) &&
    (raw.includes(udd) || (lc.includes(CHROME_MARKER) && lc.includes('chrome-data')))
  );
}

/**
 * PIDs of every glassbox DAEMON process. The discovery file names one daemon; a daemon whose file
 * was already removed (a kill-all that raced a starting daemon) is invisible to it and keeps
 * holding a browser — which is how a "clean" precondition finds chromium processes it cannot
 * explain. Excludes the caller so a CLI sweep cannot reap itself.
 */
export function listGlassboxDaemons() {
  const self = process.pid;
  return scan((lc, raw) => raw.includes(DAEMON_ENTRY) || (lc.includes('daemon.mjs') && lc.includes(CHROME_MARKER)))
    .filter((p) => p !== self);
}

/** Reap every glassbox chromium stray. Returns the count found before killing. */
export function sweepOrphans() {
  const list = listGlassboxChromium();
  // Chromium's own children share the marker (they inherit the cmdline), so killing the tree of
  // the first PID usually takes the rest with it; kill them all anyway and let ESRCH be silent.
  for (const pid of list) taskkillTree(pid);
  return list.length;
}
