/**
 * Named delivery team — the single source of truth for Person structured data.
 *
 * "Named, certified practitioners — never anonymous juniors" is the central
 * sales claim on nearly every page, but as prose it is invisible to search and
 * answer engines. These Person nodes turn it into an assertable fact, and the
 * stable @id lets a service page point at the practitioner who actually leads
 * that engagement instead of repeating a detached copy of their details.
 *
 * Keep in sync with the rendered team cards on /about.
 */

export interface TeamMember {
  /** URL-safe fragment used to build the person's stable @id. */
  slug: string;
  name: string;
  role: string;
  founder?: boolean;
  certs: string[];
  /** Topical expertise — feeds Person.knowsAbout. */
  knowsAbout?: string[];
  /** Independently verifiable profiles — feeds Person.sameAs. */
  sameAs?: string[];
}

export const SITE_URL = 'https://underwings.org';
export const ORG_ID = `${SITE_URL}/#organization`;

/** Stable, page-independent identifier for a team member. */
export const personId = (slug: string) => `${SITE_URL}/about#${slug}`;

export const TEAM: TeamMember[] = [
  {
    slug: 'manoj-prabhakaran',
    name: 'Manoj Prabhakaran',
    role: 'Founder',
    founder: true,
    certs: ['CPTS', 'CDSA', 'CompTIA Security+', 'Azure Cloud Security', 'ISO/IEC 27001 Lead Auditor', 'HTB Omniscient'],
    knowsAbout: ['ISO/IEC 27001', 'NESA / UAE IA V2', 'UAE PDPL', 'ADHICS', 'Information Security Risk Management', 'Azure Security', 'Microsoft 365 Security'],
  },
  {
    slug: 'nelson-durairaj',
    name: 'Nelson Durairaj',
    role: 'Senior Penetration Tester',
    certs: ['OSCP', 'eJPT', 'CEH', 'HTB Omniscient'],
    knowsAbout: ['Penetration Testing', 'Web Application Security', 'Active Directory Security', 'Phishing Simulation', 'Security Awareness Training'],
  },
  {
    slug: 'vinoth-samiyappa',
    name: 'Vinoth Samiyappa',
    role: 'Co-founder — Networking & Infrastructure',
    founder: true,
    certs: ['CCNP', 'Fortinet NSE', 'Six Sigma', 'Microsoft Azure'],
    knowsAbout: ['Network Security', 'Firewall Configuration Review', 'FortiGate', 'Network Segmentation', 'Security Architecture'],
  },
  { slug: 'gowtham', name: 'Gowtham', role: 'Chief Executive Officer', certs: [] },
  { slug: 'guna', name: 'Guna', role: 'Business Development Manager', certs: [] },
  { slug: 'prathima-selvaraj', name: 'Prathima Selvaraj', role: 'Digital Marketing Manager', certs: [] },
];

/** Full Person node. Use on /about, where the people are actually described. */
export function toPerson(m: TeamMember) {
  return {
    '@type': 'Person',
    '@id': personId(m.slug),
    name: m.name,
    jobTitle: m.role,
    worksFor: { '@id': ORG_ID },
    ...(m.certs.length
      ? {
          hasCredential: m.certs.map((c) => ({
            '@type': 'EducationalOccupationalCredential',
            credentialCategory: 'certification',
            name: c,
          })),
        }
      : {}),
    ...(m.knowsAbout?.length ? { knowsAbout: m.knowsAbout } : {}),
    ...(m.sameAs?.length ? { sameAs: m.sameAs } : {}),
  };
}

/**
 * Compact reference for service pages: names the lead practitioner and points
 * at the full node on /about via @id, rather than duplicating credentials.
 */
export function leadPractitioner(slug: string) {
  const m = TEAM.find((t) => t.slug === slug);
  if (!m) throw new Error(`Unknown team member slug: ${slug}`);
  return { '@type': 'Person', '@id': personId(m.slug), name: m.name };
}
