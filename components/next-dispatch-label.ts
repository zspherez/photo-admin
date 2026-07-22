"use client";

import { useEffect, useMemo, useState } from "react";
import {
  formatNextDispatchActionLabel,
  getNextNormalOutreachDispatch,
} from "@/lib/schedule";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface NextDispatchBoundaryData {
  renderedAtMs: number;
  dispatchAtMs: number;
}

export interface NextDispatchLabelState {
  dispatchAtMs: number;
  label: string;
}

export function nextDispatchLabelState(
  dispatchAtMs: number,
): NextDispatchLabelState {
  return {
    dispatchAtMs,
    label: formatNextDispatchActionLabel(new Date(dispatchAtMs)),
  };
}

export function startNextDispatchLabelClock(
  initialBoundary: NextDispatchBoundaryData,
  onChange: (state: NextDispatchLabelState) => void,
): () => void {
  let dispatchAtMs = initialBoundary.dispatchAtMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const arm = () => {
    if (cancelled) return;
    const delay = Math.max(0, dispatchAtMs - Date.now());
    timer = setTimeout(tick, Math.min(delay, MAX_TIMER_DELAY_MS));
  };

  const tick = () => {
    if (cancelled) return;
    const nowMs = Date.now();
    if (nowMs < dispatchAtMs) {
      arm();
      return;
    }
    const next = getNextNormalOutreachDispatch(new Date(nowMs));
    dispatchAtMs = next.getTime();
    onChange(nextDispatchLabelState(dispatchAtMs));
    arm();
  };

  arm();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

export function useNextDispatchActionLabel(
  boundary: NextDispatchBoundaryData,
): string {
  const { renderedAtMs, dispatchAtMs } = boundary;
  const initialState = useMemo(
    () => nextDispatchLabelState(dispatchAtMs),
    [dispatchAtMs],
  );
  const [liveState, setLiveState] = useState<
    NextDispatchLabelState & {
      sourceRenderedAtMs: number;
      sourceDispatchAtMs: number;
    }
  >(() => ({
    ...initialState,
    sourceRenderedAtMs: renderedAtMs,
    sourceDispatchAtMs: dispatchAtMs,
  }));
  const label =
    liveState.sourceRenderedAtMs === renderedAtMs &&
    liveState.sourceDispatchAtMs === dispatchAtMs
      ? liveState.label
      : initialState.label;
  useEffect(() => {
    return startNextDispatchLabelClock(
      { renderedAtMs, dispatchAtMs },
      (state) => {
        setLiveState({
          ...state,
          sourceRenderedAtMs: renderedAtMs,
          sourceDispatchAtMs: dispatchAtMs,
        });
      },
    );
  }, [dispatchAtMs, initialState, renderedAtMs]);

  return label;
}
