/*
 * cPanel / Passenger startup file.
 *
 * cPanel's "Setup Node.js App" asks for an application startup file and
 * defaults to app.js at the application root. Passenger requires that file and
 * expects it to start listening; it supplies PORT itself.
 *
 * Keeping this shim means the startup file never has to be reconfigured, and
 * local development still runs `src/server.js` directly.
 */

module.exports = require('./src/server');
