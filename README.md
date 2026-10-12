# Claude-Firefox

Macht die offizielle Claude-Browser-Extension („Claude in Chrome“) in **Firefox** nutzbar.

Das Repository enthält **keinen Code von Anthropic**. Es enthält ein Build-Skript und eine
Kompatibilitätsschicht. Das Skript lädt die aktuelle Extension auf deinem Rechner aus dem
Chrome Web Store, baut sie für Firefox um und erzeugt daraus eine `.xpi`-Datei, die du in
Firefox lädst. Am JavaScript-Code der Extension wird dabei nichts verändert. Fehlende
Chrome-Funktionen ergänzen die Skripte unter `src/ff/` zur Laufzeit.

> [!WARNING]
> **Inoffiziell.** Dieses Projekt hat nichts mit Anthropic zu tun. Anthropic unterstützt
> Claude in Chrome offiziell nur in Google Chrome.
>
> **Rechtliches:** Die Extension ist proprietäre Software von Anthropic. Wenn du sie
> veränderst, verstößt das womöglich gegen Anthropics Nutzungsbedingungen. Nutze den Port
> nur privat und auf eigenes Risiko. Gib die gebauten Dateien (`dist/`, `.xpi`) nicht
> weiter und lade sie nirgends hoch.
>
> **Sicherheit:** Wie in Chrome kann Claude in deinem Browser klicken, tippen und Formulare
> absenden. Es gelten dieselben Vorsichtsregeln wie für Claude in Chrome.

## Voraussetzungen

