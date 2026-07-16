import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "./route";

test("logout POST redirects with See Other", async () => {
  const response = await POST(new Request("https://example.test/api/auth/logout"));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://example.test/login");
  assert.match(
    response.headers.get("set-cookie") ?? "",
    /admin_session=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT/,
  );
});
