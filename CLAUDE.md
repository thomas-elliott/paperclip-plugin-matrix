# paperclip-plugin-matrix

Paperclip plugin that connects Paperclip to Matrix. Built the same way as its sibling,
`../paperclip-plugin-forgejo`; look there first for how a pattern was solved.

## Names

- npm package: `@thomas-elliott/paperclip-plugin-matrix` (public, published to npm)
- Plugin ID in Paperclip: `paperclip-plugin-matrix`. Do not rename it once installed: installed
  settings and state are keyed on it.
- Repository: `github.com/thomas-elliott/paperclip-plugin-matrix` (public)

## Paperclip instances

- Production: a hosted Paperclip that cannot see this folder, so it only gets the plugin from npm:
  `npx paperclipai plugin install @thomas-elliott/paperclip-plugin-matrix --api-base <production URL>`.
  Its address and deployment are in `CLAUDE.local.md`.
- Development: a throwaway local Paperclip on this laptop with its own data folder, so it never
  touches production state. Install from this folder with `npx paperclipai plugin install "$PWD"`
  and keep `pnpm dev` running; Paperclip reloads the worker when `dist/` changes.

## Plugin SDK reference

The SDK documentation is in the Paperclip repo, not in the npm package:
`doc/plugins/PLUGIN_AUTHORING_GUIDE.md` and `doc/plugins/PLUGIN_SPEC.md` in
`github.com/paperclipai/paperclip`. Type definitions are in
`node_modules/@paperclipai/plugin-sdk/dist/`.
