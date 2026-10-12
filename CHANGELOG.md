# Änderungen

Alle nennenswerten Änderungen an diesem Projekt. Versionsnummern folgen [SemVer](https://semver.org/lang/de/).

## [0.1.2] – 2026-10-12

### Behoben

- Die Sidebar zeigte bei aktuellen Versionen der Extension nur „Firefox darf diese eingebettete Seite nicht öffnen“.
  Die Extension bettet claude.ai in das Seitenpanel ein. Chrome erlaubt das, Firefox blockierte es wegen der
  Schutz-Header von claude.ai (`X-Frame-Options`, `frame-ancestors`). Der Port hebt diese Header jetzt per
  `declarativeNetRequest` auf, aber nur für Rahmen in Seiten der Extension und in der Sidebar. Normale Webseiten
  dürfen claude.ai weiterhin nicht einbetten.
- Die Verbindung zwischen claude.ai und der Extension (Ersatz für `externally_connectable`) funktioniert jetzt auch
  im eingebetteten claude.ai.

### Teststand

- Neue End-to-End-Prüfungen: eingebettete Seite mit `X-Frame-Options`/`frame-ancestors` lädt, Cookies kommen an
  (nicht partitioniert, `SameSite=Lax`), Nachrichten an die Extension funktionieren, normale Webseiten bleiben
  blockiert. Getestet mit Firefox 157 gegen die ältere Extension-Version 1.0.70. Mit der aktuellen Version (1.0.100)
  ist die Korrektur nicht getestet.

### So benutzt du es

Neu bauen wie bei 0.1.0. Wer das Add-on über addons.mozilla.org signiert: mit derselben `--gecko-id` und einer
höheren `--version-suffix` bauen und als neue Version hochladen.

> Inoffizielles Projekt, nicht von Anthropic. Die Extension ist proprietäre Software von Anthropic. Nutzung nur privat
> und auf eigenes Risiko. Gebaute Dateien nicht weitergeben.

## [0.1.1] – 2026-10-12

### Geändert

- Der Name des Add-ons enthält kein „Firefox“ mehr. addons.mozilla.org lehnt Namen mit Mozilla-Marken ab.
  Standard ist jetzt `<Original> (inoffizieller Port)` statt `<Original> (Firefox-Port)`.

### Neu

- Build-Option `--name <text>` für einen eigenen Add-on-Namen. Enthält er „Firefox“ oder „Mozilla“, warnt der Build.

### So benutzt du es

Wie bei 0.1.0: Quellcode („Source code (zip)“) herunterladen, entpacken, `build.cmd` doppelklicken und die
`.xpi` aus `dist\` in Firefox unter `about:debugging#/runtime/this-firefox` → „Temporäres Add-on laden…“ öffnen.
Hinweise und Einschränkungen: siehe Version 0.1.0 und die README.

> Inoffizielles Projekt, nicht von Anthropic. Die Extension ist proprietäre Software von Anthropic. Nutzung nur privat
> und auf eigenes Risiko. Gebaute Dateien nicht weitergeben.

## [0.1.0] – 2026-10-11

Erste Version: Die offizielle Claude-Browser-Extension („Claude in Chrome“) wird lokal auf deinem Rechner zu einem
Firefox-Add-on umgebaut. Dieses Release enthält **keinen Code von Anthropic** und keine fertige `.xpi`-Datei. Die
Extension lädt das Build-Skript beim Bauen selbst aus dem Chrome Web Store.

### So benutzt du es

1. Unten unter „Assets“ den Quellcode („Source code (zip)“) herunterladen und entpacken.
2. [Node.js](https://nodejs.org) 18 oder neuer installieren.
3. `build.cmd` doppelklicken (Windows) bzw. `node scripts/build.mjs` ausführen. Das erzeugt
   `dist/claude-firefox-<version>.xpi`.
4. In Firefox `about:debugging#/runtime/this-firefox` öffnen → „Temporäres Add-on laden…“ → die `.xpi` wählen.

Details, dauerhafte Installation und Fehlerbehebung: siehe [README](README.md).

### Enthalten

- **Build-Skript** ohne Abhängigkeiten:
  - CRX laden und entpacken
  - Manifest für Firefox umbauen: Service Worker → Hintergrundskript, Seitenpanel → Sidebar, Berechtigungen, Add-on-ID
  - Shims einbinden und Icons quadratisch machen
  - XPI packen
- **Ersatz für `chrome.debugger`**:
  - Screenshots
  - JavaScript-Ausführung
  - Klicks, Doppelklicks, Tippen (inkl. Umlaute/Emojis), Tastenkürzel, Scrollen und Drag & Drop
  - Klicks in iframes
  - Mitschnitt von Browser-Konsole und Netzwerk-Anfragen
- **Seitenpanel → Firefox-Sidebar** (eine Claude-Sitzung pro Fenster), echte Firefox-Tab-Gruppen
- **Anmeldung über claude.ai**: Ersatz für `externally_connectable`. Weiterleitungen auf `chrome-extension://` werden abgefangen.
- Offscreen-Dokument, Chrome-only-Optionen, `chrome://`-Links und fehlende Konstanten werden für Firefox ersetzt bzw. ergänzt.
- Windows-Hilfen: `build.cmd`, optionales Skript zur Anbindung von Claude Code / Claude Desktop (experimentell).
- Tests: Unit-Tests (`npm test`) und ein End-to-End-Test in echtem Firefox (`test/e2e/run.mjs`).

### Teststand

- Getestet mit Firefox 157 gegen die **ältere Extension-Version 1.0.70**. Alle Unit-Tests und alle End-to-End-Prüfungen bestehen.
- Vor dem Release hat eine mehrstufige Code-Review 37 Fehler gefunden, alle behoben. Die meisten betrafen Randfälle der
  nachgebauten Eingaben, darunter Enter/keypress, macOS-Tastenbefehle, deaktivierte Buttons, Tab-Reihenfolge,
  Pop-ups, Zoom bei Screenshots und Ruhezustand des Hintergrunds. Dazu kam eine Härtung der Login-Weiterleitung.
- **Nicht getestet:**
  - die aktuelle Extension-Version
  - die Anmeldung mit einem echten Claude-Konto
  - die Windows-Skripte unter echtem Windows (das PowerShell-Skript ist nur auf Syntax geprüft;
    die Unit-Tests laufen in der CI auch unter Windows)
  - die Anbindung an Claude Code / Claude Desktop

### Bekannte Einschränkungen

- Firefox erlaubt Erweiterungen keine echten Maus- und Tastatureingaben. Der Port erzeugt die Events selbst. Nicht möglich sind:
  - CSS-Hover-Menüs
  - native Auswahllisten aufklappen
  - Seiten, die nur „echte“ Klicks akzeptieren
- Kein Kopieren/Einfügen über die Zwischenablage (`Strg+C`/`Strg+V`).
- „Seite verlassen?“-Dialoge beim Navigieren werden nicht erkannt.
- Keine JavaScript-Ausführung auf Seiten mit strenger Content-Security-Policy.
- Keine Datei-Uploads von lokalen Pfaden.
- Im normalen Firefox nur als temporäres Add-on. Nach einem Neustart neu laden, die Anmeldung bleibt erhalten.

> Inoffizielles Projekt, nicht von Anthropic. Die Extension ist proprietäre Software von Anthropic. Nutzung nur privat
> und auf eigenes Risiko. Gebaute Dateien nicht weitergeben.
