import assert from "node:assert/strict";
import test from "node:test";
import { artistModalLoginPath } from "./artist-modal-utils";

test("artist modal login redirects preserve the current relative page", () => {
  assert.equal(
    artistModalLoginPath({
      pathname: "/dashboard",
      search: "?view=upcoming",
      hash: "#artist",
    }),
    "/login?next=%2Fdashboard%3Fview%3Dupcoming%23artist",
  );
});

test("artist modal login redirects reject open redirect paths", () => {
  for (const pathname of [
    "//example.com",
    "/%2f%2fexample.com",
    "/%252f%252fexample.com",
    "https://example.com",
  ]) {
    assert.equal(
      artistModalLoginPath({ pathname }),
      "/login?next=%2F",
    );
  }
});
