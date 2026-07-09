import assert from "node:assert/strict";
import test from "node:test";
import { colorize } from "./color.js";

test("colorize wraps text with ANSI codes when stream is TTY", () => {
  const stream = { isTTY: true };

  assert.equal(colorize("72", "cyan", stream), "\x1b[36m72\x1b[0m");
});

test("colorize returns plain text when stream is not TTY", () => {
  const stream = { isTTY: false };

  assert.equal(colorize("72", "cyan", stream), "72");
});

test("colorize returns plain text when stream has no TTY support", () => {
  const stream = {};

  assert.equal(colorize("72", "cyan", stream), "72");
});
