/*
 * The section type registry.
 *
 * Each page section is a typed block: a `type` string plus a `data` object whose
 * shape is declared here once and used for three things — validating writes,
 * generating the admin's form, and telling the website what to render.
 *
 * One declaration, three consumers, so they cannot drift. The alternative is a
 * free-form page builder, which would let an editor change headings *and*
 * destroy the layout that was carefully built; this lets them change every
 * string, image, number and list item while the structure stays fixed.
 *
 * Adding a type is a code change on purpose. A new section needs a React
 * component to render it, so there is nothing to gain from letting one be
 * invented at runtime — and plenty to lose.
 */

const { z } = require('zod');

// --------------------------------------------------------------- field kinds

const text = (label, { max = 255, help, required = false, multiline = false } = {}) => ({
  kind: multiline ? 'textarea' : 'text',
  label,
  help,
  required,
  schema: required
    ? z.string().trim().min(1, `${label} is required.`).max(max)
    : z.string().trim().max(max).optional().nullable(),
});

const image = (label, { help } = {}) => ({
  kind: 'image',
  label,
  help,
  // An upload id, or a path into the site's own static assets for the
  // illustrations that were imported rather than uploaded.
  schema: z.union([z.number().int().positive(), z.string().max(500)]).optional().nullable(),
});

const number = (label, { help, min = 0, max = 1_000_000 } = {}) => ({
  kind: 'number',
  label,
  help,
  schema: z.coerce.number().min(min).max(max).optional().nullable(),
});

const toggle = (label, { help } = {}) => ({
  kind: 'toggle',
  label,
  help,
  schema: z.boolean().optional(),
});

const link = (label) => ({
  kind: 'link',
  label,
  schema: z
    .object({
      label: z.string().trim().max(120).optional().nullable(),
      to: z.string().trim().max(500).optional().nullable(),
    })
    .optional()
    .nullable(),
});

/** A repeatable list of sub-objects, each with its own fields. */
const list = (label, fields, { help, max = 50 } = {}) => ({
  kind: 'list',
  label,
  help,
  fields,
  schema: z
    .array(z.object(Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.schema]))))
    .max(max)
    .optional(),
});

/** A repeatable list of plain strings. */
const strings = (label, { help, max = 50 } = {}) => ({
  kind: 'strings',
  label,
  help,
  schema: z.array(z.string().trim().max(500)).max(max).optional(),
});

/*
 * Which products a product rail shows.
 *
 * Either a curated list of slugs or a query. Expressed as data rather than
 * hardcoded, so marketing can swap "frequently booked tests" for a hand-picked
 * set without a deploy.
 */
const productSource = (label) => ({
  kind: 'productSource',
  label,
  schema: z
    .object({
      mode: z.enum(['curated', 'query']).default('query'),
      slugs: z.array(z.string().trim().max(191)).max(24).optional(),
      type: z.enum(['TEST', 'PACKAGE']).optional().nullable(),
      category: z.string().trim().max(191).optional().nullable(),
      limit: z.coerce.number().int().min(1).max(24).default(8),
    })
    .optional()
    .nullable(),
});

// ------------------------------------------------------------------- types

