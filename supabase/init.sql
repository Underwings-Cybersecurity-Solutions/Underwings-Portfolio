-- ===========================================
-- UNDERWINGS DATABASE INITIALIZATION
-- Custom tables only - Supabase handles core setup
-- ===========================================

-- ===========================================
-- BLOG POSTS TABLE
-- ===========================================
CREATE TABLE IF NOT EXISTS public.blog_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    excerpt TEXT,
    content TEXT,
    featured_image TEXT,
    category TEXT,
    tags TEXT[] DEFAULT '{}',
    meta_title TEXT,
    meta_description TEXT,
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    author_id UUID,
    author_name TEXT,
    view_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    published_at TIMESTAMP WITH TIME ZONE
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_blog_posts_slug ON public.blog_posts(slug);
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON public.blog_posts(status);
CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON public.blog_posts(category);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON public.blog_posts(published_at DESC);

-- ===========================================
-- BLOG CATEGORIES TABLE
-- ===========================================
CREATE TABLE IF NOT EXISTS public.blog_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default categories
INSERT INTO public.blog_categories (name, slug, description) VALUES
    ('Cybersecurity', 'cybersecurity', 'General cybersecurity topics and news'),
    ('Compliance', 'compliance', 'ISO 27001, SOC 2, PCI DSS, and other compliance frameworks'),
    ('Penetration Testing', 'penetration-testing', 'VAPT, ethical hacking, and security assessments'),
    ('Training', 'training', 'Security awareness and training resources'),
    ('Industry News', 'industry-news', 'Latest news and updates from the security industry')
ON CONFLICT (slug) DO NOTHING;

-- ===========================================
-- FORM SUBMISSIONS TABLE
-- ===========================================
CREATE TABLE IF NOT EXISTS public.form_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_type TEXT NOT NULL CHECK (form_type IN ('contact', 'quote', 'newsletter', 'consultation')),
    name TEXT,
    email TEXT NOT NULL,
    phone TEXT,
    company TEXT,
    job_title TEXT,
    message TEXT,
    service_interest TEXT,
    budget_range TEXT,
    timeline TEXT,
    how_heard TEXT,
    metadata JSONB DEFAULT '{}',
    status TEXT DEFAULT 'new' CHECK (status IN ('new', 'read', 'replied', 'archived', 'spam')),
    notes TEXT,
    assigned_to UUID,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_form_submissions_form_type ON public.form_submissions(form_type);
CREATE INDEX IF NOT EXISTS idx_form_submissions_status ON public.form_submissions(status);
CREATE INDEX IF NOT EXISTS idx_form_submissions_created_at ON public.form_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submissions_email ON public.form_submissions(email);

-- ===========================================
-- NEWSLETTER SUBSCRIBERS TABLE
-- ===========================================
CREATE TABLE IF NOT EXISTS public.subscribers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    subscribed BOOLEAN DEFAULT true,
    subscription_source TEXT DEFAULT 'website',
    confirmed BOOLEAN DEFAULT false,
    confirm_token TEXT,
    unsubscribe_token TEXT DEFAULT encode(gen_random_bytes(32), 'hex'),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    confirmed_at TIMESTAMP WITH TIME ZONE,
    unsubscribed_at TIMESTAMP WITH TIME ZONE
);

-- Create index
CREATE INDEX IF NOT EXISTS idx_subscribers_email ON public.subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_subscribed ON public.subscribers(subscribed);

-- ===========================================
-- SITE SETTINGS TABLE
-- ===========================================
CREATE TABLE IF NOT EXISTS public.site_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    value JSONB,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default settings
INSERT INTO public.site_settings (key, value) VALUES
    ('site_title', '"Underwings Cybersecurity Solutions"'),
    ('site_description', '"Cybersecurity Solutions Provider"'),
    ('contact_email', '"contact@underwings.org"'),
    ('social_links', '{"linkedin": "https://www.linkedin.com/company/underwings-technologies", "twitter": "", "github": ""}'),
    ('notification_emails', '["admin@underwings.org"]')
ON CONFLICT (key) DO NOTHING;

-- ===========================================
-- ROW LEVEL SECURITY POLICIES
-- ===========================================
-- Admin access: service_role key (bypasses RLS) or via Supabase Studio
-- Public access: anon key with restricted policies below

-- Enable RLS on all tables
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;

-- Blog Posts Policies (public: read published only)
DROP POLICY IF EXISTS "Public can read published posts" ON public.blog_posts;
CREATE POLICY "Public can read published posts" ON public.blog_posts
    FOR SELECT USING (status = 'published');

