// Slugs.

const slugify = (input) =>
  String(input ?? '')
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than losing the e.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);

/*
 * Make a slug unique by appending -2, -3, …
 *
 * `isTaken` is passed in rather than querying here, because the uniqueness scope
 * differs per entity: product slugs are globally unique, category slugs only
 * within a parent.
 */
const uniqueSlug = async (base, isTaken) => {
  const root = slugify(base) || 'item';
  if (!(await isTaken(root))) return root;

  for (let n = 2; n < 500; n += 1) {
    const candidate = `${root}-${n}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  // 500 collisions means something is wrong; a timestamp beats looping forever.
  return `${root}-${Date.now()}`;
};

module.exports = { slugify, uniqueSlug };
