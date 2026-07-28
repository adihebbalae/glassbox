// Process helpers — platform dispatch only. Both implementations export the same six functions
// with the same contract, so every call site (daemon startup sweep, CLI kill-all, dev-loop reaper,
// and the whole test suite's stray checks) imports this file and never learns which OS it is on.
//
// The contract, identical on both sides:
//   commandLineFor(pid)     → string ('' if unreadable — gone, or not permitted)
//   verifyGlassboxPid(pid)  → boolean, the PID-reuse guard that must pass before any kill
//   processAlive(pid)       → boolean
//   taskkillTree(pid)       → boolean, kills the PID and every descendant
//   listGlassboxChromium()  → PIDs of our chromiums, matched on the --user-data-dir marker
//   listGlassboxDaemons()   → PIDs of our daemons, matched on cmdline
//   sweepOrphans()          → count found, then killed
import * as win32 from './prockit-win32.mjs';
import * as posix from './prockit-posix.mjs';

const impl = process.platform === 'win32' ? win32 : posix;

export const commandLineFor = impl.commandLineFor;
export const verifyGlassboxPid = impl.verifyGlassboxPid;
export const processAlive = impl.processAlive;
export const taskkillTree = impl.taskkillTree;
export const listGlassboxChromium = impl.listGlassboxChromium;
export const listGlassboxDaemons = impl.listGlassboxDaemons;
export const sweepOrphans = impl.sweepOrphans;
