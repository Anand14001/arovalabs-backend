/*
 * File type detection from magic bytes.
 *
 * The Content-Type header and the filename extension are both supplied by the
 * client and both trivially faked. A ".jpg" that is actually an HTML file will
 * be served back as HTML by some configurations and run as a script — so the
 * bytes get the final say, and anything that does not match a known signature
 * is rejected.
 *
 * Written by hand rather than pulled in as a dependency: the list of formats
 * this application accepts is short, fixed, and easier to audit here than in a
 * package that handles two hundred of them.
 */

const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

const startsWith = (buf, bytes, offset = 0) =>
  bytes.every((b, i) => buf[offset + i] === b);

const asciiAt = (buf, offset, text) =>
  buf.slice(offset, offset + text.length).toString('ascii') === text;

const detect = (buffer) => {
  if (!buffer || buffer.length < 12) return null;

  for (const sig of SIGNATURES) {
    if (startsWith(buffer, sig.bytes)) return { mime: sig.mime, ext: sig.ext };
  }

  // RIFF container: "RIFF" .... "WEBP"
  if (asciiAt(buffer, 0, 'RIFF') && asciiAt(buffer, 8, 'WEBP')) {
    return { mime: 'image/webp', ext: 'webp' };
  }

  // ISO-BMFF box: size, "ftyp", then the brand.
  if (asciiAt(buffer, 4, 'ftyp')) {
    const brand = buffer.slice(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') {
      return { mime: 'image/avif', ext: 'avif' };
    }
  }

  /*
   * SVG is XML, so it has no magic number — it is sniffed as text.
   *
   * It is also the one image format that can carry script, which is why
   * uploaded SVGs are served with a restrictive Content-Security-Policy and
   * Content-Disposition in the media route rather than being trusted here.
   */
  const head = buffer.slice(0, 1024).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) {
    if (head.includes('<svg')) return { mime: 'image/svg+xml', ext: 'svg' };
  }

  return null;
};

/*
 * SVGs that carry script or external references are rejected outright.
 *
 * Sanitising SVG properly is a large job; refusing the handful of constructs
 * that make one dangerous is both simpler and stricter, and the organ icons
 * this site uses contain none of them.
 */
const svgIsSuspicious = (buffer) => {
  const text = buffer.toString('utf8').toLowerCase();
  return (
    text.includes('<script') ||
    text.includes('javascript:') ||
    text.includes('<foreignobject') ||
    /\son\w+\s*=/.test(text) || // onload=, onclick=, …
    text.includes('<!entity') // XXE
  );
};

module.exports = { detect, svgIsSuspicious };
