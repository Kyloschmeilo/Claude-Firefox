/*
 * Claude-Firefox: Ersatz für chrome://-Seiten, die Firefox nicht öffnen darf.
 */
(function () {
  'use strict';
  const de = /^de\b/i.test(navigator.language || '');
  const t = (deText, enText) => (de ? deText : enText);
  const url = new URLSearchParams(location.search).get('url') || '';
  document.documentElement.lang = de ? 'de' : 'en';

  let hint = t(
    'Öffne die entsprechende Einstellung bitte direkt in Firefox (Menü ☰ → Einstellungen).',
    'Please open the corresponding setting directly in Firefox (menu ☰ → Settings).',
  );
  if (/siteDetails|content\/(microphone|camera)/i.test(url)) {
    hint = t(
      'Mikrofon-/Kamera-Berechtigungen findest du in Firefox unter Einstellungen → Datenschutz & Sicherheit → Berechtigungen.',
      'Microphone/camera permissions are in Firefox under Settings → Privacy & Security → Permissions.',
    );
  } else if (/extensions\/shortcuts/i.test(url)) {
    hint = t(
      'Tastenkürzel änderst du unter about:addons → Zahnrad-Symbol → „Tastenkombinationen für Erweiterungen verwalten“.',
      'Change shortcuts at about:addons → gear icon → "Manage Extension Shortcuts".',
    );
  } else if (/^chrome:\/\/extensions/i.test(url)) {
    hint = t('Erweiterungen verwaltest du unter about:addons.', 'Manage extensions at about:addons.');
  }

  document.getElementById('title').textContent = t('Diese Chrome-Seite gibt es in Firefox nicht', 'This Chrome page does not exist in Firefox');
  document.getElementById('text').textContent = t(
    'Claude wollte eine interne Chrome-Seite öffnen. Firefox erlaubt Erweiterungen nicht, eigene Einstellungsseiten zu öffnen.',
    'Claude tried to open an internal Chrome page. Firefox does not let extensions open its settings pages.',
  );
  document.getElementById('hint').textContent = hint;
  document.getElementById('url').textContent = url;
})();
