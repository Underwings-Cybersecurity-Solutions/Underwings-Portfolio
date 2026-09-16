/**
 * Shared loader for the technology-partner list.
 *
 * Extracted from PartnerLogos.astro so a caller can decide whether to render
 * the surrounding section at all. Previously the "Trusted Technology Partners"
 * heading lived in the page and the logos in the component, so an empty
 * partners table left an orphaned heading above nothing.
 *
 * Never throws: partner logos are decoration, and a Supabase outage must not
 * take a marketing page down with it. On any failure, or when the table has no
 * visible rows, the caller gets FALLBACK_PARTNERS instead of an empty list.
 */

export interface Partner {
  id: string;
  name: string;
  logo_url: string;
  website_url?: string;
  display_order: number;
  invert_logo: boolean;
}

// Fallback partner list — used when Supabase has no visible partners (the live
// table has been empty since the 2026-08 baseline) or is unreachable. Logos
// live in /public/images/partners/. invert_logo forces dark logos to white
// (brightness(0) invert(1)) so they read on the dark background. Without this
// the homepage and /about would silently lose their only third-party proof.
export const FALLBACK_PARTNERS: Partner[] = [
  { id: 'sophos',   name: 'Sophos',   logo_url: '/images/partners/sophos.svg',   website_url: 'https://www.sophos.com',            display_order: 1, invert_logo: true  },
  { id: 'sprinto',  name: 'Sprinto',  logo_url: '/images/partners/sprinto.png',  website_url: 'https://sprinto.com',              display_order: 2, invert_logo: false },
  { id: 'hexnode',  name: 'Hexnode',  logo_url: '/images/partners/hexnode.svg',  website_url: 'https://www.hexnode.com',          display_order: 3, invert_logo: true  },
  { id: 'trillium', name: 'Trillium', logo_url: '/images/partners/trillium.png', website_url: 'https://www.trilliuminfosec.com',  display_order: 4, invert_logo: false },
];

export async function getPartners(): Promise<Partner[]> {
  try {
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || 'http://kong:8000';
    const supabaseKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseKey) return FALLBACK_PARTNERS;

    const res = await fetch(
      `${supabaseUrl}/rest/v1/partners` +
        `?select=id,name,logo_url,website_url,display_order,invert_logo` +
        `&is_visible=eq.true&order=display_order.asc`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );
    if (!res.ok) return FALLBACK_PARTNERS;

    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data : FALLBACK_PARTNERS;
  } catch {
    return FALLBACK_PARTNERS;
  }
}
