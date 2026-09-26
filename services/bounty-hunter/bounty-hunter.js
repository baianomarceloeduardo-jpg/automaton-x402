'use strict';
// Superseded by hunter-daemon.js. The previous version signed reports with a throwaway P-256 key
// while labelling the Base wallet as the signer, which any verifier would reject. Kept as an alias.
module.exports = require('./hunter-daemon.js');
