// Fügt die Shim-Skripte in die HTML-Seiten der Extension ein. Sie müssen vor
// dem Original-Code laufen. Klassische <script>-Tags im <head> werden während
// des Parsens ausgeführt, also vor allen type="module"-Skripten.

const MARKER = 'data-claude-firefox-shim';

export function injectShims(html, scripts) {
  if (html.includes(MARKER)) return html;
  const tags = scripts.map((src) => `<script src="/${src}" ${MARKER}></script>`).join('');
  const head = html.match(/<head(\s[^>]*)?>/i);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  const htmlTag = html.match(/<html(\s[^>]*)?>/i);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + `<head>${tags}</head>` + html.slice(at);
  }
  return tags + html;
}
