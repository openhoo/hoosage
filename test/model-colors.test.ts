import assert from "node:assert/strict";
import test from "node:test";
import { ModelColors, parseModelColors } from "../src/webview/model-colors";

test("model colors are independent of token ranking and source order", () => {
  const models = ["Sonnet", "GPT", "Opus", "Gemini"];
  const first = new ModelColors();
  const second = new ModelColors();
  first.register(models);
  second.register([...models].reverse());
  for (const model of models)
    assert.deepEqual(first.get(model, {}), second.get(model, {}));

  const before = first.get("Sonnet", {});
  first.register(["Sonnet"]); // A filtered project or date range.
  first.register(["A new model", ...models]);
  assert.deepEqual(first.get("Sonnet", {}), before);
});

test("large model inventories do not cycle back to identical colors", () => {
  const palette = new ModelColors();
  const models = Array.from({ length: 40 }, (_, i) => `Model ${i}`);
  palette.register(models);
  for (const theme of ["dark", "light"] as const)
    assert.equal(
      new Set(models.map((model) => palette.get(model, {})[theme])).size,
      models.length,
    );
});

test("the base palette stays visible against dark and light chart cards", () => {
  const luminance = (hex: string) => {
    const rgb = hex
      .slice(1)
      .match(/../g)!
      .map((part) => {
        const value = parseInt(part, 16) / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  };
  const palette = new ModelColors();
  const models = Array.from({ length: 12 }, (_, i) => `Model ${i}`);
  palette.register(models);
  for (const model of models) {
    const color = palette.get(model, {});
    assert.ok(
      (luminance(color.dark) + 0.05) / (luminance("#181b22") + 0.05) >= 3,
      `${model}: dark card contrast`,
    );
    assert.ok(
      1.05 / (luminance(color.light) + 0.05) >= 3,
      `${model}: light card contrast`,
    );
  }
});

test("overrides use exact model names in both themes and restore defaults when removed", () => {
  const palette = new ModelColors();
  palette.register(["GPT", "gpt"]);
  const automatic = palette.get("GPT", {});
  const override = parseModelColors({ GPT: "#09f" });
  assert.deepEqual(palette.get("GPT", override), {
    dark: "#09f",
    light: "#09f",
  });
  assert.notDeepEqual(
    palette.get("gpt", override),
    palette.get("GPT", override),
  );
  assert.deepEqual(palette.get("GPT", {}), automatic);
});

test("color settings reject CSS, markup, transparency and non-object values", () => {
  for (const value of [null, [], "#123456", 42])
    assert.deepEqual(parseModelColors(value), {});
  assert.deepEqual(
    parseModelColors({
      valid: "#AAbbCC",
      short: "#AbC",
      css: "red; background: url(/secret)",
      markup: '\"><img src=/missing>',
      alpha: "#12345600",
      invalid: "#12",
      number: 42,
    }),
    { valid: "#AAbbCC", short: "#AbC" },
  );
});

test("model names matching object properties remain safe and configurable", () => {
  const palette = new ModelColors();
  const overrides = parseModelColors(
    JSON.parse('{"__proto__":"#123456","constructor":"#abc"}'),
  );
  assert.deepEqual(palette.get("__proto__", overrides), {
    dark: "#123456",
    light: "#123456",
  });
  assert.deepEqual(palette.get("constructor", overrides), {
    dark: "#abc",
    light: "#abc",
  });
  assert.notEqual(palette.get("toString", {}).dark, undefined);
});
