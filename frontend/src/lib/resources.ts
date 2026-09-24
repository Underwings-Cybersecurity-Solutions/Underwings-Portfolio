/** Free resources the website promises. Add a row when a new lead magnet ships. */
export interface Resource { slug: string; title: string; url: string; blurb: string }

const SITE = 'https://underwings.org';

export const RESOURCES: Resource[] = [
  {
    slug: 'security-assessment-checklist',
    title: 'Security Assessment Checklist',
    url: `${SITE}/resources/underwings-security-assessment-checklist.pdf`,
    blurb: '30 items your organisation should review today — identity, endpoints, email and people, network, cloud, data and response.',
  },
];

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');

export function resourceFor(leadMagnet: string | null | undefined): Resource | null {
  if (!leadMagnet || !leadMagnet.trim()) return null;
  const k = norm(leadMagnet);
  return RESOURCES.find((r) => r.slug === k || norm(r.title) === k) || null;
}
