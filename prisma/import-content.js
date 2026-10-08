/*
 * One-way import of the website's static content into the database.
 *
 * Reads website/src/data/*.js directly, the same way the catalogue import does.
 * After this runs, everything an editor might reasonably want to change — blog
 * posts, page copy, testimonials, FAQs, navigation — is editable in the admin
 * rather than requiring a deploy.
 *
 * Idempotent: keyed on slug or natural key throughout. Editorial text is only
 * written on create, so a re-run never undoes an editor's work.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const prisma = require('../src/lib/prisma');
const logger = require('../src/lib/logger');
const sanitize = require('../src/lib/sanitize');
const { slugify } = require('../src/lib/slug');
const { schemaFor } = require('../src/modules/content/sections.registry');

const DATA_DIR = path.resolve(__dirname, '../../website/src/data');

const load = (file) => import(pathToFileURL(path.join(DATA_DIR, file)).href);

// --------------------------------------------------------------- blog

const importBlog = async () => {
  const [{ blogs }, { blogCategories }] = await Promise.all([
    load('blogs.js'),
    load('taxonomies.js'),
  ]);

  const categoryIds = new Map();
  for (const [index, c] of blogCategories.entries()) {
    const row = await prisma.blogCategory.upsert({
      where: { slug: c.slug },
      update: { name: c.name, menuOrder: index },
      create: { slug: c.slug, name: c.name, menuOrder: index },
    });
    categoryIds.set(c.slug, row.id);
  }

  let created = 0;
  for (const post of blogs) {
    const existing = await prisma.blogPost.findUnique({
      where: { slug: post.slug },
      select: { id: true },
    });
    if (existing) continue;

    /*
     * The captured HTML is full of `wp-block-*` classes and WordPress comments.
     * Normalising on import means the editor opens clean markup rather than
     * something it will mangle on first save.
     */
    const content = sanitize.normaliseWordPress(post.content);

    await prisma.blogPost.create({
      data: {
        slug: post.slug,
        title: post.title,
        // The captured excerpt ends in a WordPress "[&hellip;]" marker.
        excerpt: sanitize
          .toPlainText(post.excerpt ?? '')
          .replace(/\[&hellip;\]\s*$/, '…')
          .slice(0, 500),
        content,
        contentJson: null,
        status: 'PUBLISHED',
        publishedAt: new Date(post.date),
        categoryId: categoryIds.get(post.categorySlug) ?? null,
        readingMinutes: sanitize.readingMinutes(content),
        authorName: 'Arova Labs',
      },
    });
    created += 1;
  }

  logger.info({ created, total: blogs.length }, 'blog posts imported');
};

// ------------------------------------------------------- shared blocks

