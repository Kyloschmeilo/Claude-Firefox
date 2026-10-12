// Wandelt ein Chrome-MV3-Manifest in ein Firefox-MV3-Manifest um.
// Grundregel: Am Code der Original-Extension wird nichts verändert. Fehlende
// Chrome-APIs ersetzen wir zur Laufzeit durch die Skripte unter src/ff/.

export const DEFAULT_GECKO_ID = 'claude-firefox-port@localhost';
export const DEFAULT_CHROME_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
export const MIN_FIREFOX_VERSION = '140.0';

/** Shim-Skripte, die vor dem Original-Hintergrundskript laufen. */
export const BACKGROUND_SHIMS = [
  'ff/config.js',
  'ff/core.js',
  'ff/compat.js',
  'ff/debugger.js',
  'ff/engine.js',
  'ff/background.js',
];

/** Shim-Skripte für Erweiterungsseiten (Seitenpanel, Optionen, ...). */
export const PAGE_SHIMS = ['ff/config.js', 'ff/core.js', 'ff/compat.js', 'ff/debugger.js', 'ff/page.js'];

/** Shim für Content-Scripts (isolierte Welt). */
export const CONTENT_SHIMS = ['ff/content.js'];

export const SIDEBAR_PAGE = 'ff/sidebar.html';

// Berechtigungen, die Firefox kennt. Alles andere wird entfernt und gemeldet.
const FIREFOX_PERMISSIONS = new Set([
  'activeTab',
  'alarms',
  'bookmarks',
  'browserSettings',
  'browsingData',
  'captivePortal',
  'clipboardRead',
  'clipboardWrite',
  'contextMenus',
  'contextualIdentities',
  'cookies',
  'declarativeNetRequest',
  'declarativeNetRequestFeedback',
  'declarativeNetRequestWithHostAccess',
  'devtools',
  'dns',
  'downloads',
  'downloads.open',
  'find',
  'geolocation',
  'history',
  'identity',
  'idle',
  'management',
  'menus',
  'menus.overrideContext',
  'nativeMessaging',
  'notifications',
  'pkcs11',
  'privacy',
  'proxy',
  'scripting',
  'search',
  'sessions',
  'storage',
  'tabGroups',
  'tabHide',
  'tabs',
  'theme',
  'topSites',
  'unlimitedStorage',
  'userScripts',
  'webNavigation',
  'webRequest',
  'webRequestAuthProvider',
  'webRequestBlocking',
  'webRequestFilterResponse',
]);

// Werden für die Firefox-Ersatzfunktionen gebraucht.
const REQUIRED_PERMISSIONS = ['tabs', 'scripting', 'webNavigation', 'webRequest', 'storage'];

// Manifest-Schlüssel, die Firefox nicht kennt oder die hier nichts bringen.
const DROPPED_KEYS = [
  'key',
  'update_url',
  'minimum_chrome_version',
  'differential_fingerprint',
  'side_panel',
  'externally_connectable',
  'oauth2',
  'export',
  'import',
  'file_handlers',
  'file_browser_handlers',
  'file_system_provider_capabilities',
  'input_components',
  'nacl_modules',
  'offline_enabled',
  'platforms',
  'requirements',
  'storage',
  'system_indicator',
  'tts_engine',
  'event_rules',
  'automation',
  'current_locale',
  'trial_tokens',
  'cross_origin_embedder_policy',
  'cross_origin_opener_policy',
  'replacement_web_app',
  'version_name',
  'options_page',
  'launch',
  'chrome_os_system_extension',
];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function filterPermissions(list, report, field) {
  if (!Array.isArray(list)) return [];
  const kept = [];
  for (const p of list) {
    if (typeof p !== 'string') continue;
    if (FIREFOX_PERMISSIONS.has(p)) {
      if (!kept.includes(p)) kept.push(p);
    } else {
      report.removedPermissions.push(`${field}: ${p}`);
    }
  }
  return kept;
}

function looksLikeSidePanelCommand(name, command) {
  if (name === '_execute_action' || name === '_execute_browser_action') return true;
  const text = `${name} ${command?.description ?? ''}`;
  return /side[\s_-]?panel/i.test(text);
}

