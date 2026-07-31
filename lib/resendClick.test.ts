import assert from "node:assert/strict";
import test from "node:test";
import { resendClickMetadata } from "./resendClick";

test("click metadata keeps the web link and selected UTM values", () => {
  assert.deepEqual(
    resendClickMetadata("email.clicked", {
      link: "https://rehders.photos/?utm_campaign=experts-only&utm_content=yetti",
    }),
    {
      clickedLink:
        "https://rehders.photos/?utm_campaign=experts-only&utm_content=yetti",
      clickUtmCampaign: "experts-only",
      clickUtmContent: "yetti",
    },
  );
});

test("click metadata fails closed for non-click and unsafe links", () => {
  const empty = {
    clickedLink: null,
    clickUtmCampaign: null,
    clickUtmContent: null,
  };
  assert.deepEqual(
    resendClickMetadata("email.opened", {
      link: "https://rehders.photos/",
    }),
    empty,
  );
  assert.deepEqual(
    resendClickMetadata("email.clicked", { link: "javascript:alert(1)" }),
    empty,
  );
  assert.deepEqual(
    resendClickMetadata("email.clicked", { link: "https://example.com/\u0000" }),
    empty,
  );
  assert.deepEqual(
    resendClickMetadata("email.clicked", {
      link: `https://example.com/${"é".repeat(2000)}`,
    }),
    empty,
  );
  assert.deepEqual(
    resendClickMetadata("email.clicked", {
      link: "https://example.com/?utm_campaign=%00&utm_content=artist",
    }),
    {
      clickedLink:
        "https://example.com/?utm_campaign=%00&utm_content=artist",
      clickUtmCampaign: null,
      clickUtmContent: "artist",
    },
  );
});
