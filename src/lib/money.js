/*
 * Money.
 *
 * Everything in the database is an integer number of paise. Floating point and
 * currency do not mix: 0.1 + 0.2 is famously not 0.3, and a price that is
 * almost right is a bug someone eventually finds in an invoice.
 *
 * Rupees appear only at the boundaries — importing the website's old data, and
 * formatting for display.
 */

const toPaise = (rupees) => Math.round(Number(rupees) * 100);

const toRupees = (paise) => Number(paise) / 100;

const formatINR = (paise) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(toRupees(paise));

/*
 * The discount label the website shows ("20% OFF").
 *
 * Rounded rather than truncated, and only produced when there is a real saving —
 * a "0% OFF" badge is worse than no badge.
 */
const discountPercent = (regularPaise, salePaise) => {
  if (!regularPaise || salePaise >= regularPaise) return null;
  return Math.round(((regularPaise - salePaise) / regularPaise) * 100);
};

const discountLabel = (regularPaise, salePaise) => {
  const pct = discountPercent(regularPaise, salePaise);
  return pct ? `${pct}% OFF` : null;
};

module.exports = { toPaise, toRupees, formatINR, discountPercent, discountLabel };
