/*
 * Claude-Firefox: Startseite der Sidebar.
 * Wird angezeigt, solange in diesem Fenster noch kein Claude-Panel aktiv ist.
 * Startet Claude für den aktuellen Tab – so, als hätte man auf das Symbol geklickt.
 */
(function () {
  'use strict';
  const ff = globalThis.__ff;
  const api = ff.api;
  const de = /^de\b/i.test(navigator.language || '');
  const t = (deText, enText) => (de ? deText : enText);

  const app = document.getElementById('app');
  const status = document.getElementById('status');
  const actions = document.getElementById('actions');
  document.documentElement.lang = de ? 'de' : 'en';

  function show(text, buttons = []) {
    status.textContent = text;
    actions.replaceChildren();
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.secondary) el.className = 'secondary';
      el.addEventListener('click', b.onClick);
      actions.appendChild(el);
    }
    actions.hidden = !buttons.length;
    app.classList.toggle('done', !!buttons.length);
  }

  async function ensureHostPermission() {
    const origins = ['<all_urls>'];
    if (await api.permissions.contains({ origins })) return true;
    return new Promise((resolve) => {
      show(
        t(
          'Claude braucht Zugriff auf Webseiten, um sie lesen und bedienen zu können.',
          'Claude needs access to websites to read and operate them.',
        ),
        [
          {
            label: t('Zugriff erlauben', 'Allow access'),
            onClick: () => {
              // Muss direkt im Klick-Handler passieren (Nutzeraktion).
              api.permissions.request({ origins }).then(resolve, () => resolve(false));
            },
          },
        ],
      );
    });
  }

  async function init() {
    const win = await api.windows.getCurrent();
    const auto = await ff.bg.call('sidebar.shouldAutoStart', win.id).catch(() => true);
    if (auto) return start();
    show(t('Claude ist für keinen Tab in diesem Fenster aktiv.', 'Claude is not active for any tab in this window.'), [
      { label: t('Claude für diesen Tab starten', 'Start Claude for this tab'), onClick: start },
    ]);
  }

  async function start() {
    show(t('Claude wird gestartet …', 'Starting Claude …'));
    if (!(await ensureHostPermission())) {
      show(t('Ohne Zugriff auf Webseiten kann Claude nicht arbeiten.', 'Claude cannot work without website access.'), [
        { label: t('Erneut versuchen', 'Try again'), onClick: start },
      ]);
      return;
    }
    show(t('Claude wird gestartet …', 'Starting Claude …'));
    const win = await api.windows.getCurrent();
    let result;
    try {
      result = await ff.bg.call('sidebar.openForTab', win.id);
    } catch (err) {
      result = { ok: false, reason: err.message };
    }
    // Bei Erfolg lädt Firefox gleich das Claude-Panel anstelle dieser Seite.
    setTimeout(
      () =>
        show(
          result && result.ok
            ? t('Claude reagiert nicht.', 'Claude is not responding.')
            : t(`Claude konnte nicht gestartet werden (${result && result.reason}).`, `Claude could not be started (${result && result.reason}).`),
          [{ label: t('Erneut versuchen', 'Try again'), onClick: start }],
        ),
      result && result.ok ? 8000 : 0,
    );
  }

  init();
})();
