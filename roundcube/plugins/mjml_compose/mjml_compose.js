/* MJML Compose plugin — client-side
   Adds a "Preview MJML" toolbar button to the compose form.
   On click: grabs the compose body, POSTs it to the plugin.mjml_compile
   action, opens a modal with the rendered preview, and offers an
   "Insert as HTML" button that replaces the compose body with compiled
   HTML and switches the editor to HTML mode for sending. */

if (window.rcmail) {
  rcmail.addEventListener('init', function () {

    if (rcmail.env.task !== 'mail' || rcmail.env.action !== 'compose') return;

    // ---------- Register native Roundcube command ----------
    rcmail.register_command('plugin.mjml-preview', runPreview, true);

    // ---------- Toolbar button ----------
    function injectButton() {
      if (document.getElementById('rcmbtn-mjml-preview')) return true;

      // elastic → #messagetoolbar; classic → #compose-toolbar; fallback → form buttons
      var targets = ['#messagetoolbar', '#compose-toolbar', '#toolbar-menu', '.formbuttons'];
      var host = null;
      for (var i = 0; i < targets.length; i++) {
        var el = document.querySelector(targets[i]);
        if (el) { host = el; break; }
      }
      if (!host) return false;

      var label = rcmail.gettext('preview', 'mjml_compose') || 'Preview MJML';
      var btn = document.createElement('a');
      btn.id = 'rcmbtn-mjml-preview';
      btn.href = '#';
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.className = 'button mjml-preview';
      btn.setAttribute('data-command', 'plugin.mjml-preview');

      // Roundcube elastic-style structure: outer .button + inner .inner span.
      // The icon comes from CSS ::before — see mjml_compose.css.
      btn.innerHTML = '<span class="inner">' + escapeHtml(label) + '</span>';

      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        rcmail.command('plugin.mjml-preview', null, this, e);
        return false;
      });

      host.appendChild(btn);
      return true;
    }

    // Try now; retry briefly if the toolbar isn't in the DOM yet.
    if (!injectButton()) {
      var attempts = 0;
      var retry = setInterval(function () {
        attempts++;
        if (injectButton() || attempts > 20) clearInterval(retry);
      }, 250);
    }

    // ---------- Get current compose body ----------
    function getComposeBody() {
      // Plain text textarea
      var ta = document.getElementById('composebody');
      // TinyMCE HTML editor
      var ed = (window.tinymce && typeof tinymce.get === 'function')
        ? tinymce.get('composebody')
        : null;

      if (ed && !ed.isHidden && !ed.isHidden()) {
        // HTML mode — get text content (strip HTML so user can paste raw MJML
        // even if Roundcube wraps it). Most users will toggle to plain text
        // mode before pasting MJML, but be forgiving.
        var html = ed.getContent({ format: 'html' });
        var text = ed.getContent({ format: 'text' });
        // Heuristic: if body contains `<mj-` tags (encoded or raw), prefer raw text.
        if (/&lt;mj-|<mj-/i.test(html)) {
          // Decode entities then strip outer wrappers
          var tmp = document.createElement('div');
          tmp.innerHTML = html;
          return (tmp.textContent || tmp.innerText || '').trim();
        }
        return text.trim();
      }

      return (ta && ta.value || '').trim();
    }

    // ---------- Set compose body to compiled HTML ----------
    function setComposeBodyAsHtml(html) {
      var ed = (window.tinymce && typeof tinymce.get === 'function')
        ? tinymce.get('composebody')
        : null;

      // Force HTML mode if currently plain text
      var htmlToggle = document.querySelector('input[name="_is_html"]');
      if (htmlToggle && !htmlToggle.checked) {
        // Roundcube provides rcmail.command('toggle-editor') for this
        rcmail.command('toggle-editor', { html: true, noconvert: true });
      }

      // After toggle, TinyMCE may need a moment
      setTimeout(function () {
        var ed2 = window.tinymce && tinymce.get('composebody');
        if (ed2) {
          ed2.setContent(html);
        } else {
          var ta = document.getElementById('composebody');
          if (ta) ta.value = html;
        }
        rcmail.display_message(rcmail.gettext('inserted', 'mjml_compose') || 'MJML inserted as HTML.', 'confirmation');
      }, 200);
    }

    // ---------- Modal ----------
    function buildModal() {
      var existing = document.getElementById('mjml-modal');
      if (existing) return existing;

      var wrap = document.createElement('div');
      wrap.id = 'mjml-modal';
      wrap.className = 'mjml-modal-bg';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.innerHTML =
        '<div class="mjml-modal">' +
        '  <div class="mjml-modal-head">' +
        '    <span class="mjml-modal-title">' + escapeHtml(rcmail.gettext('modal_title', 'mjml_compose') || 'MJML Preview') + '</span>' +
        '    <span id="mjml-status" class="mjml-modal-status"></span>' +
        '    <button type="button" class="mjml-modal-close" aria-label="Close">×</button>' +
        '  </div>' +
        '  <div id="mjml-warnings" class="mjml-warnings" style="display:none;"></div>' +
        '  <div class="mjml-preview-wrap">' +
        '    <iframe id="mjml-preview" sandbox="allow-same-origin" title="Preview"></iframe>' +
        '  </div>' +
        '  <div class="mjml-modal-foot">' +
        '    <button type="button" class="mjml-btn mjml-btn-ghost" id="mjml-copy">' + escapeHtml(rcmail.gettext('copy_html', 'mjml_compose') || 'Copy HTML') + '</button>' +
        '    <span class="mjml-flex"></span>' +
        '    <button type="button" class="mjml-btn mjml-btn-ghost" id="mjml-cancel">' + escapeHtml(rcmail.gettext('cancel', 'mjml_compose') || 'Cancel') + '</button>' +
        '    <button type="button" class="mjml-btn mjml-btn-primary" id="mjml-insert">' + escapeHtml(rcmail.gettext('insert', 'mjml_compose') || 'Insert as HTML') + '</button>' +
        '  </div>' +
        '</div>';
      document.body.appendChild(wrap);

      wrap.querySelector('.mjml-modal-close').addEventListener('click', closeModal);
      wrap.querySelector('#mjml-cancel').addEventListener('click', closeModal);
      wrap.addEventListener('click', function (e) {
        if (e.target === wrap) closeModal();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeModal();
      });

      wrap.querySelector('#mjml-copy').addEventListener('click', function () {
        if (!modalState.html) return;
        navigator.clipboard.writeText(modalState.html).then(function () {
          rcmail.display_message(rcmail.gettext('copied', 'mjml_compose') || 'HTML copied to clipboard.', 'confirmation');
        }).catch(function () {
          rcmail.display_message('Copy failed.', 'error');
        });
      });

      wrap.querySelector('#mjml-insert').addEventListener('click', function () {
        if (!modalState.html) return;
        setComposeBodyAsHtml(modalState.html);
        closeModal();
      });

      return wrap;
    }

    function openModal() {
      var m = buildModal();
      m.classList.add('is-open');
    }

    function closeModal() {
      var m = document.getElementById('mjml-modal');
      if (m) m.classList.remove('is-open');
    }

    var modalState = { html: '' };

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    // ---------- Trigger ----------
    function runPreview() {
      var body = getComposeBody();
      if (!body) {
        rcmail.display_message(rcmail.gettext('empty_body', 'mjml_compose') || 'Compose body is empty.', 'warning');
        return;
      }
      if (body.indexOf('<mjml') === -1 && body.indexOf('<mj-') === -1) {
        if (!confirm("Body doesn't look like MJML — try anyway?")) return;
      }

      openModal();
      var status = document.getElementById('mjml-status');
      var iframe = document.getElementById('mjml-preview');
      var warnEl = document.getElementById('mjml-warnings');
      status.textContent = rcmail.gettext('compiling', 'mjml_compose') || 'Compiling…';
      status.className = 'mjml-modal-status';
      iframe.srcdoc = '<html><body style="font-family:sans-serif;padding:24px;color:#666">Compiling MJML…</body></html>';
      warnEl.style.display = 'none';
      warnEl.innerHTML = '';
      modalState.html = '';

      var url = rcmail.url('plugin.mjml_compile');

      fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ mjml: body }),
      })
        .then(function (res) {
          return res.json().then(function (j) { return { ok: res.ok, status: res.status, body: j }; });
        })
        .then(function (r) {
          if (!r.ok) {
            status.textContent = (r.body && (r.body.error || ('HTTP ' + r.status))) || 'Error';
            status.className = 'mjml-modal-status is-err';
            iframe.srcdoc = '<html><body style="font-family:sans-serif;padding:24px;color:#a00"><strong>Compile error</strong><br>' +
              escapeHtml((r.body && (r.body.detail || r.body.error)) || ('HTTP ' + r.status)) + '</body></html>';
            return;
          }

          modalState.html = r.body.html || '';
          iframe.srcdoc = modalState.html;
          status.textContent = ((modalState.html.length / 1024).toFixed(1)) + ' KB · ✓';
          status.className = 'mjml-modal-status is-ok';

          if (Array.isArray(r.body.errors) && r.body.errors.length) {
            warnEl.style.display = 'block';
            warnEl.innerHTML = '<strong>' +
              escapeHtml(rcmail.gettext('warnings_title', 'mjml_compose') || 'MJML warnings:') +
              '</strong><ul>' +
              r.body.errors.map(function (e) {
                return '<li>Line ' + escapeHtml(e.line || '?') + ' (' + escapeHtml(e.tagName || '') + '): ' + escapeHtml(e.message || '') + '</li>';
              }).join('') +
              '</ul>';
          }
        })
        .catch(function (err) {
          status.textContent = 'Network error';
          status.className = 'mjml-modal-status is-err';
          iframe.srcdoc = '<html><body style="font-family:sans-serif;padding:24px;color:#a00">' + escapeHtml(String(err)) + '</body></html>';
        });
    }
  });
}