DROP POLICY IF EXISTS "Authenticated users can manage posts" ON public.blog_posts;
DROP POLICY IF EXISTS "Admins can manage posts" ON public.blog_posts;
CREATE POLICY "Admins can manage posts" ON public.blog_posts
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Blog Categories Policies (public: read only)
DROP POLICY IF EXISTS "Public can read categories" ON public.blog_categories;
CREATE POLICY "Public can read categories" ON public.blog_categories
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can manage categories" ON public.blog_categories;
DROP POLICY IF EXISTS "Admins can manage categories" ON public.blog_categories;
CREATE POLICY "Admins can manage categories" ON public.blog_categories
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Form Submissions Policies (public: insert only, constrained)
DROP POLICY IF EXISTS "Public can submit forms" ON public.form_submissions;
CREATE POLICY "Public can submit forms" ON public.form_submissions
    FOR INSERT WITH CHECK (
        status = 'new'
        AND assigned_to IS NULL
        AND notes IS NULL
    );

DROP POLICY IF EXISTS "Authenticated users can view submissions" ON public.form_submissions;
DROP POLICY IF EXISTS "Authenticated users can update submissions" ON public.form_submissions;
DROP POLICY IF EXISTS "Admins can manage submissions" ON public.form_submissions;
CREATE POLICY "Admins can manage submissions" ON public.form_submissions
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Subscribers Policies (public: insert only, constrained)
DROP POLICY IF EXISTS "Public can subscribe" ON public.subscribers;
CREATE POLICY "Public can subscribe" ON public.subscribers
    FOR INSERT WITH CHECK (
        subscribed = true
        AND confirmed = false
        AND confirmed_at IS NULL
        AND unsubscribed_at IS NULL
    );

DROP POLICY IF EXISTS "Authenticated users can manage subscribers" ON public.subscribers;
DROP POLICY IF EXISTS "Admins can manage subscribers" ON public.subscribers;
CREATE POLICY "Admins can manage subscribers" ON public.subscribers
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Site Settings Policies (public: read only)
DROP POLICY IF EXISTS "Public can read settings" ON public.site_settings;
CREATE POLICY "Public can read settings" ON public.site_settings
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can manage settings" ON public.site_settings;
DROP POLICY IF EXISTS "Admins can manage settings" ON public.site_settings;
CREATE POLICY "Admins can manage settings" ON public.site_settings
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ===========================================
-- FUNCTIONS & TRIGGERS
-- ===========================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tables
DROP TRIGGER IF EXISTS update_blog_posts_updated_at ON public.blog_posts;
CREATE TRIGGER update_blog_posts_updated_at
    BEFORE UPDATE ON public.blog_posts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_form_submissions_updated_at ON public.form_submissions;
CREATE TRIGGER update_form_submissions_updated_at
    BEFORE UPDATE ON public.form_submissions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================
-- PARTNERS TABLE
-- ===========================================
CREATE TABLE IF NOT EXISTS public.partners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    logo_url TEXT NOT NULL,
    website_url TEXT,
    display_order INTEGER DEFAULT 0,
    is_visible BOOLEAN DEFAULT true,
    invert_logo BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_partners_display_order ON public.partners(display_order);
CREATE INDEX IF NOT EXISTS idx_partners_visible ON public.partners(is_visible);

-- Enable RLS
ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;

-- Public can read visible partners
DROP POLICY IF EXISTS "Public can read visible partners" ON public.partners;
CREATE POLICY "Public can read visible partners" ON public.partners
    FOR SELECT USING (is_visible = true);

-- Only admins can manage partners
DROP POLICY IF EXISTS "Authenticated users can manage partners" ON public.partners;
DROP POLICY IF EXISTS "Admins can manage partners" ON public.partners;
CREATE POLICY "Admins can manage partners" ON public.partners
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Apply updated_at trigger
DROP TRIGGER IF EXISTS update_partners_updated_at ON public.partners;
CREATE TRIGGER update_partners_updated_at
    BEFORE UPDATE ON public.partners
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed current partners.
-- Kept in sync with the live partners table and with the logo files committed
-- under frontend/public/images/partners/. The previous seed listed vendors that
-- are no longer partners (Securonix, Qualys, Tenable, Rapid7) and referenced
-- brandfetch CDN URLs, so a fresh environment came up with the wrong roster.
-- invert_logo applies filter: brightness(0) invert(1), which normalises any
-- opaque logo to white — leave it false only for marks that must keep colour.
INSERT INTO public.partners (name, logo_url, website_url, display_order, is_visible, invert_logo) VALUES
    ('Sophos',   '/images/partners/sophos.svg',   'https://www.sophos.com',   1, true, true),
    ('Sprinto',  '/images/partners/sprinto.png',  'https://sprinto.com',      2, true, false),
    ('Hexnode',  '/images/partners/hexnode.svg',  'https://www.hexnode.com',  3, true, true),
    ('Trillium', '/images/partners/trillium.png', 'https://trilliumit.com',   4, true, false)
