'use strict';
// AgenTeX suite studio — pure page helpers (no DOM, no I/O), so they are unit-tested in plain
// Node (studio_view.test.js) and run unchanged inside the page.
//
// The page cannot `require`, so server.js injects `source()` into studio.html the same way it
// injects `needsReview`: the text below is an expression that evaluates to the helper object.
// `makeView` must therefore stay self-contained (no closure over this file's other names).
function makeView() {
  const FSI = '⁨'; // first-strong isolate: a value never reorders the sentence around it
  const PDI = '⁩';
  const bidi = s => FSI + String(s) + PDI;

  // `{name}` placeholders: the template text is left alone, each value is isolated (F15).
  function interpolate(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (m, n) => (vars && vars[n] !== undefined ? bidi(vars[n]) : m));
  }

  // The user picker (F1-F3): a stable list, "— pick a user —" first, disabled users last,
  // greyed out with their reason, and never the selection. `selected` null/undefined means
  // "the tester has not chosen yet", so `suggested` applies; '' is an explicit "pick a user".
  function userOptions(info, { selected, suggested, pickLabel }) {
    const list = Array.isArray(info) ? info : [];
    const usable = list.filter(u => !isDisabled(u));
    const locked = list.filter(isDisabled);
    const names = new Set(usable.map(u => u.name));
    const want = selected === null || selected === undefined ? suggested : selected;
    const pick = want && names.has(want) ? want : '';
    return [{ value: '', text: pickLabel, disabled: false, reason: null, selected: pick === '' },
      ...usable.map(u => ({ value: u.name, text: u.name, disabled: false, reason: null, selected: u.name === pick })),
      ...locked.map(u => ({ value: u.name, text: u.disabled ? `${u.name} — ${u.disabled}` : u.name, disabled: true, reason: String(u.disabled), selected: false }))];
  }
  function isDisabled(u) { return u.disabled !== null && u.disabled !== undefined && u.disabled !== false; }
  function userSignature(info) { return JSON.stringify((Array.isArray(info) ? info : []).map(u => [u.name, isDisabled(u) ? String(u.disabled) : null])); }

  // Plural variants (F20): `key#one|two|few|many|other`, chosen by Intl.PluralRules for the
  // language, falling back to `#other`, then to the plain key.
  function pluralKey(strs, lang, key, n) {
    const cat = new Intl.PluralRules(lang).select(Number(n));
    if (`${key}#${cat}` in strs) return `${key}#${cat}`;
    if (`${key}#other` in strs) return `${key}#other`;
    return key;
  }
  function plural(strs, lang, key, n) { return strs[pluralKey(strs, lang, key, n)]; }

  // A filter that matches nothing says so (F17).
  function emptyState(count, filter) { return count > 0 ? null : { key: 'ed.emptyFilter', filter }; }

  // Step 4 totals (F11): ready cases that carry a token requirement will be BLOCKED with no token.
  function tokenSplit(summary) {
    const ready = Number(summary && summary.ready) || 0;
    const blocked = Math.min(Number(summary && summary.tokenBlocked) || 0, ready);
    return { ready: ready - blocked, blocked };
  }

  return { bidi, interpolate, userOptions, userSignature, pluralKey, plural, emptyState, tokenSplit };
}

const view = makeView();
module.exports = { ...view, source: () => `(${makeView.toString()})()` };
