/**
 * Shared loader for the technology-partner list.
 *
 * Extracted from PartnerLogos.astro so a caller can decide whether to render
 * the surrounding section at all. Previously the "Trusted Technology Partners"
 * heading lived in the page and the logos in the component, so an empty
 * partners table left an orphaned heading above nothing.
 *
 * Never throws: partner logos are decoration, and a Supabase outage must not
 * take a marketing page down with it. On any failure the caller simply gets an
 * empty list and skips the section.
 */

export interface Partner {
  id: string;
  name: string;
  logo_url: string;
  website_url?: string;
  display_order: number;
  invert_logo: boolean;
}

export async function getPartners(): Promise<Partner[]> {
  try {
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || 'http://kong:8000';
    const supabaseKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseKey) return [];

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
    if (!res.ok) return [];

    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