ON CONFLICT DO NOTHING;

-- ===========================================
-- SAMPLE DATA
-- ===========================================

-- Sample blog post
INSERT INTO public.blog_posts (title, slug, excerpt, content, category, status, author_name, published_at) VALUES
(
    'Understanding ISO 27001 Certification',
    'understanding-iso-27001-certification',
    'A comprehensive guide to ISO 27001 certification and its benefits for your organization.',
    '## What is ISO 27001?

ISO 27001 is the international standard for information security management systems (ISMS). It provides a framework for organizations to manage their information security risks effectively.

### Key Benefits

1. **Enhanced Security Posture** - Systematic approach to managing sensitive information
2. **Regulatory Compliance** - Meets various regulatory requirements
3. **Customer Trust** - Demonstrates commitment to security
4. **Risk Management** - Identifies and addresses security risks

### Implementation Steps

1. Gap Analysis
2. Risk Assessment
3. Policy Development
4. Implementation
5. Internal Audit
6. Certification Audit

Contact us to learn how we can help you achieve ISO 27001 certification.',
    'Compliance',
    'published',
    'Underwings Team',
    NOW()
)
ON CONFLICT (slug) DO NOTHING;

-- ===========================================
-- CLIENT PORTAL TABLES
-- ===========================================

-- CLIENT PROJECTS TABLE
CREATE TABLE IF NOT EXISTS public.client_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES auth.users(id),
    project_name TEXT NOT NULL,
    project_type TEXT NOT NULL CHECK (project_type IN ('vapt', 'iso-27001', 'training', 'consultation')),
    status TEXT DEFAULT 'in_progress' CHECK (status IN ('scoping', 'in_progress', 'review', 'completed', 'retesting')),
    start_date DATE,
    target_end_date DATE,
    completed_date DATE,
    scope_summary TEXT,
    findings_critical INTEGER DEFAULT 0,
    findings_high INTEGER DEFAULT 0,
    findings_medium INTEGER DEFAULT 0,
    findings_low INTEGER DEFAULT 0,
    findings_info INTEGER DEFAULT 0,
    remediation_progress INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- CLIENT REPORTS TABLE
CREATE TABLE IF NOT EXISTS public.client_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES public.client_projects(id) ON DELETE CASCADE,
    report_name TEXT NOT NULL,
    report_type TEXT NOT NULL CHECK (report_type IN ('initial', 'retest', 'executive_summary', 'remediation_guide')),
    file_path TEXT NOT NULL,
    file_size_bytes BIGINT,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    downloaded_at TIMESTAMPTZ
);

-- CLIENT REMEDIATION ITEMS
CREATE TABLE IF NOT EXISTS public.client_remediation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES public.client_projects(id) ON DELETE CASCADE,
    finding_title TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'accepted_risk')),
    description TEXT,
    recommendation TEXT,
    client_notes TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for client portal tables
CREATE INDEX IF NOT EXISTS idx_client_projects_client_id ON public.client_projects(client_id);
CREATE INDEX IF NOT EXISTS idx_client_projects_status ON public.client_projects(status);
CREATE INDEX IF NOT EXISTS idx_client_projects_created_at ON public.client_projects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_reports_project_id ON public.client_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_client_reports_report_type ON public.client_reports(report_type);
CREATE INDEX IF NOT EXISTS idx_client_remediation_project_id ON public.client_remediation(project_id);
CREATE INDEX IF NOT EXISTS idx_client_remediation_severity ON public.client_remediation(severity);
CREATE INDEX IF NOT EXISTS idx_client_remediation_status ON public.client_remediation(status);

-- Enable RLS on client portal tables
ALTER TABLE public.client_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_remediation ENABLE ROW LEVEL SECURITY;

-- Client Projects: clients can only see their own projects
DROP POLICY IF EXISTS "Clients can view own projects" ON public.client_projects;
CREATE POLICY "Clients can view own projects" ON public.client_projects
    FOR SELECT USING (client_id = auth.uid());

-- Client Reports: clients can only see reports for their own projects
DROP POLICY IF EXISTS "Clients can view own reports" ON public.client_reports;
CREATE POLICY "Clients can view own reports" ON public.client_reports
    FOR SELECT USING (
        project_id IN (
            SELECT id FROM public.client_projects WHERE client_id = auth.uid()
        )
    );

