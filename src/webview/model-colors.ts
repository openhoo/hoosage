/** Separate chart colors from the interface accent; pairs work on dark/light cards. */
const PALETTE = [
  ["#56b4e9", "#0072b2"],
  ["#e69f00", "#a65f00"],
  ["#38c99a", "#007c56"],
  ["#ef6a62", "#c83c38"],
  ["#cc79a7", "#a84d83"],
  ["#f0e442", "#8a7800"],
  ["#38c9c9", "#007e86"],
  ["#a78bfa", "#7554c2"],
  ["#b3d65c", "#637c20"],
  ["#ff9faf", "#b64065"],
  ["#c49a6c", "#865b36"],
  ["#b8bec9", "#666e7c"],
] as const;

export function parseModelColors(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, color]) =>
        typeof color === "string" &&
        /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color),
    ),
  );
}

export class ModelColors {
  private readonly assignments = new Map<string, number>();

  /** Register the complete history, so project/date filters cannot recolor models. */
  register(models: Iterable<string>) {
    for (const model of [...new Set(models)].sort()) {
      if (!this.assignments.has(model))
        this.assignments.set(model, this.assignments.size);
    }
  }

  get(model: string, overrides: Record<string, string>) {
    if (Object.hasOwn(overrides, model))
      return { dark: overrides[model]!, light: overrides[model]! };
    this.register([model]);
    const index = this.assignments.get(model)!;
    const pair = PALETTE[index];
    if (pair) return { dark: pair[0], light: pair[1] };
    // Extend the palette without cycling back to an identical color.
    const hue = ((index - PALETTE.length) * 137.508 + 23) % 360;
    return {
      dark: `hsl(${hue.toFixed(3)} 65% 65%)`,
      light: `hsl(${hue.toFixed(3)} 65% 35%)`,
    };
  }
}
