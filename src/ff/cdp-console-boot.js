/*
 * Claude-Firefox: wird nur geladen, solange Claude die Browser-Konsole eines
 * Tabs mitliest. Sagt cdp-agent.js, dass es Console-Ausgaben schon ab dem
 * Seitenstart puffern soll.
 */
globalThis.__ffConsoleBoot = true;
