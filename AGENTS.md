# hoosage

- Run `npm run check` and `npm run package` before shipping.
- Preserve per-workspace source isolation. Never attribute a call based on the active editor.
- Only chat spans count. Do not add agent totals, logs or cumulative metric values to them.
- Unknown usage is unknown, never a measured zero. Tokens are not billed credits or premium requests.
- Prefer reported per-request nano-AIU for USD value. Label fallback prices as estimates, preserve unknown costs, and never add cumulative session costs.
- Never persist or export prompts, response bodies, tool arguments, code or repository URLs.
- Keep the webview CSP strict and assets local. Maintain labelled demo and empty/error states.
- The public repository lives at github.com/openhoo/hoosage.

## Agent skills

- For work on the extension or JetBrains plugin, read
  [hoosage-development](skills/hoosage-development/SKILL.md).
- For installing, configuring, or diagnosing usage tracking, read
  [hoosage-usage](skills/hoosage-usage/SKILL.md).

Installable sources live in `skills/`; `.agents/skills` exposes the development
skill through a relative link. Keep skill guidance aligned with source and CI.
