// Catalogs are embedded by scripts/build.cjs; the host needs only main.js.
let uiLocale = 'en';
function setUiLocale(tag) {
  const normalized = String(tag || '').trim().replace(/_/g, '-').split('.')[0].toLowerCase();
  const next = Object.hasOwn(UI_CATALOGS, normalized) ? normalized : normalized.split('-')[0];
  uiLocale = Object.hasOwn(UI_CATALOGS, next) ? next : 'en';
}
function tr(key, args = {}) {
  const value = UI_CATALOGS[uiLocale][key] ?? UI_CATALOGS.en[key] ?? key;
  return value.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(args, name) ? String(args[name]) : match);
}
// Host-facing text (permission prompts) is picked by the host, not by us: it
// takes a {en, ko, ...} map and applies its own plugin-language setting. Send
// every catalog we have and let it choose.
function translations(key, args = {}) {
  const map = {};
  for (const tag of Object.keys(UI_CATALOGS)) {
    const value = UI_CATALOGS[tag][key] ?? UI_CATALOGS.en[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    map[tag] = value.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(args, name) ? String(args[name]) : match);
  }
  return Object.keys(map).length ? map : tr(key, args);
}
function messageText(message) {
  return message && typeof message === 'object' ? tr(message.key, message.args) : tr(String(message || ''));
}
async function initUiLocale() {
  let tag = hecaton.initialState?.locale;
  if (!tag) {
    try { tag = (await hecaton.env.get({ name: 'HECA_LOCALE' })).value; } catch {}
  }
  if (!tag) {
    try { tag = (await hecaton.i18n.get_locale()).locale; } catch {}
  }
  setUiLocale(tag);
}
function cellWidth(ch) {
  const cp = ch.codePointAt(0);
  if (/\p{Mark}/u.test(ch) || cp === 0x200d || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1;
}
function displayWidth(text) {
  return [...String(text).replace(/\x1b\[[0-9;]*m/g, '')].reduce((sum, ch) => sum + cellWidth(ch), 0);
}
function clipCells(text, width) {
  let out = '', used = 0;
  for (const part of String(text).match(/\x1b\[[0-9;]*m|[^]/gu) || []) {
    const size = part.startsWith('\x1b[') ? 0 : cellWidth(part);
    if (used + size > Math.max(0, width)) break;
    out += part;
    used += size;
  }
  return out;
}
function padCells(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}
// Hecaton decides whether to start its RPC loop immediately after invoking the
// plugin. Awaiting an already-resolved helper here leaves no pending RPC or
// listener, so the runner exits before the first fs.read_file reply is handled.
// The normal host path must reach that first RPC without yielding.
if (hecaton.initialState?.locale) setUiLocale(hecaton.initialState.locale);
else await initUiLocale();
