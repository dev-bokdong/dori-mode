import { expect, test } from "bun:test";

import { startupFailure } from "../src/launch.ts";

test("an omo Tip line about rate limits is not a startup failure", () => {
  const screen = "Tip: Hit a rate limit? Switch models with /model\nWant the full story on any tip? Ask me about it.\n❯ ";
  expect(startupFailure(screen)).toBeUndefined();
});

test("quota inside the echoed brief or launch prompt is not a startup failure", () => {
  const screen = [
    "ulw set goal and work. Read and execute the lane brief at /tmp/briefs/x.md in full. Check the quota first.",
    "Light lane. Handle the usage limit and rate limit wording in docs; quota is a word here.",
    "❯ ",
  ].join("\n");
  expect(startupFailure(screen)).toBeUndefined();
});

test("quota inside a recalled-memory or Kibitzer block is not a startup failure", () => {
  const screen = [
    '<recalled-memory source="[[notes]]">',
    "Kibitzer surfaced this stored note about the quota lane and the rate limit fix.",
    "</recalled-memory>",
    "Kibitzer: the quota note may apply",
    "still part of the note about quota",
    "",
    "❯ ",
  ].join("\n");
  expect(startupFailure(screen)).toBeUndefined();
});

test("real omo failure lines are still reported", () => {
  expect(startupFailure("starting\nAll fallback models failed\n$ ")).toBe("All fallback models failed");
  expect(startupFailure("Error: rate limit exceeded for model\n$ ")).toBe("rate limit");
  expect(startupFailure("  ✗ No API key found for provider\n")).toBe("No API key");
  expect(startupFailure("Tip: x\n\nUsage limit reached\n")).toBe("Usage limit reached");
});
