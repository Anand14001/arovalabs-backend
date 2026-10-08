/*
 * HTML sanitisation.
 *
 * Content written in the admin is rendered on the public site, so it is
 * sanitised on save against an allowlist — not because admins are suspected,
 * but because "an authenticated user wrote it" is not a security property. An
 * admin account can be phished, and pasted content carries whatever the source
 * page had in it.
 *
 * Sanitising on *save* rather than on render means the stored HTML is already
 * safe: nothing downstream has to remember to escape it, and a future endpoint
 * that serves the same field cannot forget.
 */

const sanitizeHtml = require('sanitize-html');

/*
 * What a constrained editor can produce, and nothing else.
 *
 * No <style>, no <iframe>, no class attributes — the site's typography is the
 * site's job, and an editor that can inject arbitrary classes can break the
 * layout in ways nobody can see until it is live.
 */
const RICH_TEXT = {
  allowedTags: [
    'p', 'br', 'strong', 'em', 'u', 's', 'blockquote',
    'h2', 'h3', 'h4',
    'ul', 'ol', 'li',
    'a', 'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'hr', 'code', 'pre', 'sup', 'sub',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
  },
  // http(s) and mailto/tel only. This is what stops javascript: and data: URLs.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  // Anything not allowed is dropped along with its contents, so a <script>
  // does not leave its source code sitting in the page as text.
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
  transformTags: {
    // An external link opened in a new tab without rel="noopener" hands the
    // opener window to the destination.
    a: (tagName, attribs) => {
      const href = attribs.href ?? '';
      const external = /^https?:\/\//i.test(href) && !href.includes('arovalabs.com');
      return {
        tagName: 'a',
        attribs: {
          ...attribs,
          ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
        },
      };
    },
    img: (tagName, attribs) => ({
      tagName: 'img',
      // Images below the fold should not block the page.
      attribs: { ...attribs, loading: attribs.loading ?? 'lazy' },
    }),
  },
};

/** Rich text from the editor — blog bodies and prose pages. */
const sanitizeRichText = (html) =>
  typeof html === 'string' ? sanitizeHtml(html, RICH_TEXT) : null;

/**
 * A single line of text with no markup at all.
 *
 * Used for headings, labels and anything that goes into a section's structured
 * data: those render as text, so HTML in them is never intentional.
 */
const stripTags = (value) =>
  typeof value === 'string'
    ? sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim()
    : value;

/*
 * Normalise WordPress output.
 *
 * The imported blog posts are full of `wp-block-*` classes and `<!-- wp: -->`
 * comments that mean nothing outside WordPress. Stripping them on import means
 * the editor shows clean markup rather than something it will mangle on first
 * save.
 */
const normaliseWordPress = (html) => {
  if (typeof html !== 'string') return null;
  return sanitizeRichText(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\sclass="[^"]*"/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
};

/** Plain text from HTML, for excerpts and search indexing. */
const toPlainText = (html) =>
  typeof html === 'string'
    ? sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
        .replace(/\s+/g, ' ')
        .trim()
    : '';

/** A reading-time estimate, at the usual 200 words per minute. */
const readingMinutes = (html) => {
  const words = toPlainText(html).split(/\s+/).filter(Boolean).length;
  return words ? Math.max(1, Math.round(words / 200)) : null;
};

module.exports = {
  sanitizeRichText,
  stripTags,
  normaliseWordPress,
  toPlainText,
  readingMinutes,
};
