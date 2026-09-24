/* ============================================================
   Waitlist form handler
   Used on every category hub page for Coming Soon cards.
   Posts to /api/waitlist; falls back to contact form on error.
   ============================================================ */
(function () {
  var forms = document.querySelectorAll('[data-waitlist-form]');
  if (!forms.length) return;

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  forms.forEach(function (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var input = form.querySelector('input[name="email"]');
      var msg = form.querySelector('.soon-msg');
      var btn = form.querySelector('button');
      var email = (input.value || '').trim().toLowerCase();
      var slug = form.dataset.serviceSlug;
      var year = form.dataset.serviceYear;
      var sourcePage = window.location.pathname;

      if (!email || !EMAIL_RE.test(email)) {
        msg.textContent = 'Please enter a valid email address.';
        msg.className = 'soon-msg soon-msg-err';
        return;
      }

      btn.disabled = true;
      var originalBtnText = btn.textContent;
      btn.textContent = 'Adding…';

      try {
        var res = await fetch('/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service_slug: slug,
            email: email,
            source_page: sourcePage,
            year: year,
            attribution: (window.uwAttribution ? window.uwAttribution() : {}),
          }),
        });

        if (res.ok) {
          form.innerHTML =
            '<p class="soon-ok">✓ You\u2019re on the ' +
            year +
            ' waitlist. We\u2019ll email you 30 days before launch.</p>';
        } else if (res.status === 429) {
          msg.textContent =
            "You've signed up a few times recently \u2014 we've got you.";
          msg.className = 'soon-msg soon-msg-ok';
          btn.disabled = false;
          btn.textContent = originalBtnText;
        } else {
          throw new Error('bad response');
        }
      } catch (err) {
        // Graceful fallback when backend isn't reachable yet
        msg.innerHTML =
          'Waitlist launching soon. <a href="/#contact?service=waitlist-' +
          slug +
          '">Email us instead \u2192</a>';
        msg.className = 'soon-msg soon-msg-ok';
        btn.disabled = false;
        btn.textContent = originalBtnText;
      }
    });
  });
})();
