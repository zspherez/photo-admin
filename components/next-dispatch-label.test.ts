import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  nextDispatchLabelState,
  startNextDispatchLabelClock,
  type NextDispatchBoundaryData,
  useNextDispatchActionLabel,
} from "./next-dispatch-label";
import { getNextNormalOutreachDispatch } from "@/lib/schedule";

function boundaryAt(renderedAt: Date): NextDispatchBoundaryData {
  return {
    renderedAtMs: renderedAt.getTime(),
    dispatchAtMs: getNextNormalOutreachDispatch(renderedAt).getTime(),
  };
}

function LabelProbe({
  boundary,
}: {
  boundary: NextDispatchBoundaryData;
}) {
  return createElement("span", null, useNextDispatchActionLabel(boundary));
}

test("live label changes exactly at the weekday dispatch cutoff", (t) => {
  const now = new Date("2026-07-22T12:59:59.000Z");
  const boundary = boundaryAt(now);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const changes: ReturnType<typeof nextDispatchLabelState>[] = [];
  const stop = startNextDispatchLabelClock(boundary, (state) => {
    changes.push(state);
  });

  assert.equal(nextDispatchLabelState(boundary.dispatchAtMs).label, "Queue for Wed 9:00 AM ET");
  t.mock.timers.tick(999);
  assert.deepEqual(changes, []);
  t.mock.timers.tick(1);
  assert.deepEqual(changes, [
    {
      dispatchAtMs: new Date("2026-07-23T13:00:00.000Z").getTime(),
      label: "Queue for Thu 9:00 AM ET",
    },
  ]);
  stop();
});

test("Friday and weekend boundaries advance to the next weekday", (t) => {
  const friday = new Date("2026-07-24T12:59:59.000Z");
  const fridayBoundary = boundaryAt(friday);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: friday });
  const fridayChanges: ReturnType<typeof nextDispatchLabelState>[] = [];
  const stopFriday = startNextDispatchLabelClock(
    fridayBoundary,
    (state) => {
      fridayChanges.push(state);
    },
  );

  t.mock.timers.tick(1_000);
  assert.deepEqual(fridayChanges, [
    {
      dispatchAtMs: new Date("2026-07-27T13:00:00.000Z").getTime(),
      label: "Queue for Mon 9:00 AM ET",
    },
  ]);
  stopFriday();
  t.mock.timers.reset();

  const saturday = new Date("2026-07-25T16:00:00.000Z");
  const weekendBoundary = boundaryAt(saturday);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: saturday });
  const weekendChanges: ReturnType<typeof nextDispatchLabelState>[] = [];
  const stopWeekend = startNextDispatchLabelClock(
    weekendBoundary,
    (state) => {
      weekendChanges.push(state);
    },
  );
  const untilMondayCutoff = weekendBoundary.dispatchAtMs - saturday.getTime();

  t.mock.timers.tick(untilMondayCutoff - 1);
  assert.deepEqual(weekendChanges, []);
  t.mock.timers.tick(1);
  assert.deepEqual(weekendChanges, [
    {
      dispatchAtMs: new Date("2026-07-28T13:00:00.000Z").getTime(),
      label: "Queue for Tue 9:00 AM ET",
    },
  ]);
  stopWeekend();
});

test("DST transitions keep the timer boundary on 9 AM America/New_York", (t) => {
  const springFriday = new Date("2026-03-06T13:59:59.000Z");
  const springBoundary = boundaryAt(springFriday);
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: springFriday,
  });
  const springChanges: ReturnType<typeof nextDispatchLabelState>[] = [];
  const stopSpring = startNextDispatchLabelClock(
    springBoundary,
    (state) => {
      springChanges.push(state);
    },
  );

  t.mock.timers.tick(1_000);
  assert.equal(
    springChanges[0]?.dispatchAtMs,
    new Date("2026-03-09T13:00:00.000Z").getTime(),
  );
  stopSpring();
  t.mock.timers.reset();

  const fallFriday = new Date("2026-10-30T12:59:59.000Z");
  const fallBoundary = boundaryAt(fallFriday);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: fallFriday });
  const fallChanges: ReturnType<typeof nextDispatchLabelState>[] = [];
  const stopFall = startNextDispatchLabelClock(fallBoundary, (state) => {
    fallChanges.push(state);
  });

  t.mock.timers.tick(1_000);
  assert.equal(
    fallChanges[0]?.dispatchAtMs,
    new Date("2026-11-02T14:00:00.000Z").getTime(),
  );
  stopFall();
});

test("hydration keeps the server label, then reconciles a stale boundary", (t) => {
  const renderedAt = new Date("2026-07-22T12:59:00.000Z");
  const boundary = boundaryAt(renderedAt);
  const hydratedAt = new Date("2026-07-22T13:01:00.000Z");
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: hydratedAt,
  });

  assert.equal(
    renderToStaticMarkup(createElement(LabelProbe, { boundary })),
    "<span>Queue for Wed 9:00 AM ET</span>",
  );

  const changes: ReturnType<typeof nextDispatchLabelState>[] = [];
  const stop = startNextDispatchLabelClock(boundary, (state) => {
    changes.push(state);
  });
  t.mock.timers.tick(0);
  assert.deepEqual(changes, [
    {
      dispatchAtMs: new Date("2026-07-23T13:00:00.000Z").getTime(),
      label: "Queue for Thu 9:00 AM ET",
    },
  ]);
  stop();
});
