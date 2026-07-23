// Per-session JSONL journal + artifact-directory layout. One journal per named session:
// %LOCALAPPDATA%\glassbox\sessions\<name>\journal.jsonl, with shots/ reports/ net/ beside it
// for on-disk artifacts (the arch's "artifact-directory-per-session" contract).
import fs from 'node:fs';
import path from 'node:path';

/**
 * Create (or attach to) a session's artifact dir and return a journal handle.
 * @param {string} sessionsRoot  PATHS.sessions
 * @param {string} name          session name (already validated by the caller)
 */
export function createJournal(sessionsRoot, name) {
  const dir = path.join(sessionsRoot, name);
  const shots = path.join(dir, 'shots');
  const reports = path.join(dir, 'reports');
  const net = path.join(dir, 'net');
  for (const d of [dir, shots, reports, net]) fs.mkdirSync(d, { recursive: true });
  const journalPath = path.join(dir, 'journal.jsonl');

  /** Append one {ts, event, ...data} record. Synchronous so entries never interleave. */
  const log = (event, data = {}) => {
    try {
      fs.appendFileSync(journalPath, JSON.stringify({ ts: Date.now(), event, ...data }) + '\n');
    } catch {
      /* journaling must never take down a command */
    }
  };

  /** Allocate an artifact path under shots/ | reports/ | net/ (dirs already exist). */
  const alloc = (kind, filename) => path.join({ shots, reports, net }[kind] || dir, filename);

  return { dir, journalPath, shots, reports, net, log, alloc };
}
