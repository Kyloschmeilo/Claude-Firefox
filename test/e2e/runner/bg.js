// Nur für Tests: öffnet die Testseite nach dem Start des Add-ons.
setTimeout(() => browser.tabs.create({ url: browser.runtime.getURL('ff-test/runner.html') }), 1000);
