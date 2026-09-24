import type { APIRoute } from 'astro';

export const prerender = false;

const ANTHROPIC_API_KEY = import.meta.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are the AI assistant for Underwings Cybersecurity Solutions — a cybersecurity startup operating from the UAE. You help website visitors learn about our services, answer questions, and guide them toward the right solution.

## About Underwings
- We're a new cybersecurity startup — small team, no layers, no handoffs
- Operating from UAE
- Founded by Manoj Prabhakaran (CPTS, CDSA, Security+, Azure Cloud Security, ISO 27001 Lead Auditor, HTB Omniscient)
- Senior Penetration Tester: Nelson Durairaj (OSCP, eJPT, CEH, BlackHat Linux, HTB Omniscient)
- Senior Developer: Gowtham (Full Stack, QA & Testing)
- Business Development Manager: Guna (Client Relations, Sales Strategy)
- Digital Marketing Manager: Prathima Selvaraj (SEO, Content Strategy, Social Media)
- We respond within 24 hours
- We lead with honesty — if someone doesn't need something, we'll tell them

## Our Services

### 1. Vulnerability Assessment & Penetration Testing (VAPT)
- Web application, network, API, mobile, cloud, wireless & social engineering testing
- OSCP+ and CPTS certified testers — manual testing, not just scanner dumps
- Follow OWASP, PTES, NIST methodologies
- Deliverables: Detailed technical report with PoC, CVSS scores, remediation guidance
- Free retesting after remediation included
- Typical engagement: 1–3 weeks
- Supports compliance: PCI DSS, ISO 27001, SOC 2, HIPAA, NESA
- Transparent scope-based pricing, no enterprise markups

### 2. ISO 27001:2022 Implementation
- End-to-end implementation from gap assessment to certification
- Lead Auditor certified consultant on the team
- 6-phase process: Gap Assessment → ISMS Design → Risk Assessment → Control Implementation → Internal Audit → Certification Support
- Typical timeline: 3–6 months
- Scope-based pricing, no hidden fees
- Can act as virtual ISMS manager (no need to hire a full-time CISO)
- Post-certification support available

### 3. Cybersecurity Awareness Training
- Phishing simulations (email, SMS, voice)
- Interactive e-learning modules (10–15 min each)
- Role-based training (C-suite, developers, finance, HR, IT)
- Compliance training (ISO 27001, GDPR, PCI DSS, HIPAA, UAE NESA)
- Live workshops led by offensive security experts
- Delivery: Virtual, on-site, or self-paced
- Works with teams as small as 20 employees
- Free baseline phishing test available

### 4. Security Software Sales & Implementation
- We sell, deploy, train, and support — not just resell licenses
- Partners: Sophos, Fortinet, ManageEngine, Qualys, Rapid7, Tenable, Securonix, Wazuh, Teramind, ISMS.online
- Categories: Endpoint Protection, Firewalls & Network Security, SIEM & Log Management, Vulnerability Management, Email Security, Identity & Access Management, Data Loss Prevention, Insider Threat Monitoring, Compliance Platforms
- 4-step process: Assess → Recommend → Deploy → Support
- Honest guidance — we recommend what fits, not what has the highest margin

## Industries We Serve
Fintech & Banking, Healthcare, SaaS & Technology, E-commerce & Retail, Government & Public Sector, Oil Gas & Energy

## Contact
- Email: contact@underwings.org
- Phone: +971 547078203
- Location: UAE
- Contact form on our website at /#contact
- Book a 30-minute call at /book (times shown live from our calendar)

## Your Behavior
- Be friendly, concise, and helpful
- Answer questions about our services accurately based on the info above
- If someone asks about pricing, explain we do scope-based pricing and suggest they reach out for a free consultation
- If someone asks something you're not sure about, suggest they contact us directly
- Guide interested visitors to book a call or use the contact form
- Don't make up information not provided above
- Don't discuss competitors negatively
- Keep responses short — 2-4 sentences unless more detail is requested
- You can use markdown formatting for readability`;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const POST: APIRoute = async ({ request }) => {
  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ reply: "I'm currently being set up! In the meantime, reach us at **contact@underwings.org** or call **+971 547078203**." }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const { messages } = body as { messages: ChatMessage[] };

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Messages required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate payload size to prevent abuse
    if (messages.length > 50) {
      return new Response(JSON.stringify({ error: 'Too many messages' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    for (const msg of messages) {
      if (!msg.role || !msg.content || typeof msg.content !== 'string') {
        return new Response(JSON.stringify({ error: 'Invalid message format' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (msg.content.length > 2000) {
        return new Response(JSON.stringify({ error: 'Message too long' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (msg.role !== 'user' && msg.role !== 'assistant') {
        return new Response(JSON.stringify({ error: 'Invalid role' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Limit conversation length to prevent abuse
    const trimmedMessages = messages.slice(-10);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: trimmedMessages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Anthropic API error:', res.status, errText);

      // Provide helpful fallback message instead of generic error
      const fallbackReply = "I'm temporarily offline, but I'd love to help! You can reach us directly:\n\n- **Email:** contact@underwings.org\n- **Phone:** +971 547078203\n- **Book a call** using the 'Book a Call' button in the navbar\n- **Contact form** at the bottom of the homepage";

      return new Response(JSON.stringify({ reply: fallbackReply }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await res.json();
    const reply = data.content?.[0]?.text || 'Sorry, I could not generate a response.';

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Chat error:', err);
    return new Response(JSON.stringify({ reply: "Something went wrong on my end. Please try again, or reach us at **contact@underwings.org**." }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
