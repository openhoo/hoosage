import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Mirrors VS Code's URI.file(path).toString(). It differs from Node's
// pathToFileURL: the Windows drive letter is lowercased and ":" is encoded
// (file:///c%3A/...), and reserved characters are percent-encoded. Project IDs
// hash this exact string, so tests must build it the way VS Code does.
export function vscodeFileUri(path) {
  let value = process.platform === "win32" ? path.replaceAll("\\", "/") : path;
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(
    /^\/([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}:`,
  );
  return `file://${value
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/")}`;
}

// VS Code bundles Copilot Chat as a built-in extension, but does not load it
// in an extension test host. Load that bundled copy as a development extension
// so its settings are registered; COPILOT_EXTENSION_PATH overrides it.
async function bundledCopilot(executable) {
  const dir = dirname(executable);
  const apps = [join(dir, "resources/app"), join(dir, "../Resources/app")];
  for (const entry of await readdir(dir, { withFileTypes: true }))
    if (entry.isDirectory()) apps.push(join(dir, entry.name, "resources/app"));
  for (const app of apps) {
    const extension = join(app, "extensions/copilot");
    try {
      const manifest = JSON.parse(
        await readFile(join(extension, "package.json"), "utf8"),
      );
      if (`${manifest.publisher}.${manifest.name}` === "GitHub.copilot-chat")
        return extension;
    } catch {}
  }
  return undefined;
}

export async function testHost() {
  const vscodeExecutablePath =
    process.env.VSCODE_EXECUTABLE ?? (await downloadAndUnzipVSCode("insiders"));
  const copilot =
    process.env.COPILOT_EXTENSION_PATH ??
    (await bundledCopilot(vscodeExecutablePath));
  return {
    vscodeExecutablePath,
    extensionDevelopmentPath: copilot
      ? [resolve("."), copilot]
      : resolve("."),
  };
}
