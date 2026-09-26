// ssrf-guard.js — process-level SSRF enforcement for ALL outbound http/https.
//
// Enforces at CONNECT TIME via a `lookup` hook, so DNS rebinding cannot slip through a
// string-level check and no code path that forgets to validate can reach a private address.
//
// DEFECT FIXED (found in production, 2026-09-26): the `{all:true}` lookup mode is what Node
// actually uses for most requests, and the callback then delivers an ARRAY of {address,family}.
// The previous version stringified that array into the error and blocked legitimate public
// hosts — which broke the server's own RPC calls to Base. Addresses are now normalized and
// validated for every callback shape: string, single object, or array of objects.
//
// Narrow deliberate exception: this process may reach its OWN loopback port for self health
// checks (SSRF_SELF_PORT, default 8080). Everything else private is refused.
'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { isBlockedIp } = require('./safe-fetch');

const SELF_PORT = parseInt(process.env.SSRF_SELF_PORT || '8080', 10);
const DEBUG = process.env.SSRF_DEBUG === '1';

function isSelfLoopback(addr, port) {
  if (parseInt(port, 10) !== SELF_PORT) return false;
  const a = String(addr);
  if (a === 'localhost' || a === '::1') return true;
  const t = net.isIP(a);
  if (t === 4) return a.startsWith('127.');
  if (t === 6) return a === '::1' || /^::ffff:127\./.test(a);
  return false;
}

/** Normalize any lookup callback address shape into [{address, family}]. */
function toRecords(address, family) {
  if (address == null) return [];
  if (Array.isArray(address)) {
    return address
      .map(r => (r && typeof r === 'object') ? { address: r.address, family: r.family } : { address: r, family })
      .filter(r => typeof r.address === 'string' && r.address.length);
  }
  if (typeof address === 'object') {
    if (typeof address.address === 'string') return [{ address: address.address, family: address.family }];
    return [];
  }
  return [{ address: String(address), family }];
}

function checkRecords(records, port) {
  for (const rec of records) {
    if (isBlockedIp(rec.address) && !isSelfLoopback(rec.address, port)) {
      const err = new Error('ssrf_blocked:' + rec.address);
      err.code = 'SSRF_BLOCKED';
      err.blockedAddress = rec.address;
      return err;
    }
  }
  return null;
}

function makeLookup(prevLookup, port) {
  const ours = function (hostname, lookupOpts, cb) {
    const opts = (lookupOpts && typeof lookupOpts === 'object') ? lookupOpts : {};
    const wantAll = opts.all === true;

    const inspect = (err, address, family) => {
      if (err) return cb(err);
      const records = toRecords(address, family);
      const blocked = checkRecords(records, port);
      if (blocked) {
        if (DEBUG) console.error('[ssrf-guard] BLOCKED ' + hostname + ' -> ' + blocked.blockedAddress + ' (port ' + port + ')');
        return cb(blocked);
      }
      if (DEBUG) console.error('[ssrf-guard] allow ' + hostname + ' -> ' + records.map(r => r.address).join(',') + ' (port ' + port + ')');
      // preserve the caller's expected shape
      if (Array.isArray(address)) return cb(null, address, family);
      if (address && typeof address === 'object' && address.address) return cb(null, address, family);
      return cb(null, address, family);
    };

    if (prevLookup) {
      try { return prevLookup(hostname, opts, inspect); }
      catch (e) { return cb(e); }
    }
    return dns.lookup(hostname, { all: wantAll, verbatim: true }, inspect);
  };
  ours.__ssrfGuard = true;
  return ours;
}

// Accepts every Node signature: (url[, options][, cb]) and (options[, cb]).
// DEFECT FIXED (2026-09-26): the response callback was dropped, so every callback-style outbound
// call (payment verification, oracle, RPC) sent its request, received the response, and then hung
// forever (no 'response' listener, socket closed cleanly, so no timeout ever fired either).
function normalizeArgs(args, defaultPort) {
  const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
  const hasUrl = typeof args[0] === 'string' || args[0] instanceof URL;
  const src = hasUrl ? args[1] : args[0];
  const options = Object.assign({}, (src && typeof src === 'object') ? src : {});
  let port = options.port;
  if (!port && hasUrl) { try { port = new URL(String(args[0])).port; } catch (e) {} }
  return { hasUrl, options, cb, port: port || defaultPort };
}

function hostOf(hasUrl, args, options) {
  let h = options.hostname || options.host;
  if (!h && hasUrl) { try { h = new URL(String(args[0])).hostname; } catch (e) {} }
  return String(h || '').replace(/^\[|\]$/g, '');
}

function guarded(orig, defaultPort) {
  return function (...args) {
    const { hasUrl, options, cb, port } = normalizeArgs(args, defaultPort);
    // Node skips `lookup` entirely for IP-literal hosts, so check those here: otherwise
    // http://169.254.169.254/ or http://127.0.0.1:22/ connect straight past the guard.
    const host = hostOf(hasUrl, args, options);
    if (net.isIP(host)) {
      const blocked = checkRecords([{ address: host, family: net.isIP(host) }], port);
      if (blocked) {
        if (DEBUG) console.error('[ssrf-guard] BLOCKED literal ' + host + ' (port ' + port + ')');
        // Route to an unresolvable name whose lookup fails with the SSRF error, so callers get
        // the usual async 'error' event on a real ClientRequest (never a sync throw).
        const failOpts = Object.assign({}, options, { hostname: 'ssrf-blocked.invalid', host: undefined, port,
          lookup: Object.assign((h, o, done) => process.nextTick(() => done(blocked)), { __ssrfGuard: true }) });
        if (hasUrl) {
          const u = new URL(String(args[0]));
          failOpts.protocol = u.protocol; failOpts.path = failOpts.path || (u.pathname + u.search);
        }
        return orig(failOpts, cb);
      }
    }
    // never double-wrap (prevents infinite recursion if this module is required twice)
    if (!(options.lookup && options.lookup.__ssrfGuard)) {
      options.lookup = makeLookup(options.lookup, port);
    }
    return hasUrl ? orig(args[0], options, cb) : orig(options, cb);
  };
}

function wrap(lib, defaultPort) {
  const origRequest = lib.request;
  const origGet = lib.get;

  lib.request = guarded(origRequest, defaultPort);

  lib.get = function (...args) {
    return guarded(origGet, defaultPort).apply(this, args);
  };
}

let installed = false;
function install() {
  if (installed) return { installed: false, reason: 'already' };
  wrap(http, 80);
  wrap(https, 443);
  installed = true;
  return { installed: true, selfPort: SELF_PORT };
}

if (require.main !== module) install();
else console.log('ssrf-guard loaded; self port =', SELF_PORT);

module.exports = { install, isSelfLoopback, toRecords, checkRecords, SELF_PORT };
