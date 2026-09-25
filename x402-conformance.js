// x402-conformance.js v2.0.0 - INTERFACE SHIM.
//
// The v1-only checker that used to live here emitted FALSE NEGATIVES against real x402 v2
// services (it demanded x402Version===1 and network==="base"). It has been replaced by
// x402-conformance-v2.js, which understands BOTH wire dialects (v1 maxAmountRequired/base and
// v2 amount/eip155:8453). This shim keeps the module path stable so every existing consumer
// (badge.js, the /v1/x402-conformance endpoint, the ecosystem report, the index leaderboard)
// inherits the fix with zero rewiring. The old implementation is preserved at
// x402-conformance-v1.legacy.js for audit and rollback.
'use strict';
const v2 = require('./x402-conformance-v2.js');

module.exports = v2;
module.exports.default = v2;
module.exports.__impl = 'x402-conformance-v2.js';
module.exports.__legacy = './x402-conformance-v1.legacy.js';
