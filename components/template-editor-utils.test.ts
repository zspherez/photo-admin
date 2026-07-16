import assert from "node:assert/strict";
import test from "node:test";
import { insertTextAtSelection } from "./template-editor-utils";

test("HTML variable insertion uses the current cursor position", () => {
  assert.deepEqual(insertTextAtSelection("<p>Hello </p>", "{{artist}}", 9, 9), {
    value: "<p>Hello {{artist}}</p>",
    cursor: 19,
  });
});

test("HTML variable insertion replaces only the selected source", () => {
  assert.deepEqual(
    insertTextAtSelection("<p>Hello world</p>", "{{manager_name}}", 9, 14),
    {
      value: "<p>Hello {{manager_name}}</p>",
      cursor: 25,
    },
  );
});
