// Password hashing.
//
// bcryptjs rather than bcrypt or argon2: both of those compile native addons,
// and cPanel's Node environment has no reliable toolchain for node-gyp. A pure
// JS implementation is slower to hash, which at admin-login volume is
// irrelevant, and it installs identically on every host.

const bcrypt = require('bcryptjs');

// 12 rounds ≈ 250ms on modest shared hardware. Enough to make offline cracking
// expensive without making login feel broken.
const ROUNDS = 12;

const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);

const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

/*
 * Compare against a throwaway hash when the account does not exist.
 *
 * Without this, a missing account returns in ~1ms while a wrong password takes
 * ~250ms, and that difference tells an attacker which email addresses are real.
 */
const DUMMY_HASH = bcrypt.hashSync('invalid-password-placeholder', ROUNDS);

const wasteTime = () => bcrypt.compare('invalid-password-placeholder', DUMMY_HASH);

module.exports = { hashPassword, verifyPassword, wasteTime };
