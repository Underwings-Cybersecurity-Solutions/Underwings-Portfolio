'use strict';
/* region.js — derive the sheet's Region column (D) mechanically from Country (C). */

const REGIONS = {
  Europe: ['italy', 'france', 'spain', 'portugal', 'germany', 'united kingdom',
    'uk', 'england', 'netherlands', 'belgium', 'switzerland', 'austria',
    'sweden', 'denmark', 'norway', 'finland', 'poland', 'czech republic',
    'czechia', 'romania', 'hungary', 'greece', 'ireland', 'croatia',
    'slovenia', 'slovakia', 'bulgaria', 'ukraine', 'serbia', 'albania',
    'estonia', 'latvia', 'lithuania', 'luxembourg', 'malta', 'iceland',
    'russia'],
  MENA: ['united arab emirates', 'uae', 'saudi arabia', 'qatar', 'kuwait',
    'bahrain', 'oman', 'jordan', 'lebanon', 'egypt', 'morocco', 'tunisia',
    'algeria', 'libya', 'iraq', 'israel', 'yemen', 'syria', 'iran', 'turkey',
    'kingdom of saudi arabia'],
  Asia: ['china', 'india', 'pakistan', 'bangladesh', 'vietnam', 'japan',
    'south korea', 'korea', 'indonesia', 'thailand', 'malaysia', 'singapore',
    'philippines', 'taiwan', 'hong kong', 'sri lanka', 'myanmar', 'cambodia',
    'nepal', 'kazakhstan', 'uzbekistan', 'mongolia',
    "people's republic of china", 'republic of korea'],
  Americas: ['united states', 'usa', 'united states of america', 'canada',
    'mexico', 'brazil', 'argentina', 'colombia', 'chile', 'peru', 'ecuador',
    'uruguay', 'paraguay', 'bolivia', 'venezuela', 'guatemala', 'costa rica',
    'panama', 'dominican republic', 'cuba'],
  Africa: ['ethiopia', 'nigeria', 'south africa', 'kenya', 'ghana', 'tanzania',
    'uganda', 'senegal', 'ivory coast', "cote d'ivoire", 'cameroon',
    'zimbabwe', 'zambia', 'botswana', 'namibia', 'mozambique', 'madagascar',
    'mauritius', 'rwanda', 'sudan'],
  Oceania: ['australia', 'new zealand', 'fiji'],
};

const LOOKUP = new Map();
for (const [region, names] of Object.entries(REGIONS)) {
  for (const n of names) LOOKUP.set(n, region);
}

/** 'Italy' → 'Europe'. Strips a trailing '?' (low-confidence marker); trims
 * first so a trailing space doesn't hide the '?' from the strip. '' if
 * unknown. */
function regionOf(country) {
  const c = String(country || '').trim().replace(/\?+$/, '').trim().toLowerCase();
  return LOOKUP.get(c) || '';
}

// Geography buckets for the dashboard's UAE / GCC / Global views.
const UAE_NAMES = ['united arab emirates', 'uae'];
const GCC_NAMES = ['saudi arabia', 'kingdom of saudi arabia', 'qatar', 'kuwait',
  'bahrain', 'oman'];

/** 'UAE' → 'uae', 'Saudi Arabia?' → 'gcc', anything else → 'global'.
 * Same normalization as regionOf (trim, strip trailing '?', lowercase). */
function bucketOf(country) {
  const c = String(country || '').trim().replace(/\?+$/, '').trim().toLowerCase();
  if (UAE_NAMES.includes(c)) return 'uae';
  if (GCC_NAMES.includes(c)) return 'gcc';
  return 'global';
}

module.exports = { regionOf, bucketOf };
