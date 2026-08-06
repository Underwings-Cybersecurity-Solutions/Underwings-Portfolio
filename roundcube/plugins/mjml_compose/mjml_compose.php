<?php
/**
 * MJML Compose — Roundcube plugin
 *
 * Adds a "Preview MJML" button to the compose toolbar.
 * Server-side action POSTs the compose body to the internal mjml-compiler
 * sidecar service and returns the rendered HTML for in-modal preview and
 * optional one-click insertion.
 *
 * Configuration (env or config/config.inc.php):
 *   $config['mjml_compose_endpoint'] = 'http://mjml:3000/compile';
 *   $config['mjml_compose_token']    = '';   // optional shared token
 */

class mjml_compose extends rcube_plugin
{
    public $task = 'mail';
    public $noajax = false;

    function init()
    {
        $rcmail = rcube::get_instance();

        // Only run for the compose task
        if (!$rcmail->action || !in_array($rcmail->action, ['compose', 'plugin.mjml_compile'])) {
            // we still need to register the AJAX action regardless of current screen
        }

        $this->add_texts('localization/', true);

        $this->include_script('mjml_compose.js');
        $this->include_stylesheet($this->local_skin_path() . '/mjml_compose.css');

        // Add toolbar button to compose form
        $this->add_hook('render_page', [$this, 'on_render_page']);

        // AJAX endpoint for the server-side compile
        $this->register_action('plugin.mjml_compile', [$this, 'action_compile']);
    }

    /**
     * On render: inject button + localized labels for JS.
     */
    function on_render_page($args)
    {
        if ($args['template'] !== 'compose') return $args;

        $rcmail = rcube::get_instance();

        // Push localized strings to JS
        $rcmail->output->add_label(
            'mjml_compose.preview',
            'mjml_compose.insert',
            'mjml_compose.cancel',
            'mjml_compose.close',
            'mjml_compose.compiling',
            'mjml_compose.error',
            'mjml_compose.empty_body',
            'mjml_compose.warnings_title',
            'mjml_compose.modal_title',
            'mjml_compose.copy_html',
            'mjml_compose.copied'
        );

        return $args;
    }

    /**
     * AJAX handler: POST { mjml: string } -> { html, errors[] }
     */
    function action_compile()
    {
        $rcmail = rcube::get_instance();

        // CSRF: require POST and a valid Roundcube session
        if (rcube_utils::get_input_value('_method', rcube_utils::INPUT_GET) === 'GET'
            || $_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_error(405, 'Method not allowed');
        }

        // Read raw JSON body
        $raw  = file_get_contents('php://input');
        $body = json_decode($raw, true);
        if (!is_array($body)) {
            $this->json_error(400, 'Invalid JSON body');
        }

        $source = isset($body['mjml']) ? trim((string)$body['mjml']) : '';
        if ($source === '') {
            $this->json_error(400, 'Empty MJML input');
        }

        // Cap input size
        if (strlen($source) > 1024 * 1024) {
            $this->json_error(413, 'Input too large (1 MB max)');
        }

        // Resolve sidecar config
        $endpoint = $rcmail->config->get('mjml_compose_endpoint', 'http://mjml:3000/compile');
        $token    = $rcmail->config->get('mjml_compose_token', '');

        // Forward to sidecar
        $payload = json_encode(['mjml' => $source]);
        $headers = [
            'Content-Type: application/json',
            'Accept: application/json',
        ];
        if ($token !== '') {
            $headers[] = 'Authorization: Bearer ' . $token;
        }

        $ch = curl_init($endpoint);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_CONNECTTIMEOUT => 5,
        ]);

        $resp_body = curl_exec($ch);
        $resp_code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curl_err  = curl_error($ch);
        curl_close($ch);

        if ($resp_body === false) {
            $this->json_error(502, 'MJML compiler unreachable: ' . $curl_err);
        }

        if ($resp_code < 200 || $resp_code >= 300) {
            $detail = '';
            $j = json_decode($resp_body, true);
            if (is_array($j)) {
                $detail = $j['error'] ?? '';
                if (!empty($j['detail'])) $detail .= ' — ' . $j['detail'];
            }
            $this->json_error($resp_code, 'Compile error', $detail);
        }

        // Pass-through (already JSON)
        header('Content-Type: application/json; charset=utf-8');
        echo $resp_body;
        exit;
    }

    private function json_error($code, $error, $detail = '')
    {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => $error, 'detail' => $detail]);
        exit;
    }
}
