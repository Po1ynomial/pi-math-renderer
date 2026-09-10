import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ansi256ToHex,
  colorFromTheme,
  defaultFormulaColor,
  parseAnsiForeground,
} from "../src/theme.ts";

test("truecolour SGR decodes to a hex colour", () => {
  assert.equal(parseAnsiForeground("\x1b[38;2;229;229;231m"), "#e5e5e7");
  assert.equal(parseAnsiForeground("\x1b[38;2;0;0;0m"), "#000000");
  // Out-of-range channels clamp into the byte range.
  assert.equal(parseAnsiForeground("\x1b[38;2;300;0;12m"), "#ff000c");
  // A malformed sequence is ignored rather than guessed at.
  assert.equal(parseAnsiForeground("\x1b[38;2;300;-4;12m"), undefined);
  assert.equal(parseAnsiForeground("\x1b[0m"), undefined);
});

test("256-colour palette entries decode like xterm", () => {
  assert.equal(ansi256ToHex(0), "#000000");
  assert.equal(ansi256ToHex(15), "#ffffff");
  assert.equal(ansi256ToHex(16), "#000000");
  assert.equal(ansi256ToHex(196), "#ff0000");
  assert.equal(ansi256ToHex(231), "#ffffff");
  assert.equal(ansi256ToHex(232), "#080808");
  assert.equal(ansi256ToHex(255), "#eeeeee");
  assert.equal(parseAnsiForeground("\x1b[38;5;196m"), "#ff0000");
});

test("theme colours come from getFgAnsi, then fg", () => {
  assert.equal(colorFromTheme({ getFgAnsi: () => "\x1b[38;2;1;2;3m" }), "#010203");
  assert.equal(colorFromTheme({ fg: () => "\x1b[38;5;196m" }), "#ff0000");
  // getFgAnsi wins when both are present.
  assert.equal(
    colorFromTheme({ getFgAnsi: () => "\x1b[38;2;9;9;9m", fg: () => "\x1b[38;5;196m" }),
    "#090909",
  );
});

test("unusable themes fall back to a readable default", () => {
  assert.equal(colorFromTheme(undefined), defaultFormulaColor());
  assert.equal(colorFromTheme({}), defaultFormulaColor());
  assert.equal(colorFromTheme({ getFgAnsi: () => "" }), defaultFormulaColor());
  assert.equal(
    colorFromTheme({
      getFgAnsi: () => {
        throw new Error("theme not initialised");
      },
    }),
    defaultFormulaColor(),
  );
  assert.equal(defaultFormulaColor(), "#e5e5e7");
  assert.equal(defaultFormulaColor(true), "#000000");
});
