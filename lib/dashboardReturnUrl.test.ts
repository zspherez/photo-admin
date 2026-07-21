import assert from "node:assert/strict";
import test from "node:test";
import {
  appendWorkflowResult,
  artistWorkflowPath,
  dashboardResultHref,
  dashboardReturnPath,
  festivalReturnPath,
  parseFestivalFilter,
  parseFestivalGenre,
  workflowReturnPath,
  workflowFestivalShowId,
  withWorkflowReturnTo,
} from "./dashboardReturnUrl";

test("dashboard returns preserve only validated shareable state", () => {
  assert.equal(
    dashboardReturnPath(
      "/dashboard?mode=unknown&range=30-60d&src=spotify&contact=needs&status=clicked&search=Four%20Tet&page=3&sent=old"
    ),
    "/dashboard?mode=unknown&range=30-60d&contact=needs&status=clicked&search=Four+Tet"
  );
  assert.equal(
    dashboardResultHref(
      "/dashboard?mode=dismissed&search=Jamie%20xx&page=2",
      "marked"
    ),
    "/dashboard?mode=dismissed&search=Jamie+xx&marked=1"
  );
});

test("dashboard returns reject external and non-dashboard paths", () => {
  for (const value of [
    "https://example.com/dashboard",
    "//example.com/dashboard",
    "/shows",
    "/dashboard/../shows",
    "/%2f%2fexample.com/dashboard",
  ]) {
    assert.equal(dashboardReturnPath(value), "/dashboard");
  }
  assert.equal(
    dashboardResultHref("//example.com/dashboard", "error", "unsafe"),
    "/dashboard?error=unsafe"
  );
});

test("workflow returns allow exact workflow routes and preserve their filters", () => {
  assert.equal(
    workflowReturnPath(
      "/festivals/show_123?filter=unsent&genre=house&page=9&sent=old"
    ),
    "/festivals/show_123?filter=unsent&genre=house"
  );
  assert.equal(
    workflowReturnPath(
      "/festivals?includeInternational=1&dismissed=1&sent=old"
    ),
    "/festivals?includeInternational=1&dismissed=1"
  );
  assert.equal(
    festivalReturnPath("show_123", "matched_with_contact", "drum & bass"),
    "/festivals/show_123?filter=matched_with_contact&genre=drum+%26+bass"
  );
  assert.equal(
    appendWorkflowResult("/festivals/show_123?filter=unsent", {
      scheduled: "1",
    }),
    "/festivals/show_123?filter=unsent&scheduled=1"
  );
  assert.equal(
    withWorkflowReturnTo(
      "/dashboard/add-contact/artist_123",
      "/festivals/show_123?filter=needs_contact"
    ),
    "/dashboard/add-contact/artist_123?returnTo=%2Ffestivals%2Fshow_123%3Ffilter%3Dneeds_contact"
  );
  assert.equal(
    workflowReturnPath(
      "/outreach?status=manual_review&search=Four%20Tet&page=3&sent=old",
    ),
    "/outreach?status=manual_review&search=Four+Tet&page=3",
  );
  assert.equal(
    workflowReturnPath(
      "/contacts?search=Palm%20Artists&page=3&updated=old"
    ),
    "/contacts?search=Palm+Artists&page=3"
  );
  assert.equal(
    workflowReturnPath(
      "/artists/artist_123?returnTo=%2Foutreach%3Fstatus%3Dsent%26page%3D2&error=old",
    ),
    "/artists/artist_123?returnTo=%2Foutreach%3Fstatus%3Dsent%26page%3D2",
  );
  assert.equal(
    workflowReturnPath(
      "/dashboard/contact/contact_123?returnTo=%2Ffestivals%2Fshow_123%3Ffilter%3Dunsent&historyPage=4&deleted=old",
    ),
    "/dashboard/contact/contact_123?returnTo=%2Ffestivals%2Fshow_123%3Ffilter%3Dunsent&historyPage=4",
  );
});

test("festival search parameters normalize repeated values safely", () => {
  assert.equal(parseFestivalFilter(["unsent", "all"]), "unsent");
  assert.equal(parseFestivalGenre(["  Drum & Bass ", "house"]), "drum & bass");
  assert.equal(parseFestivalGenre(["\u0000invalid", "house"]), "all");
  assert.equal(
    festivalReturnPath(
      "show_123",
      parseFestivalFilter(["matched", "all"]),
      ["House", "techno"],
      { includeInternational: true, dismissed: true },
    ),
    "/festivals/show_123?filter=matched&genre=house&includeInternational=1&dismissed=1",
  );
  assert.equal(
    workflowReturnPath(
      "/festivals/show_123?filter=unsent&filter=all&genre=House&genre=techno&includeInternational=1",
    ),
    "/festivals/show_123?filter=unsent&genre=house&includeInternational=1",
  );
});

test("workflow returns reject nested, reserved, and external routes", () => {
  for (const value of [
    "https://example.com/festivals/show_123",
    "//example.com/festivals/show_123",
    "/festivals/new",
    "/festivals/show_123/edit",
    "/festivals/show_123/../other",
    "/festivals/show_123/%2e%2e/other",
    "/artists/artist_123/edit",
    "/dashboard/contact/contact_123/edit",
    "/festivals/%2f%2fevil",
  ]) {
    assert.equal(workflowReturnPath(value), "/dashboard", value);
  }
  assert.equal(
    workflowReturnPath(
      "/artists/artist_123?returnTo=%2Fartists%2Fother",
    ),
    "/artists/artist_123",
  );
});

test("artist workflow actions preserve safe festival returns and reject unsafe returns", () => {
  assert.equal(
    artistWorkflowPath(
      "artist_123",
      "/festivals/show_123?filter=needs_contact",
      { research_saved: "1" }
    ),
    "/artists/artist_123?returnTo=%2Ffestivals%2Fshow_123%3Ffilter%3Dneeds_contact&research_saved=1"
  );
  assert.equal(
    workflowFestivalShowId(
      "/festivals/show_123?filter=needs_contact"
    ),
    "show_123"
  );
  for (const unsafe of [
    "https://example.com/festivals/show_123",
    "//example.com/festivals/show_123",
    "/festivals/show_123/edit",
  ]) {
    assert.equal(workflowFestivalShowId(unsafe), null);
    assert.equal(
      artistWorkflowPath("artist_123", unsafe, { research_error: "unsafe" }),
      "/artists/artist_123?research_error=unsafe"
    );
  }
});