- Windows 10/11 (macOS und Linux funktionieren genauso)
- Firefox **140** oder neuer
- [Node.js](https://nodejs.org) 18 oder neuer (für das Build-Skript)
- Ein Claude-Abo, mit dem Claude in Chrome funktioniert (Pro, Max, Team oder Enterprise)

## Schnellstart unter Windows

1. Lade dieses Repository herunter („Code“ → „Download ZIP“) und entpacke es, oder nutze `git clone`.
2. Doppelklicke auf **`build.cmd`**. Das Skript lädt die aktuelle Claude-Extension und
   erzeugt `dist\claude-firefox-<version>.xpi`.
3. Öffne in Firefox die Adresse `about:debugging#/runtime/this-firefox`, klicke auf
   **„Temporäres Add-on laden…“** und wähle die `.xpi`-Datei aus.
4. Klicke in der Symbolleiste auf das Claude-Symbol. Falls es fehlt: Puzzle-Symbol →
   Claude anheften. Claude öffnet sich in der Sidebar. Melde dich dort mit deinem
   Claude-Konto an.

## Installationsvarianten

### A) Temporär im normalen Firefox (Standard)

Firefox installiert dauerhaft nur von Mozilla signierte Add-ons. Ein temporär geladenes
Add-on verschwindet beim Beenden von Firefox. Danach lädst du es über
`about:debugging#/runtime/this-firefox` neu (Tipp: Lesezeichen anlegen). Deine Anmeldung
und die Einstellungen der Extension bleiben dabei erhalten (getestet mit Firefox 157).
Geänderte Tastenkombinationen setzt Firefox dagegen bei jedem Neustart zurück.

> Falls die Anmeldung doch einmal verloren geht: In `about:config` die Einstellungen
> `extensions.webextensions.keepStorageOnUninstall` und
> `extensions.webextensions.keepUuidOnUninstall` auf `true` setzen.

### B) Dauerhaft mit Firefox Developer Edition, Nightly oder ESR

Diese Firefox-Versionen dürfen unsignierte Add-ons dauerhaft installieren:

1. `about:config` öffnen und `xpinstall.signatures.required` auf `false` setzen.
2. `about:addons` öffnen → Zahnrad → „Add-on aus Datei installieren…“ → `.xpi` wählen.

> **Warum keine dauerhafte Installation im normalen Firefox?** Dafür müsste Mozilla das
> Add-on signieren. Dazu lädt man das komplette Paket – also Anthropics Code – zu
> addons.mozilla.org hoch. Das wäre eine Weitergabe an Dritte (siehe Hinweis oben) und wird
> hier deshalb nicht beschrieben.

## Bedienung

- **Claude-Symbol in der Symbolleiste:** öffnet Claude für den aktuellen Tab in der Sidebar.
- **Tastenkürzel:** dasselbe wie in Chrome (meist `Strg+E`). Kollidiert es mit Firefox, kannst
  du es unter `about:addons` → Zahnrad → „Tastenkombinationen für Erweiterungen verwalten“
  ändern (bei Variante A nach jedem Firefox-Neustart erneut).
- **Pro Fenster eine Claude-Sitzung:** Die Sidebar zeigt die Sitzung des Tabs, für den du
  Claude zuletzt geöffnet hast. Wechselst du den Tab, läuft eine Aufgabe weiter.
- **Updates:** `build.cmd` erneut ausführen. Dann in `about:debugging` über „Temporäres
  Add-on laden…“ die **neue** Datei `dist\claude-firefox-<neue Version>.xpi` wählen
  (Variante B: wie bei der Installation). Achtung: „Neu laden“ lädt nur die zuerst gewählte,
  alte Datei erneut.

## Was funktioniert – und was nicht

| Funktion | Status |
| --- | --- |
| Chat in der Sidebar | ✅ |
| Anmeldung über claude.ai | ✅ Die Anmelde-Nachricht von claude.ai bzw. die Weiterleitung auf `chrome-extension://…` wird abgefangen und an die Extension übergeben. Mit einem echten Konto noch nicht getestet. |
| Seiten lesen, Elemente finden, Formulare ausfüllen | ✅ |
| Klicken, Tippen, Tastenkürzel, Scrollen, Drag & Drop | ✅ über nachgebaute Browser-Events (Einschränkungen siehe unten; Kopieren/Einfügen per Zwischenablage geht nicht) |
| Screenshots | ✅ |
| JavaScript auf der Seite ausführen | ✅ außer auf Seiten mit strenger Content-Security-Policy (Firefox lässt das nicht zu; Claude bekommt dann einen Hinweis) |
| Browser-Konsole und Netzwerk-Anfragen mitlesen | ✅ |
| Tab-Gruppen | ✅ echte Firefox-Tab-Gruppen |
| Links mit `target=_blank` / Pop-ups aus Klicks | ✅ werden als neuer Tab geöffnet |
| Geplante Aufgaben | ⚠️ sollte funktionieren, ungetestet |
| Claude Code / Claude Desktop | ⚠️ experimentell, siehe unten |
| Datei-Upload von lokalen Pfaden (aus Claude Code) | ❌ Firefox-Erweiterungen dürfen keine lokalen Dateien lesen |
| Sidebar über den Knopf auf claude.ai öffnen | ⚠️ Firefox erlaubt das Öffnen nur nach einem Klick auf das Symbol. Es erscheint ein Hinweis. |
| „Seite verlassen?“-Dialoge beim Navigieren | ⚠️ werden nicht erkannt: Claude meldet die Navigation als erfolgreich, Firefox zeigt aber seinen Dialog und bleibt auf der Seite |

**Grenzen der nachgebauten Eingaben:** Chrome lässt Claude über seine Debugger-Schnittstelle
echte Maus- und Tastatureingaben auslösen. Firefox bietet Erweiterungen das nicht an. Der
Port erzeugt deshalb dieselben DOM-Events selbst und führt die Standardaktion aus (Fokus,
Cursor, Text einfügen, Formular absenden, Scrollen). Das klappt auf den allermeisten Seiten.
Nicht möglich sind:
- Menüs, die nur per CSS-`:hover` aufklappen
- native Auswahllisten aufklappen (Claude wählt Werte stattdessen direkt aus)
- Seiten, die ausdrücklich nur „echte“ Klicks akzeptieren (`event.isTrusted`)
- Kopieren, Ausschneiden und Einfügen über die Zwischenablage (`Strg+C`, `Strg+X`, `Strg+V`);
  Claude tippt Text stattdessen direkt ein

## Claude Code / Claude Desktop anbinden (optional, experimentell)

Claude Code (`claude --chrome`) und Claude Desktop sprechen über „Native Messaging“ mit der
Extension. Beide melden sich dafür nur bei Chrome an. So übernimmst du diese Anmeldung für
Firefox:

1. Claude Code bzw. Claude Desktop zuerst wie gewohnt für Chrome einrichten.
2. In PowerShell im Repository-Ordner ausführen:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\windows\install-native-host.ps1
   ```
   Hast du beim Bauen eine eigene `--gecko-id` verwendet, gib sie mit `-GeckoId …` an.
3. Firefox neu starten.

Rückgängig machen: dasselbe Skript mit `-Uninstall` aufrufen.

## So funktioniert der Port

**Build** (`scripts/build.mjs`):
1. CRX aus dem Chrome Web Store laden, über dieselbe Update-Schnittstelle, die Chrome benutzt.
2. CRX entpacken.
3. `manifest.json` für Firefox umbauen:
   - Service Worker → Hintergrundskript
   - Seitenpanel → Firefox-Sidebar
   - Chrome-Berechtigungen filtern
   - Firefox-Add-on-ID ergänzen
4. Die Shims vor den Original-Code hängen: in den HTML-Seiten, im Hintergrund und in den Content-Scripts.
5. Icons quadratisch machen (Vorgabe von Mozilla) und alles als `.xpi` packen.

**Kompatibilitätsschicht** (`src/ff/`):

| Chrome | Firefox-Ersatz |
| --- | --- |
| `chrome.debugger` (CDP: Klicks, Tippen, Screenshots, JavaScript, Konsole, Netzwerk) | `engine.js` im Hintergrund + `cdp-agent.js` in der Seite. Nutzt `tabs.captureTab`, `scripting.executeScript`, `webRequest` und synthetische Events. |
| `chrome.sidePanel` | `sidebarAction`, eine Sitzung pro Fenster |
| `chrome.offscreen` | verstecktes iframe im Hintergrund |
| `externally_connectable` (claude.ai ↔ Extension, Anmeldung) | `claude-bridge-main.js` + `claude-bridge.js` (auch in eingebetteten Rahmen) |
| claude.ai eingebettet im Seitenpanel (Chrome lässt `chrome-extension://` als Einbetter zu) | `declarativeNetRequest`-Sitzungsregeln entfernen `X-Frame-Options`/CSP – nur für Rahmen in Seiten der Extension und in der Sidebar |
| OAuth-Weiterleitung auf `chrome-extension://` | wird per `webNavigation`/`webRequest`/Navigation API abgefangen |
| Service-Worker-Erkennung | `ServiceWorkerGlobalScope` im Hintergrund |
| Chrome-only-Optionen (z. B. Benachrichtigungs-Buttons) | werden automatisch entfernt |
| `chrome://`-Links | Hinweisseite mit der passenden Firefox-Einstellung |

## Weitere Build-Optionen

```text
node scripts/build.mjs --help
  --crx <datei>          lokale .crx- oder .zip-Datei statt Download
  --dir <ordner>         entpackte Extension, z. B. direkt aus dem Chrome-Profil:
                         %LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\fcoeoabgfenejglbffodgkkbkcdhcgfn
  --gecko-id <id>        eigene Firefox-Add-on-ID
  --version-suffix <n>   Versionsnummer um ".n" ergänzen
  --name <text>          eigener Name für das Add-on (ohne „Firefox“)
  --keep-name            Namen nicht um „(inoffizieller Port)“ ergänzen
  --no-xpi               nur den entpackten Ordner dist/extension erzeugen
```

## Entwicklung und Tests

```bash
npm test                     # Unit-Tests (Build-Skript, Shims)
node scripts/build.mjs       # Add-on bauen
FIREFOX_BIN=… GECKODRIVER_BIN=… node test/e2e/run.mjs
```

Der End-to-End-Test installiert das gebaute Add-on in einem echten Firefox. Er ruft die
Browser-Steuerung der Original-Extension direkt auf, also denselben Code, den Claude
benutzt. Geprüft werden unter anderem:
- Klicks, Doppelklicks und Tippen, auch mit Umlauten und Emojis
- Tastenkürzel und Formulare
- Scrollen und Klicks in fremden iframes
- Screenshots
- JavaScript-Ausführung, Konsole und Netzwerk
- die Brücke zu claude.ai und die Login-Weiterleitung

## Fehlerbehebung

- **Download im Build schlägt fehl:** Internetverbindung bzw. Proxy prüfen. Alternativ
  Claude in Chrome installieren und mit `--dir` direkt aus dem Chrome-Profil bauen (Pfad
  siehe oben).
- **Sidebar bleibt bei „Claude wird gestartet …“:** In `about:debugging` beim Add-on auf
  „Untersuchen“ klicken und die Konsole auf Fehler prüfen. Danach das Add-on neu laden.
- **Sidebar zeigt „Firefox darf diese eingebettete Seite nicht öffnen“:** Das betrifft
  Builds vor Version 0.1.2. Aktuelle Version herunterladen, neu bauen und das Add-on neu
  installieren.
- **Anmeldung klappt nicht:** Melde dich zuerst auf claude.ai im selben Firefox an und
  starte die Anmeldung in der Sidebar dann erneut. Hilft das nicht: In der Konsole des
  Add-ons (siehe oben) nach `OAuth` suchen und das Ergebnis als Issue melden.

## Lizenz

Der eigene Code in diesem Repository steht unter der [MIT-Lizenz](LICENSE). Die
Claude-Extension ist Eigentum von Anthropic und nicht Teil dieses Repositorys.
