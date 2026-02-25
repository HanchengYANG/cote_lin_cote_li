# Repository Guidelines

## Project Structure & Module Organization
This repository is a WeChat Mini Program with CloudBase cloud functions.

- Root app entry files: `app.js`, `app.json`, `app.wxss`, `sitemap.json`.
- `pages/`: customer and admin pages. Most pages follow `pages/<feature>/index.{js,wxml,wxss,json}`. Admin pages live under `pages/admin/`.
- `components/`: shared UI components such as `navigation-bar`, `order-editor`, and `sync-guard`.
- `utils/`: shared helpers (API wrappers, formatting, page wrapper utilities, caching/snapshots).
- `cloudfunctions/{auth,admin,customer}/`: CloudBase back end, each with its own `package.json`.
- `scripts/check-page-wrapper.js`: repository consistency check for page registration.
- `docs/`: project notes and rollout documentation.

## Build, Test, and Development Commands
- `node scripts/check-page-wrapper.js`: verifies all `pages/**/index.js` files use `createPage(...)` instead of raw `Page(...)`.
- `cd cloudfunctions/auth && npm install` (repeat for `admin` and `customer`): installs cloud function dependencies before deployment.
- WeChat DevTools: open the repo root, enable CloudBase, select the target environment, then upload/deploy cloud functions.

There is no root `package.json` or centralized build script in this repo.

## Coding Style & Naming Conventions
- Use 2-space indentation, single quotes, and semicolon-free JavaScript (match existing files).
- Prefer CommonJS modules (`require`, `module.exports`) in both mini-program code and cloud functions.
- Keep page files in `index.*` within feature folders (example: `pages/checkout/index.js`).
- Follow existing directory naming (`kebab-case`) for feature folders and utility files.
- New pages should use `createPage(...)`; the check script enforces this convention.

## Testing Guidelines
- No automated test framework is currently configured (`*test*` / `*spec*` files are not present).
- Validate changes manually in WeChat DevTools, covering both customer and admin flows.
- After cloud function changes, smoke-test the affected actions and confirm CloudBase data reads/writes succeed.

## Commit & Pull Request Guidelines
- Recent commits use short, imperative subjects, mostly in Chinese; scoped prefixes appear when useful (example: `docs:`).
- Keep commits focused on one change area (UI flow, cloud function behavior, docs, etc.).
- PRs should include: summary of affected flows, manual test steps, screenshots for UI changes (`.wxml`/`.wxss`), and any CloudBase config/data updates (for example `system_admins`, `system_runtime_state`, `delivery_rules`).