const SECTION_TYPES = {
  HERO: {
    label: 'Hero',
    description: 'The headline block at the top of the homepage.',
    fields: {
      eyebrow: text('Eyebrow', { max: 120 }),
      heading: text('Heading', { max: 255, required: true }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      primaryCta: link('Primary button'),
      secondaryCta: link('Secondary button'),
      image: image('Background image'),
    },
  },

  TRUST_RIBBON: {
    label: 'Trust ribbon',
    description: 'The scrolling strip of claims above the header.',
    fields: { items: strings('Claims', { help: 'e.g. NABL CERTIFIED' }) },
  },

  STATISTICS: {
    label: 'Statistics',
    description: 'The animated counters.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      items: list('Figures', {
        value: number('Number'),
        suffix: text('Suffix', { max: 16, help: 'e.g. + or k+' }),
        label: text('Label', { max: 120, required: true }),
      }),
    },
  },

  ORGAN_CATEGORIES: {
    label: 'Choose test by organ',
    description: 'Tiles built from the organ tags in the catalogue.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      viewMore: link('View more link'),
    },
  },

  PRODUCT_ROW: {
    label: 'Product rail',
    description: 'A horizontal row of tests or packages.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      source: productSource('Which products'),
      viewMore: link('View all link'),
    },
  },

  HOME_COLLECTION_CTA: {
    label: 'Home collection call-to-action',
    description: 'The block explaining how home collection works.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      points: strings('Bullet points'),
      cta: link('Button'),
      image: image('Image'),
    },
  },

  VIDEO: {
    label: 'Video',
    description: 'A video with a heading beside it.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      videoUrl: text('Video URL', { max: 500, help: 'YouTube or a direct file.' }),
      poster: image('Poster image'),
    },
  },

  CERTIFICATIONS: {
    label: 'Accreditations',
    description: 'A row of accreditation logos.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      items: list('Logos', {
        name: text('Name', { max: 120, required: true }),
        image: image('Logo'),
      }),
    },
  },

  TESTIMONIALS: {
    label: 'Testimonials',
    description: 'Pulls from the testimonials list; this only sets the heading.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      showGoogleReviews: toggle('Include Google reviews'),
    },
  },

  BLOG_FEED: {
    label: 'Latest articles',
    description: 'Shows the most recent blog articles automatically.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      limit: number('How many', { min: 1, max: 12 }),
      viewMore: link('View all link'),
    },
  },

  FAQ: {
    label: 'FAQs',
    description: 'Pulls from the FAQ list; this only sets the heading.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      group: text('Which group', { max: 32, help: 'HOME, PRODUCT or GENERAL' }),
    },
  },

  NEWSLETTER: {
    label: 'Newsletter signup',
    description: 'The email signup box.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      placeholder: text('Field placeholder', { max: 120 }),
      button: text('Button label', { max: 60 }),
    },
  },

  LEADERSHIP_STORY: {
    label: 'Leadership story',
    description: 'A portrait and biography.',
    fields: {
      heading: text('Heading', { max: 255 }),
      name: text('Name', { max: 191 }),
      role: text('Role', { max: 191 }),
      body: text('Story', { max: 5000, multiline: true }),
      image: image('Portrait'),
    },
  },

  CORE_PURPOSE: {
    label: 'Mission / vision / values',
    description: 'Three or more cards describing what the lab stands for.',
    fields: {
      heading: text('Heading', { max: 255 }),
      items: list('Cards', {
        title: text('Title', { max: 191, required: true }),
        body: text('Body', { max: 2000, multiline: true }),
        icon: image('Icon'),
      }),
    },
  },

  ACCREDITATIONS: {
    label: 'Accreditation detail',
    description: 'Accreditations with an explanation of each.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      items: list('Items', {
        title: text('Title', { max: 191, required: true }),
        body: text('Body', { max: 2000, multiline: true }),
      }),
    },
  },

  LOCATIONS: {
    label: 'Our centres',
    description: 'Pulls from the centres list; this only sets the heading.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
    },
  },

  CONTACT_CARDS: {
    label: 'Contact cards',
    description: 'Phone, email and address cards.',
    fields: {
      heading: text('Heading', { max: 255 }),
      sub: text('Standfirst', { max: 600, multiline: true }),
      items: list('Cards', {
        title: text('Title', { max: 191, required: true }),
        meta: text('Small print', { max: 191 }),
        value: text('Value', { max: 500 }),
        icon: image('Icon'),
      }),
    },
  },

  RICH_TEXT: {
    label: 'Rich text',
    description: 'A free block of formatted text.',
    fields: {
      heading: text('Heading', { max: 255 }),
      body: { kind: 'richText', label: 'Content', schema: z.string().max(100_000).optional().nullable() },
    },
  },
};

/** The Zod schema for one section type's `data`. */
const schemaFor = (type) => {
  const def = SECTION_TYPES[type];
  if (!def) return null;
  return z
    .object(Object.fromEntries(Object.entries(def.fields).map(([k, f]) => [k, f.schema])))
    // Unknown keys are dropped rather than rejected: a section saved by an older
    // admin build should not become unsaveable after a field is removed.
    .strip();
};

/*
 * The registry as the admin consumes it — no Zod objects, which do not survive
 * JSON. The admin renders a form from `kind` and the field metadata.
 */
const describe = () =>
  Object.entries(SECTION_TYPES).map(([type, def]) => ({
    type,
    label: def.label,
    description: def.description ?? null,
    fields: Object.entries(def.fields).map(([name, f]) => ({
      name,
      kind: f.kind,
      label: f.label,
      help: f.help ?? null,
      required: f.required ?? false,
      ...(f.fields
        ? {
            fields: Object.entries(f.fields).map(([subName, sub]) => ({
              name: subName,
              kind: sub.kind,
              label: sub.label,
              help: sub.help ?? null,
              required: sub.required ?? false,
            })),
          }
        : {}),
    })),
  }));

module.exports = { SECTION_TYPES, schemaFor, describe };
