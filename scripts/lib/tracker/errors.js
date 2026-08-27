'use strict';
// TrackerError — the ONE error class every tracker adapter throws (O1 of the
// Jira design): extracted from adapters/ado.js so a second adapter never
// duplicates it (duplicating would break instanceof in shared consumers) and
// never has to import it from a sibling adapter. ado.js and index.js re-export
// it unchanged, so every existing `require(...).TrackerError` keeps working.
//
// What every adapter method throws on failure — never a raw fetch error, never
// anything containing credential material. 401/403 add credentialHint
// (env-var NAMES only, never values).
class TrackerError extends Error {
  constructor({ op, status, url, serverMessage, body, credentialHint }) {
    const head = status ? `HTTP ${status}` : 'request failed';
    super(`${op} failed: ${head}${serverMessage ? ` — ${serverMessage}` : ''} (${url})`);
    this.name = 'TrackerError';
    this.op = op;
    this.status = status ?? null;
    this.url = url;
    this.serverMessage = serverMessage || null;
    this.body = body || '';
    if (credentialHint) this.credentialHint = credentialHint;
  }
}

module.exports = { TrackerError };
