/**
 * badge.js v1.0.0 - embeddable x402 conformance badge (SVG) + markdown snippet.
 * Zero deps. Growth loop: any service that embeds the badge links back to this API.
 *
 * The badge is a real conformance verdict from x402-conformance, rendered as an SVG
 * a project can drop into its README. The <a> wrapper the markdown snippet produces
 * points at THIS service, so every embed is a backlink.
 */
'use strict';
const CONFORMANCE = require('./x402-conformance.js');

const COLORS = { PASS: '#2ea44f', CONFORMANT: '#2ea44f', FAIL: '#d73a49', NON_CONFORMANT: '#d73a49', PARTIAL: '#dbab09', ERROR: '#6a737d', UNKNOWN: '#6a737d' };
const cache = new Map(); // url -> { at, verdict, passed, total, status }
const TTL = 5 * 60 * 1000;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function textW(s) { return 6.6 * String(s).length + 10; }

function svg(label, value, color) {
  const lw = Math.round(textW(label)), vw = Math.round(textW(value)), w = lw + vw;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="20" role="img" aria-label="' + esc(label) + ': ' + esc(value) + '">' +
    '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>' +
    '<clipPath id="r"><rect width="' + w + '" height="20" rx="3" fill="#fff"/></clipPath>' +
    '<g clip-path="url(#r)"><rect width="' + lw + '" height="20" fill="#555"/><rect x="' + lw + '" width="' + vw + '" height="20" fill="' + color + '"/><rect width="' + w + '" height="20" fill="url(#s)"/></g>' +
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">' +
    '<text x="' + (lw / 2) + '" y="14">' + esc(label) + '</text>' +
    '<text x="' + (lw + vw / 2) + '" y="14">' + esc(value) + '</text></g></svg>';
}

async function verdict(target) {
  const hit = cache.get(target);
  if (hit && Date.now() - hit.at < TTL) return hit;
  let r;
  try {
    const res = await CONFORMANCE.run(target);
    r = { at: Date.now(), verdict: res.verdict || 'UNKNOWN', passed: res.passed, total: res.total, status: res.verdict };
  } catch (e) {
    r = { at: Date.now(), verdict: 'ERROR', passed: 0, total: 0, status: 'error:' + e.message };
  }
  cache.set(target, r);
  return r;
}

async function badge(target, labelOverride) {
  const v = await verdict(target);
  const label = labelOverride || 'x402';
  const value = (v.verdict === 'CONFORMANT' || v.verdict === 'PASS') ? ('PASS ' + v.passed + '/' + v.total)
    : (v.total ? (v.passed + '/' + v.total + ' FAIL') : String(v.verdict));
  const color = COLORS[v.verdict] || COLORS.UNKNOWN;
  return { svg: svg(label, value, color), verdict: v.verdict, passed: v.passed, total: v.total, color, value, label };
}

module.exports = { badge, verdict, svg };
