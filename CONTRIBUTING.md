# Contributing

Issues and focused pull requests welcome.

Requirements: Node.js 22+ and npm.

```sh
npm ci
npm run check
npm run package
npm run preview
```

`npm run check` includes a lifecycle regression using the actual extension source and synthetic external services, plus browser checks for navigation, accessibility, focus, unknown values and layouts at 320, 390, 768 and 1408 pixels.

`npm run test:extension` runs isolated VS Code extension-host smoke and recovery tests with synthetic telemetry. These checks do not prove actual Copilot delivery or an installed JetBrains IDE session.

To test a packaged candidate, extract `hoosage.vsix` and set
`HOOSAGE_EXTENSION_PATH` to its absolute `extension/` directory before running
`npm run test:extension`. `VSCODE_EXECUTABLE` selects an existing VS Code binary.
The harness keeps its own user profile and extension directory.

Use Conventional Commits. Hooversion maps `feat` to minor releases, `fix` and `perf` to patch releases, and `!` or a `BREAKING CHANGE:` footer to major releases. Other valid commit types do not publish a version. Keep pull requests small enough to review. Explain user-visible behavior, threat-model changes, and compatibility impact.

By contributing, you agree that your contribution is licensed under MIT.