-- Client Remediation: clients can view and update remediation items for their own projects
DROP POLICY IF EXISTS "Clients can view own remediation" ON public.client_remediation;
CREATE POLICY "Clients can view own remediation" ON public.client_remediation
    FOR SELECT USING (
        project_id IN (
            SELECT id FROM public.client_projects WHERE client_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Clients can update own remediation notes" ON public.client_remediation;
CREATE POLICY "Clients can update own remediation notes" ON public.client_remediation
    FOR UPDATE USING (
        project_id IN (
            SELECT id FROM public.client_projects WHERE client_id = auth.uid()
        )
    ) WITH CHECK (
        project_id IN (
            SELECT id FROM public.client_projects WHERE client_id = auth.uid()
        )
    );

-- Apply updated_at triggers to client portal tables
DROP TRIGGER IF EXISTS update_client_projects_updated_at ON public.client_projects;
CREATE TRIGGER update_client_projects_updated_at
    BEFORE UPDATE ON public.client_projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_client_remediation_updated_at ON public.client_remediation;
CREATE TRIGGER update_client_remediation_updated_at
    BEFORE UPDATE ON public.client_remediation
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================
-- CAREER OPENINGS TABLE
-- ===========================================
CREATE TABLE IF NOT EXISTS public.career_openings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    description TEXT NOT NULL,
    requirements TEXT[] DEFAULT '{}',
    status TEXT DEFAULT 'future' CHECK (status IN ('active', 'future', 'closed')),
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_career_openings_status ON public.career_openings(status);
CREATE INDEX IF NOT EXISTS idx_career_openings_order ON public.career_openings(display_order);

ALTER TABLE public.career_openings ENABLE ROW LEVEL SECURITY;

-- Public can read active/future openings
DROP POLICY IF EXISTS "Public can read open careers" ON public.career_openings;
CREATE POLICY "Public can read open careers" ON public.career_openings
    FOR SELECT USING (status IN ('active', 'future'));

-- Only admins can manage career openings
DROP POLICY IF EXISTS "Authenticated users can manage careers" ON public.career_openings;
DROP POLICY IF EXISTS "Admins can manage careers" ON public.career_openings;
CREATE POLICY "Admins can manage careers" ON public.career_openings
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP TRIGGER IF EXISTS update_career_openings_updated_at ON public.career_openings;
CREATE TRIGGER update_career_openings_updated_at
    BEFORE UPDATE ON public.career_openings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed default career openings
INSERT INTO public.career_openings (title, location, description, requirements, status, display_order) VALUES
    ('Senior Penetration Tester', 'UAE / Remote', 'Lead web, network, and cloud penetration testing engagements. Write detailed technical reports and mentor junior testers.', ARRAY['OSCP / CPTS preferred', '3+ years pentesting experience', 'Web, network & cloud testing', 'Strong report writing skills'], 'future', 1),
    ('Security Consultant', 'India / UAE', 'Help clients achieve and maintain ISO 27001 certification. Conduct gap assessments, build policies, and guide teams through compliance frameworks.', ARRAY['ISO 27001 Lead Implementer / Auditor', 'Compliance frameworks (SOC 2, PCI DSS)', 'Client-facing communication', 'Risk assessment methodology'], 'future', 2),
    ('Full-Stack Developer', 'Remote', 'Build internal security tools and client-facing platforms. Work with Astro, React, Node.js, and integrate with security APIs.', ARRAY['Astro / React experience', 'Node.js & REST APIs', 'Interest in security tooling', 'Self-directed & autonomous'], 'future', 3),
    ('Sales & Partnerships', 'UAE', 'Drive B2B cybersecurity sales across the GCC region. Build relationships with CISOs, CTOs, and IT decision-makers.', ARRAY['B2B cybersecurity sales', 'Relationship building', 'Understanding of security services', 'GCC market experience preferred'], 'future', 4)
ON CONFLICT DO NOTHING;

-- ===========================================
-- ADMIN USERS TABLE & HELPER FUNCTION
-- ===========================================
-- Only users listed here get admin privileges via RLS
CREATE TABLE IF NOT EXISTS public.admin_users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'editor')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- Only admins can view the admin_users table
DROP POLICY IF EXISTS "Admins can view admin users" ON public.admin_users;
CREATE POLICY "Admins can view admin users" ON public.admin_users
    FOR SELECT USING (auth.uid() IN (SELECT au.id FROM public.admin_users au));

-- Helper function: check if current user is admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.admin_users WHERE id = auth.uid()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ===========================================
-- ADMIN MANAGEMENT POLICIES
-- ===========================================
-- Only admin_users can manage content and client portal tables

DROP POLICY IF EXISTS "Admins can manage client projects" ON public.client_projects;
CREATE POLICY "Admins can manage client projects" ON public.client_projects
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins can manage client reports" ON public.client_reports;
CREATE POLICY "Admins can manage client reports" ON public.client_reports
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins can manage client remediation" ON public.client_remediation;
CREATE POLICY "Admins can manage client remediation" ON public.client_remediation
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