const importBlocks = async () => {
  const [{ testimonials }, { googleReviews }, { homeFaqs }, { mainNav, footerLegalLinks }] =
    await Promise.all([
      load('testimonials.js'),
      load('googleReviews.js'),
      load('homepage.js'),
      load('site.js'),
    ]);

  // Quotes are captured with typographic quote marks around them; the design
  // adds its own, so they are stripped here rather than rendered twice.
  const unquote = (v) => sanitize.stripTags(v ?? '').replace(/^[“"']+|[”"']+$/g, '').trim();

  for (const [index, t] of testimonials.entries()) {
    const existing = await prisma.testimonial.findFirst({ where: { authorName: t.name } });
    if (existing) continue;
    await prisma.testimonial.create({
      data: {
        authorName: t.name,
        authorMeta: t.location ?? null,
        rating: t.rating ?? 5,
        quote: unquote(t.quote),
        source: 'site',
        menuOrder: index,
      },
    });
  }

  for (const [index, r] of googleReviews.entries()) {
    const existing = await prisma.googleReview.findFirst({ where: { authorName: r.name } });
    if (existing) continue;
    await prisma.googleReview.create({
      data: {
        authorName: r.name,
        rating: r.stars ?? 5,
        quote: unquote(r.text),
        avatarUrl: r.avatar || null,
        menuOrder: index,
      },
    });
  }

  for (const [index, f] of (homeFaqs ?? []).entries()) {
    const existing = await prisma.faq.findFirst({ where: { question: f.q } });
    if (existing) continue;
    await prisma.faq.create({
      data: {
        question: sanitize.stripTags(f.q),
        answer: unquote(f.a),
        group: 'HOME',
        menuOrder: index,
      },
    });
  }

  // Navigation is replaced rather than topped up: it is a short ordered list,
  // and a half-imported menu is worse than none.
  const navCount = await prisma.navItem.count();
  if (navCount === 0) {
    await prisma.navItem.createMany({
      data: [
        ...mainNav.map((n, order) => ({ menu: 'HEADER', label: n.label, url: n.to, order })),
        ...mainNav.map((n, order) => ({ menu: 'FOOTER_QUICK', label: n.label, url: n.to, order })),
        ...footerLegalLinks.map((n, order) => ({
          menu: 'FOOTER_LEGAL', label: n.label, url: n.to, order,
        })),
      ],
    });
  }

  logger.info('testimonials, reviews, FAQs and navigation imported');
};

// -------------------------------------------------------------- pages

/*
 * Build the page sections from the existing homepage/about/contact data.
 *
 * Each block is validated against its declared schema before being stored, so
 * the import cannot introduce a section the admin or website would choke on.
 */
const section = (type, label, data) => ({ type, label, data });

const buildHomeSections = async () => {
  const home = await load('homepage.js');
  const { newsletter } = await load('site.js');
  const { testimonialsHeading } = await load('testimonials.js');

  const link = (v) =>
    !v ? null : typeof v === 'string' ? { label: 'View all', to: v } : { label: v.label, to: v.to };

  const out = [];

  out.push(
    section('TRUST_RIBBON', 'Trust ribbon', { items: home.trustMarquee?.items ?? [] }),
  );

  if (home.organSection) {
    out.push(
      section('ORGAN_CATEGORIES', 'Choose test by organ', {
        heading: home.organSection.heading,
        sub: home.organSection.sub,
        viewMore: link(home.organSection.viewMore),
      }),
    );
  }

  /*
   * Two product rails, matching what the homepage renders today. The source is
   * a query rather than a fixed list, so adding a test puts it on the homepage
   * without anyone editing the section.
   */
  out.push(
    section('PRODUCT_ROW', 'Frequently booked tests', {
      heading: 'Frequently Booked Tests',
      source: { mode: 'query', type: 'TEST', limit: 8 },
      viewMore: { label: 'View all tests', to: '/tests/' },
    }),
    section('PRODUCT_ROW', 'Health packages', {
      heading: 'Popular Health Packages',
      source: { mode: 'query', type: 'PACKAGE', limit: 8 },
      viewMore: { label: 'View all packages', to: '/packages/' },
    }),
  );

  if (home.homeCollection) {
    out.push(
      section('HOME_COLLECTION_CTA', 'Home collection', {
        heading: home.homeCollection.heading,
        sub: home.homeCollection.sub,
        points: (home.homeCollection.steps ?? []).map((s2) => s2.title),
      }),
    );
  }

  if (home.whyChoose?.counters) {
    out.push(
      section('STATISTICS', 'Why choose us', {
        heading: home.whyChoose.heading,
        sub: home.whyChoose.sub,
        items: home.whyChoose.counters.map((c) => ({
          value: Number(c.value) || 0,
          suffix: c.suffix ?? null,
          label: c.label,
        })),
      }),
    );
  }

  if (home.certification) {
    out.push(
      section('CERTIFICATIONS', 'Accreditations', {
        heading: home.certification.heading,
        sub: home.certification.sub,
        items: (home.certification.badges ?? []).map((b) => ({
          name: b.title, image: b.icon ?? null,
        })),
      }),
    );
  }

  if (home.videoSection) {
    out.push(
      section('VIDEO', 'Video', {
        heading: home.videoSection.heading,
        sub: home.videoSection.sub,
        videoUrl: home.videoSection.videos?.[0]?.src ?? null,
      }),
    );
  }

  out.push(
    section('TESTIMONIALS', 'Testimonials', {
      heading: testimonialsHeading ?? 'What Our Patients Say',
      showGoogleReviews: true,
    }),
  );

  if (home.blogSection) {
    out.push(
      section('BLOG_FEED', 'Latest articles', {
        heading: home.blogSection.heading,
        sub: home.blogSection.sub,
        limit: 3,
        viewMore: link(home.blogSection.viewMore),
      }),
    );
  }

  out.push(
    section('FAQ', 'FAQs', { heading: 'Frequently Asked Questions', group: 'HOME' }),
    section('NEWSLETTER', 'Newsletter', {
      heading: newsletter.heading,
      sub: newsletter.sub,
      placeholder: newsletter.placeholder,
      button: newsletter.button,
    }),
  );

  return out;
};

const buildAboutSections = async () => {
  const about = await load('about.js');
  const out = [];

  if (about.corePurpose) {
    out.push(
      section('CORE_PURPOSE', 'Our core purpose', {
        heading: about.corePurpose.heading,
        items: (about.corePurpose.items ?? []).map((i) => ({
          title: i.title, body: i.text ?? null, icon: i.icon ?? null,
        })),
      }),
    );
  }

  if (about.leadership) {
    out.push(
      section('LEADERSHIP_STORY', 'Leadership', {
        heading: about.leadership.heading,
        name: about.leadership.name,
        role: about.leadership.role,
        body: (about.leadership.paragraphs ?? []).join('\n\n'),
        image: about.leadership.image ?? null,
      }),
    );
  }

  if (about.accreditations) {
    out.push(
      section('ACCREDITATIONS', 'Accreditations', {
        heading: about.accreditations.heading,
        items: (about.accreditations.items ?? []).map((i) => ({
          title: i.title,
          body: [i.subtitle, i.text].filter(Boolean).join(' — '),
        })),
      }),
    );
  }

  if (about.locationsSection) {
    out.push(
      section('LOCATIONS', 'Our locations', {
        heading: about.locationsSection.heading,
        sub: about.locationsSection.sub,
      }),
    );
  }

  return out;
};

const buildContactSections = async () => {
  const { contactPage } = await load('pages.js');
  return [
    section('CONTACT_CARDS', 'Contact cards', {
      heading: contactPage.heading,
      sub: contactPage.sub,
      items: (contactPage.cards ?? []).map((c) => ({
        title: c.title, meta: c.meta, value: c.value, icon: c.icon,
      })),
    }),
  ];
};

const importPages = async () => {
  const { legalPages } = await load('legal.js').catch(() => ({ legalPages: null }));

  const definitions = [
    { slug: 'home', title: 'Homepage', layout: 'SECTIONS', build: buildHomeSections },
    { slug: 'about-us', title: 'About Us', layout: 'SECTIONS', build: buildAboutSections },
    { slug: 'contact-us', title: 'Contact Us', layout: 'SECTIONS', build: buildContactSections },
  ];

  let sectionsCreated = 0;

  for (const def of definitions) {
    const page = await prisma.page.upsert({
      where: { slug: def.slug },
      update: { title: def.title },
      create: {
        slug: def.slug,
        title: def.title,
        layout: def.layout,
        status: 'PUBLISHED',
        // These three are wired into the router and the navigation; renaming
        // their address would break both.
        isSystem: true,
      },
      include: { sections: true },
    });

    if (page.sections.length > 0) continue;

    const blocks = await def.build();
    for (const [order, block] of blocks.entries()) {
      const schema = schemaFor(block.type);
      const parsed = schema.safeParse(block.data);
      if (!parsed.success) {
        logger.warn(
          { type: block.type, issues: parsed.error.issues.map((i) => i.path.join('.')) },
          'skipping a section whose imported data does not match its schema',
        );
        continue;
      }
      await prisma.pageSection.create({
        data: {
          pageId: page.id,
          type: block.type,
          label: block.label,
          order,
          data: parsed.data,
        },
      });
      sectionsCreated += 1;
    }
  }

  /*
   * Prose pages — privacy policy, terms — are rich text rather than sections.
   * Their captured shape is a list of { heading, paras } blocks, flattened here
   * into the HTML the editor will work with.
   */
  for (const [slug, content] of Object.entries(legalPages ?? {})) {
    const title = content.title ?? slug.replace(/-/g, ' ');
    const body = (content.sections ?? [])
      .map((sec) =>
        [
          sec.heading ? `<h2>${sec.heading}</h2>` : '',
          ...(sec.paras ?? []).map((para) => `<p>${para}</p>`),
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n');

    await prisma.page.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        title,
        layout: 'RICH_TEXT',
        status: 'PUBLISHED',
        isSystem: true,
        bodyHtml: sanitize.sanitizeRichText(body),
      },
    });
  }

  logger.info({ sectionsCreated }, 'pages and sections imported');
};

const importContent = async () => {
  await importBlog();
  await importBlocks();
  await importPages();
};

module.exports = { importContent };