/**
 * @param {object} chromeManifest  Original-Manifest aus der CRX
 * @param {object} [options]
 * @param {string} [options.geckoId]
 * @param {string|null} [options.chromeExtensionId]
 * @param {string} [options.versionSuffix]
 * @param {boolean} [options.keepName]
 * @param {string} [options.name]  eigener Name des Add-ons
 * @returns {{ manifest: object, config: object, report: object }}
 */
export function transformManifest(chromeManifest, options = {}) {
  if (!isPlainObject(chromeManifest)) throw new Error('manifest.json ist kein Objekt.');
  if (chromeManifest.manifest_version !== 3) {
    throw new Error(`Nur Manifest V3 wird unterstützt (gefunden: ${chromeManifest.manifest_version}).`);
  }
  const report = { removedPermissions: [], removedKeys: [], warnings: [], notes: [] };
  const m = clone(chromeManifest);
  const geckoId = options.geckoId || DEFAULT_GECKO_ID;

  // --- Konfiguration für die Shims (landet in ff/config.js) -------------------
  const externallyConnectable = Array.isArray(m.externally_connectable?.matches)
    ? m.externally_connectable.matches.filter((s) => typeof s === 'string')
    : [];
  const sidePanelPath = typeof m.side_panel?.default_path === 'string' ? m.side_panel.default_path : null;
  const commands = isPlainObject(m.commands) ? m.commands : {};
  const sidePanelCommands = Object.keys(commands).filter((name) => looksLikeSidePanelCommand(name, commands[name]));

  // --- Entfernte Schlüssel ---------------------------------------------------
  const optionsPage = typeof m.options_page === 'string' ? m.options_page : null;
  for (const key of DROPPED_KEYS) {
    if (key in m) {
      delete m[key];
      if (key !== 'options_page') report.removedKeys.push(key);
    }
  }

  // --- Name / Version --------------------------------------------------------
  // Kein "Firefox" im Namen: addons.mozilla.org lehnt Namen mit Mozilla-Marken ab.
  if (typeof options.name === 'string' && options.name.trim()) {
    m.name = options.name.trim();
  } else if (!options.keepName && typeof m.name === 'string' && !m.name.startsWith('__MSG_')) {
    m.name = `${m.name} (inoffizieller Port)`;
  }
  if (typeof m.name === 'string' && /firefox|mozilla/i.test(m.name)) {
    report.warnings.push('Der Name enthält „Firefox“/„Mozilla“ – addons.mozilla.org lehnt solche Namen ab.');
  }
  if (typeof m.author === 'object' && m.author) {
    m.author = m.author.email || m.author.name || undefined;
    if (!m.author) delete m.author;
  }
  if (options.versionSuffix) {
    const parts = String(m.version).split('.');
    if (parts.length >= 4) report.warnings.push('Version hat schon 4 Stellen – Suffix wird ignoriert.');
    else m.version = `${m.version}.${options.versionSuffix}`;
  }

  // --- Firefox-spezifische Einstellungen ------------------------------------
  m.browser_specific_settings = {
    gecko: {
      id: geckoId,
      strict_min_version: MIN_FIREFOX_VERSION,
      // Ehrliche Angabe: Seiteninhalte, Chats und Anmeldung gehen an Anthropic.
      data_collection_permissions: {
        required: ['websiteContent', 'browsingActivity', 'personalCommunications', 'authenticationInfo'],
        optional: ['technicalAndInteraction'],
      },
    },
  };

  // --- Hintergrund: Service Worker -> Event-Page-Skripte --------------------
  const bg = m.background;
  if (!isPlainObject(bg) || (typeof bg.service_worker !== 'string' && !Array.isArray(bg.scripts))) {
    throw new Error('Manifest hat kein background.service_worker.');
  }
  const originalBackground = bg.service_worker ? [bg.service_worker] : bg.scripts;
  const isModule = bg.type === 'module';
  m.background = { scripts: [...BACKGROUND_SHIMS, ...originalBackground] };
  if (isModule) m.background.type = 'module';
  else report.notes.push('Hintergrundskript ist kein ES-Modul; importScripts() steht in Firefox nicht zur Verfügung.');

  // --- Seitenpanel -> Firefox-Sidebar ---------------------------------------
  const action = isPlainObject(m.action) ? m.action : null;
  m.sidebar_action = {
    default_panel: SIDEBAR_PAGE,
    default_title: (action && action.default_title) || chromeManifest.name || 'Claude',
    open_at_install: false,
  };
  const icon = (action && action.default_icon) || m.icons;
  if (icon) m.sidebar_action.default_icon = icon;
  if (!sidePanelPath) report.warnings.push('Kein side_panel.default_path im Manifest gefunden.');

  // --- Optionen ---------------------------------------------------------------
  if (optionsPage && !m.options_ui) m.options_ui = { page: optionsPage, open_in_tab: true };
  if (isPlainObject(m.options_ui)) delete m.options_ui.chrome_style;

  // --- Berechtigungen --------------------------------------------------------
  m.permissions = filterPermissions(m.permissions, report, 'permissions');
  for (const p of REQUIRED_PERMISSIONS) if (!m.permissions.includes(p)) m.permissions.push(p);
  if (Array.isArray(m.optional_permissions)) {
    m.optional_permissions = filterPermissions(m.optional_permissions, report, 'optional_permissions').filter(
      (p) => !m.permissions.includes(p),
    );
    if (!m.optional_permissions.length) delete m.optional_permissions;
  }
  if (!Array.isArray(m.host_permissions)) m.host_permissions = [];
  if (!m.host_permissions.includes('<all_urls>')) {
    report.warnings.push('host_permissions enthält kein <all_urls> – Screenshots und Klicks gehen nur auf erlaubten Seiten.');
  }

  // --- Content-Scripts ------------------------------------------------------
  const contentScripts = Array.isArray(m.content_scripts) ? m.content_scripts : [];
  for (const cs of contentScripts) {
    if (!isPlainObject(cs)) continue;
    if (cs.world !== 'MAIN' && Array.isArray(cs.js) && cs.js.length) {
      cs.js = [...CONTENT_SHIMS, ...cs.js.filter((f) => !CONTENT_SHIMS.includes(f))];
    }
  }
  if (externallyConnectable.length) {
    // Ersatz für externally_connectable: claude.ai spricht über diese Brücke mit der Extension.
    contentScripts.push(
      { matches: externallyConnectable, js: ['ff/claude-bridge-main.js'], run_at: 'document_start', world: 'MAIN' },
      { matches: externallyConnectable, js: ['ff/claude-bridge.js'], run_at: 'document_start' },
    );
  } else {
    report.warnings.push('Kein externally_connectable im Manifest – Login über claude.ai evtl. nicht möglich.');
  }
  m.content_scripts = contentScripts;

  // --- Web-Accessible-Resources --------------------------------------------
  if (Array.isArray(m.web_accessible_resources)) {
    m.web_accessible_resources = m.web_accessible_resources
      .filter(isPlainObject)
      .map((war) => {
        const out = { ...war };
        delete out.use_dynamic_url;
        delete out.extension_ids;
        return out;
      })
      .filter((war) => Array.isArray(war.matches) && war.matches.length && Array.isArray(war.resources));
  }

  // --- Tastenkürzel -----------------------------------------------------------
  if (isPlainObject(m.commands)) {
    for (const cmd of Object.values(m.commands)) {
      if (isPlainObject(cmd)) delete cmd.global;
    }
  }

  // --- Content-Security-Policy ---------------------------------------------
  if (isPlainObject(m.content_security_policy)) {
    // Firefox akzeptiert eine Sandbox-CSP nur mit "sandbox"-Direktive und ohne allow-same-origin.
    const sb = m.content_security_policy.sandbox;
    if (sb !== undefined && (typeof sb !== 'string' || !/(^|;)\s*sandbox(\s|;|$)/.test(sb) || /allow-same-origin/.test(sb))) {
      delete m.content_security_policy.sandbox;
      report.removedKeys.push('content_security_policy.sandbox');
    }
    if (!Object.keys(m.content_security_policy).length) delete m.content_security_policy;
  } else if (typeof m.content_security_policy === 'string') {
    m.content_security_policy = { extension_pages: m.content_security_policy };
  }

  if (m.incognito === 'split') m.incognito = 'spanning';

  const config = {
    portVersion: options.portVersion || '0.0.0',
    originalVersion: chromeManifest.version,
    originalName: chromeManifest.name,
    geckoId,
    chromeExtensionIds: [options.chromeExtensionId || DEFAULT_CHROME_EXTENSION_ID],
    externallyConnectable,
    sidePanelPath,
    sidePanelCommands,
    sandboxPages: Array.isArray(m.sandbox?.pages) ? m.sandbox.pages.filter((p) => typeof p === 'string') : [],
  };

  return { manifest: m, config, report };
}
