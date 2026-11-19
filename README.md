# SVA Maintenance

Maintenance request portal for Shenandoah Valley Academy.

This repository holds **only the page** (what people see on their phones). All data, staff emails and rules live in a Google Sheet with Apps Script owned by the school account; nothing private is stored here.

- `index.html`, `app.js`, `app.css`: the page.
- `config.js`: address of the Apps Script and the page level it expects.
- `.github/workflows/deploy.yml`: before every publish it checks that the Apps Script answers `?check=version` with matching versions. If not, it does not publish and the current page keeps working.
- `.github/workflows/daily-check.yml`: runs the same check every morning and fails (GitHub sends an email) if the two halves stop matching.
- `tests/page.test.js`: browser test with a fake Apps Script (`node tests/page.test.js`, needs Playwright).

Sign-in is a one-time link emailed to the school address; the link can only point to the address saved in the Sheet (Settings > App URL), and every new sign-in sends a "sign out everywhere" email.

Order for changes that touch both halves: Apps Script first (paste, New version), then this page.
