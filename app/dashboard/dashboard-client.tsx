"use client";

import Form from "next/form";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ContactFilter,
  DashboardData,
  DashboardMode,
  DashboardQuery,
  MatchFilters,
  RangeFilter,
  SourceFilter,
  StatusFilter,
} from "@/lib/match";
import {
  buildDashboardBatchHref,
  buildDashboardHref,
  DEFAULT_FILTERS,
} from "@/lib/dashboardQuery";
import { Card } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { ArtistLink } from "@/components/artist-modal";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { SendButton } from "@/components/send-button";
import { FollowUpButton } from "@/components/follow-up-button";
import { cn } from "@/lib/cn";
import {
  pickDirectOutreachContact,
  pickEmailContact,
  pickPhoneContact,
} from "@/lib/contactSelection";
import {
  contactDisplayValue,
  hasDirectOutreachNote,
  isDirectOutreachOnly,
} from "@/lib/contactDisplay";
import { formatShowDate } from "@/lib/formatDate";
import { formatRankLabel } from "@/lib/listenSignal";
import type {
  FollowUpEligibility,
  OutreachSendability,
} from "@/lib/sendOutreach";
import { isCancellableOutreachStatus } from "@/lib/outreachStatus";
import { withWorkflowReturnTo } from "@/lib/workflowLinks";
import {
  mergeUniqueById,
  mergeUniqueByKey,
  shouldAutomaticallyLoadMore,
} from "@/lib/dashboardInfinite";
import {
  deserializeDashboardAppendPayload,
  type DashboardAppendJson,
} from "@/lib/dashboardTransport";
import {
  createDashboardRestoreState,
  dashboardRestoreIntentStorageKey,
  dashboardRestoreStorageKey,
  hasDashboardRestoreIntent,
  parseDashboardRestoreState,
  type DashboardRestoreState,
} from "@/lib/dashboardRestore";
import type { DashboardRecommendationBadge } from "@/lib/dashboardTrajectoryRecommendations";
import {
  buildRecommendationHref,
  DEFAULT_RECOMMENDATION_QUERY,
} from "@/lib/trajectoryRecommendationQuery";
import {
  sendNowAction,
  dismissShowAction,
  restoreShowAction,
  setInterestedAction,
  markSentAction,
  unmarkSentAction,
  cancelScheduledAction,
  sendFollowUpAction,
} from "./actions";

const DASHBOARD_RESTORE_HISTORY_KEY = "__photoAdminDashboardRestoreV1";

interface Props {
  data: DashboardData;
  query: DashboardQuery;
  persistenceScope: string;
  isWeekend: boolean;
  sendabilityRows: OutreachSendability[];
  followUpEligibilityRows: FollowUpEligibility[];
  recommendationBadges: DashboardRecommendationBadge[];
}

interface OutreachState {
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openCount: number;
  clickCount: number;
}

type FilterOption =
  | { key: "range"; value: RangeFilter; label: string }
  | { key: "source"; value: SourceFilter; label: string }
  | { key: "contact"; value: ContactFilter; label: string }
  | { key: "status"; value: StatusFilter; label: string };

function statusLabels(outreach: OutreachState): string[] {
  if (outreach.status === "failed") return ["Failed"];
  if (outreach.status === "manual_review") return ["Manual review"];
  if (outreach.status === "queued") return ["Queued"];
  if (outreach.status === "scheduled") return ["Scheduled"];
  if (outreach.status === "retry_scheduled") return ["Retry scheduled"];
  if (outreach.status === "cancelled") return ["Cancelled"];
  const labels: string[] = [];
  if (outreach.status === "test") labels.push("Test sent");
  else if (outreach.sentAt) labels.push("Sent");
  if (outreach.deliveredAt) labels.push("Delivered");
  if (outreach.openCount > 0) {
    labels.push(
      outreach.openCount > 1 ? `Opened (${outreach.openCount})` : "Opened"
    );
  }
  if (outreach.clickCount > 0) {
    labels.push(
      outreach.clickCount > 1 ? `Clicked (${outreach.clickCount})` : "Clicked"
    );
  }
  return labels.length > 0 ? labels : [outreach.status];
}

function statusTone(outreach: OutreachState): BadgeTone {
  if (outreach.status === "failed") return "danger";
  if (outreach.status === "manual_review") return "warning";
  if (outreach.status === "cancelled") return "default";
  if (
    outreach.status === "scheduled" ||
    outreach.status === "retry_scheduled"
  ) {
    return "warning";
  }
  if (outreach.clickCount > 0 || outreach.openCount > 0) return "info";
  if (outreach.deliveredAt) return "success";
  if (outreach.status === "test") return "warning";
  return "default";
}

function queryWith(
  query: DashboardQuery,
  changes: {
    mode?: DashboardMode;
    filters?: Partial<MatchFilters>;
  }
): DashboardQuery {
  return {
    mode: changes.mode ?? query.mode,
    filters: { ...query.filters, ...changes.filters },
  };
}

export function DashboardClient({
  data,
  query,
  persistenceScope,
  isWeekend,
  sendabilityRows: initialSendabilityRows,
  followUpEligibilityRows: initialFollowUpEligibilityRows,
  recommendationBadges: initialRecommendationBadges,
}: Props) {
  const { modeCounts } = data;
  const [shows, setShows] = useState(data.shows);
  const [nextCursor, setNextCursor] = useState(data.nextCursor);
  const [sendabilityRows, setSendabilityRows] = useState(
    initialSendabilityRows
  );
  const [followUpEligibilityRows, setFollowUpEligibilityRows] = useState(
    initialFollowUpEligibilityRows
  );
  const [recommendationBadges, setRecommendationBadges] = useState(
    initialRecommendationBadges
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [automaticLoading, setAutomaticLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restorationChecked, setRestorationChecked] = useState(false);
  const [restoreRequest, setRestoreRequest] =
    useState<DashboardRestoreState | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [snapshotExpired, setSnapshotExpired] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const showsRef = useRef(shows);
  const nextCursorRef = useRef(data.nextCursor);
  const batchCountRef = useRef(1);
  const restoringRef = useRef(false);
  const restorationCheckedRef = useRef(false);
  const resettingSnapshotRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filters = query.filters;
  const returnTo = buildDashboardHref(query);
  const recommendationBadgeByTarget = useMemo(
    () =>
      new Map(
        recommendationBadges.map((badge) => [
          `${badge.showId}\u0000${badge.artistId}`,
          badge,
        ]),
      ),
    [recommendationBadges],
  );
  const storageKey = useMemo(
    () => dashboardRestoreStorageKey(persistenceScope, returnTo),
    [persistenceScope, returnTo]
  );
  const restoreIntentKey = useMemo(
    () => dashboardRestoreIntentStorageKey(persistenceScope),
    [persistenceScope]
  );
  const sendabilityByTarget = useMemo(
    () =>
      new Map(
        sendabilityRows.map((row) => [
          `${row.showId}\u0000${row.contactId}`,
          row,
        ])
      ),
    [sendabilityRows]
  );
  const followUpByParent = useMemo(
    () =>
      new Map(
        followUpEligibilityRows.map((row) => [row.parentOutreachId, row])
      ),
    [followUpEligibilityRows]
  );
  const tabs: { key: DashboardMode; label: string; tone?: "amber" }[] = [
    { key: "matched", label: "Matched" },
    { key: "unknown", label: "Unknown but big" },
    { key: "interested", label: "★ Interested", tone: "amber" },
    { key: "dismissed", label: "Dismissed" },
  ];
  const filterGroups: { label: string; options: FilterOption[] }[] = [
    {
      label: "Range",
      options: [
        { key: "range", value: "7d", label: "7d" },
        { key: "range", value: "30d", label: "30d" },
        { key: "range", value: "30-60d", label: "30–60d" },
        { key: "range", value: "90d", label: "90d" },
      ],
    },
    {
      label: "Source",
      options: [
        { key: "source", value: "any", label: "Any" },
        { key: "source", value: "statsfm", label: "Stats.fm" },
        { key: "source", value: "spotify", label: "Spotify" },
      ],
    },
    {
      label: "Contact",
      options: [
        { key: "contact", value: "any", label: "Any" },
        { key: "contact", value: "has", label: "Has contact" },
        { key: "contact", value: "needs", label: "Needs contact" },
      ],
    },
    {
      label: "Status",
      options: [
        { key: "status", value: "any", label: "Any" },
        { key: "status", value: "unsent", label: "Unsent" },
        { key: "status", value: "sent", label: "Sent / scheduled" },
        { key: "status", value: "opened", label: "Opened" },
        { key: "status", value: "clicked", label: "Clicked" },
      ],
    },
  ];
  const filtersDirty =
    filters.search ||
    filters.range !== DEFAULT_FILTERS.range ||
    filters.source !== DEFAULT_FILTERS.source ||
    filters.contact !== DEFAULT_FILTERS.contact ||
    filters.status !== DEFAULT_FILTERS.status;

  useEffect(() => {
    restoringRef.current = restoring;
  }, [restoring]);

  useEffect(() => {
    restorationCheckedRef.current = restorationChecked;
  }, [restorationChecked]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (
      navigator as Navigator & {
        connection?: {
          saveData?: boolean;
          addEventListener?: (type: "change", listener: () => void) => void;
          removeEventListener?: (type: "change", listener: () => void) => void;
        };
      }
    ).connection;
    const update = () =>
      setAutomaticLoading(
        shouldAutomaticallyLoadMore({
          intersectionObserver: "IntersectionObserver" in window,
          reducedMotion: media.matches,
          saveData: connection?.saveData === true,
        })
      );
    update();
    media.addEventListener("change", update);
    connection?.addEventListener?.("change", update);
    return () => {
      media.removeEventListener("change", update);
      connection?.removeEventListener?.("change", update);
    };
  }, []);

  const readRestoreState = useCallback((): DashboardRestoreState | null => {
    try {
      const historyState =
        window.history.state && typeof window.history.state === "object"
          ? (window.history.state as Record<string, unknown>)
          : {};
      const sessionIntent = sessionStorage.getItem(restoreIntentKey);
      if (
        !hasDashboardRestoreIntent(
          storageKey,
          historyState[DASHBOARD_RESTORE_HISTORY_KEY],
          sessionIntent
        )
      ) {
        return null;
      }
      if (sessionIntent === storageKey) {
        sessionStorage.removeItem(restoreIntentKey);
      }
      const raw = sessionStorage.getItem(storageKey);
      const saved = parseDashboardRestoreState(raw);
      if (raw && !saved) sessionStorage.removeItem(storageKey);
      return saved;
    } catch {
      return null;
    }
  }, [restoreIntentKey, storageKey]);

  const persistRestoreState = useCallback(() => {
    if (
      !restorationCheckedRef.current ||
      restoringRef.current ||
      resettingSnapshotRef.current
    ) {
      return;
    }
    const showElements = document.querySelectorAll<HTMLElement>(
      "[data-dashboard-show-id]"
    );
    let anchor: HTMLElement | null = null;
    for (const element of showElements) {
      if (element.getBoundingClientRect().bottom > 0) {
        anchor = element;
        break;
      }
    }
    const anchorId = anchor?.dataset.dashboardShowId ?? null;
    const anchorOffset = anchor?.getBoundingClientRect().top ?? 0;
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify(
          createDashboardRestoreState({
            batches: batchCountRef.current,
            snapshotId: data.snapshotId,
            nextCursor: nextCursorRef.current,
            anchorId,
            anchorOffset,
            scrollY: window.scrollY,
          })
        )
      );
    } catch {
      // Storage can be unavailable in private or constrained browser contexts.
    }
  }, [data.snapshotId, storageKey]);

  const markRestoreIntent = useCallback(() => {
    persistRestoreState();
    try {
      sessionStorage.setItem(restoreIntentKey, storageKey);
      const currentState =
        window.history.state && typeof window.history.state === "object"
          ? (window.history.state as Record<string, unknown>)
          : {};
      window.history.replaceState(
        {
          ...currentState,
          [DASHBOARD_RESTORE_HISTORY_KEY]: storageKey,
        },
        ""
      );
    } catch {
      // History/session storage can be unavailable in constrained browsers.
    }
  }, [persistRestoreState, restoreIntentKey, storageKey]);

  const clearRestoreIntent = useCallback(() => {
    try {
      sessionStorage.removeItem(restoreIntentKey);
    } catch {}
  }, [restoreIntentKey]);

  const handleClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const link = (event.target as Element).closest<HTMLAnchorElement>(
        "a[href]"
      );
      if (!link) return;
      const destination = new URL(link.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (destination.pathname === "/dashboard") {
        clearRestoreIntent();
      } else {
        markRestoreIntent();
      }
    },
    [clearRestoreIntent, markRestoreIntent]
  );

  const handleSubmitCapture = useCallback(
    (event: React.FormEvent<HTMLDivElement>) => {
      const form = event.target as HTMLFormElement;
      if (form.dataset.dashboardFilterForm === "true") {
        clearRestoreIntent();
      } else {
        markRestoreIntent();
      }
    },
    [clearRestoreIntent, markRestoreIntent]
  );

  const restoreScrollPosition = useCallback(
    (saved: DashboardRestoreState) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const anchor = Array.from(
            document.querySelectorAll<HTMLElement>(
              "[data-dashboard-show-id]"
            )
          ).find(
            (element) => element.dataset.dashboardShowId === saved.anchorId
          );
          if (anchor) {
            const top =
              window.scrollY +
              anchor.getBoundingClientRect().top -
              saved.anchorOffset;
            window.scrollTo(0, Math.max(0, top));
          } else {
            window.scrollTo(0, saved.scrollY);
          }
        });
      });
    },
    []
  );

  useLayoutEffect(() => {
    let cancelled = false;
    resettingSnapshotRef.current = true;
    abortRef.current?.abort();
    loadingRef.current = false;
    showsRef.current = data.shows;
    nextCursorRef.current = data.nextCursor;
    batchCountRef.current = 1;
    queueMicrotask(() => {
      if (cancelled) return;
      setShows(data.shows);
      setNextCursor(data.nextCursor);
      setSendabilityRows(initialSendabilityRows);
      setFollowUpEligibilityRows(initialFollowUpEligibilityRows);
      setRecommendationBadges(initialRecommendationBadges);
      setLoading(false);
      setError(null);
      setAnnouncement("");
      setSnapshotExpired(false);
      const saved = readRestoreState();
      setRestoreRequest(saved && saved.batches > 1 ? saved : null);
      setRestorationChecked(true);
      resettingSnapshotRef.current = false;
    });
    return () => {
      cancelled = true;
    };
  }, [
    data.nextCursor,
    data.shows,
    data.snapshotId,
    initialFollowUpEligibilityRows,
    initialRecommendationBadges,
    initialSendabilityRows,
    readRestoreState,
  ]);

  useEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  useEffect(() => {
    const saveSoon = () => {
      if (scrollSaveTimerRef.current) {
        clearTimeout(scrollSaveTimerRef.current);
      }
      scrollSaveTimerRef.current = setTimeout(persistRestoreState, 150);
    };
    const saveNow = () => persistRestoreState();
    window.addEventListener("scroll", saveSoon, { passive: true });
    window.addEventListener("pagehide", saveNow);
    document.addEventListener("visibilitychange", saveNow);
    return () => {
      window.removeEventListener("scroll", saveSoon);
      window.removeEventListener("pagehide", saveNow);
      document.removeEventListener("visibilitychange", saveNow);
      if (scrollSaveTimerRef.current) {
        clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      saveNow();
      abortRef.current?.abort();
    };
  }, [persistRestoreState]);

  const requestBatch = useCallback(
    async (cursor: string, signal: AbortSignal) => {
      const response = await fetch(buildDashboardBatchHref(query, cursor), {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      if (!response.ok) {
        if (response.status === 410) {
          const expired = new Error("This result snapshot expired.");
          expired.name = "DashboardSnapshotExpired";
          throw expired;
        }
        throw new Error(
          response.status === 401
            ? "Your session expired. Sign in again, then retry."
            : "Couldn’t load more shows."
        );
      }
      return deserializeDashboardAppendPayload(
        (await response.json()) as DashboardAppendJson
      );
    },
    [query]
  );

  const appendBatch = useCallback(
    (
      payload: ReturnType<typeof deserializeDashboardAppendPayload>,
      announce: boolean
    ) => {
      const merged = mergeUniqueById(showsRef.current, payload.shows);
      showsRef.current = merged.items;
      nextCursorRef.current = payload.nextCursor;
      batchCountRef.current += 1;
      setShows(merged.items);
      setNextCursor(payload.nextCursor);
      setSendabilityRows((current) =>
        mergeUniqueByKey(
          current,
          payload.sendabilityRows,
          (row) => `${row.showId}\u0000${row.contactId}`
        ).items
      );
      setFollowUpEligibilityRows((current) =>
        mergeUniqueByKey(
          current,
          payload.followUpEligibilityRows,
          (row) => row.parentOutreachId
        ).items
      );
      setRecommendationBadges((current) =>
        mergeUniqueByKey(
          current,
          payload.recommendationBadges,
          (row) => `${row.showId}\u0000${row.artistId}`,
        ).items
      );
      if (announce) {
        setAnnouncement(
          merged.added > 0
            ? `${merged.added} more show${merged.added === 1 ? "" : "s"} loaded.`
            : payload.nextCursor
              ? "No duplicate shows added. More results are available."
              : "No more shows."
        );
      }
      return payload.nextCursor;
    },
    []
  );

  useEffect(() => {
    if (
      !restoreRequest ||
      !restorationChecked ||
      resettingSnapshotRef.current ||
      loadingRef.current
    ) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    loadingRef.current = true;
    setLoading(true);
    setRestoring(true);
    setError(null);

    void (async () => {
      try {
        let cursor = nextCursorRef.current;
        while (
          batchCountRef.current < restoreRequest.batches &&
          cursor &&
          !controller.signal.aborted
        ) {
          cursor = appendBatch(
            await requestBatch(cursor, controller.signal),
            false
          );
        }
        if (!controller.signal.aborted) {
          setRestoreRequest(null);
          setAnnouncement("Previous show list position restored.");
          restoreScrollPosition(restoreRequest);
        }
      } catch (loadError) {
        if ((loadError as Error).name !== "AbortError") {
          const expired =
            (loadError as Error).name === "DashboardSnapshotExpired";
          if (expired) {
            setSnapshotExpired(true);
            try {
              sessionStorage.removeItem(storageKey);
            } catch {}
          }
          setError(
            expired
              ? "This result snapshot expired. Refresh to continue."
              : loadError instanceof Error
                ? loadError.message
                : "Couldn’t restore the previous show position."
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          loadingRef.current = false;
          setLoading(false);
          setRestoring(false);
        }
      }
    })();
    return () => controller.abort();
  }, [
    appendBatch,
    requestBatch,
    restorationChecked,
    restoreAttempt,
    restoreRequest,
    restoreScrollPosition,
    storageKey,
  ]);

  const loadMore = useCallback(async () => {
    const cursor = nextCursorRef.current;
    if (
      !cursor ||
      loadingRef.current ||
      restoreRequest ||
      resettingSnapshotRef.current
    ) {
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      appendBatch(await requestBatch(cursor, controller.signal), true);
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") {
        const expired =
          (loadError as Error).name === "DashboardSnapshotExpired";
        if (expired) {
          setSnapshotExpired(true);
          try {
            sessionStorage.removeItem(storageKey);
          } catch {}
        }
        setError(
          expired
            ? "This result snapshot expired. Refresh to continue."
            : loadError instanceof Error
              ? loadError.message
              : "Couldn’t load more shows."
        );
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [appendBatch, requestBatch, restoreRequest, storageKey]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (
      !sentinel ||
      !automaticLoading ||
      !restorationChecked ||
      resettingSnapshotRef.current ||
      restoreRequest ||
      restoring ||
      !nextCursor ||
      loading ||
      error
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    automaticLoading,
    error,
    loadMore,
    loading,
    nextCursor,
    restorationChecked,
    restoreRequest,
    restoring,
  ]);

  return (
    <div
      onClickCapture={handleClickCapture}
      onSubmitCapture={handleSubmitCapture}
    >
      <div className="mt-1 text-sm text-zinc-500">
        {data.totalUpcoming} total upcoming ·{" "}
        {data.totalSignals.toLocaleString()} listen signals
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {tabs.map((tab) => {
          const active = query.mode === tab.key;
          return (
            <Link
              key={tab.key}
              prefetch={false}
              href={buildDashboardHref(
                queryWith(query, { mode: tab.key })
              )}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
                active
                  ? tab.tone === "amber"
                    ? "border-amber-500 text-amber-700 dark:text-amber-400"
                    : "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              )}
            >
              {tab.label}
              <span className="ml-1.5 text-xs text-zinc-400">
                {modeCounts[tab.key]}
              </span>
            </Link>
          );
        })}
      </div>

      <Card className="mt-6 p-4">
        <Form
          action="/dashboard"
          scroll={false}
          data-dashboard-filter-form="true"
          className="flex gap-2"
        >
          {query.mode !== "matched" && (
            <input type="hidden" name="mode" value={query.mode} />
          )}
          {filters.range !== DEFAULT_FILTERS.range && (
            <input type="hidden" name="range" value={filters.range} />
          )}
          {filters.source !== DEFAULT_FILTERS.source && (
            <input type="hidden" name="src" value={filters.source} />
          )}
          {filters.contact !== DEFAULT_FILTERS.contact && (
            <input type="hidden" name="contact" value={filters.contact} />
          )}
          {filters.status !== DEFAULT_FILTERS.status && (
            <input type="hidden" name="status" value={filters.status} />
          )}
          <input
            key={filters.search}
            type="search"
            name="search"
            defaultValue={filters.search}
            placeholder="Search artist name…"
            className="h-9 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
          <PendingSubmitButton pendingLabel="Searching…">Search</PendingSubmitButton>
          {filtersDirty && (
            <LinkButton
              href={buildDashboardHref({
                mode: query.mode,
                filters: DEFAULT_FILTERS,
              })}
              variant="ghost"
            >
              Clear
            </LinkButton>
          )}
        </Form>
        <div className="mt-3 space-y-2">
          {filterGroups.map((group) => (
            <div key={group.label} className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {group.label}
              </span>
              {group.options.map((option) => {
                const active = filters[option.key] === option.value;
                const disabled =
                  query.mode === "unknown" &&
                  option.key === "source" &&
                  option.value !== "any";
                if (disabled) {
                  return (
                    <span
                      key={option.value}
                      aria-disabled="true"
                      title="Unknown artists have no active source signal"
                      className="cursor-not-allowed rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs font-medium text-zinc-300 dark:border-zinc-800 dark:text-zinc-700"
                    >
                      {option.label}
                    </span>
                  );
                }
                return (
                  <Link
                    key={option.value}
                    prefetch={false}
                    href={buildDashboardHref(
                      queryWith(query, {
                        filters: { [option.key]: option.value },
                      })
                    )}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium transition",
                      active
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "border border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
                    )}
                  >
                    {option.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>
          {data.resultCount === 0
            ? "0 shows"
            : `${shows.length} of ${data.resultCount} shows`}
        </span>
      </div>

      {shows.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No shows match this view. Try widening the range or clearing the search.
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {shows.map((show) => (
            <Card
              key={show.id}
              data-dashboard-show-id={show.id}
              className="p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm text-zinc-500">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {formatShowDate(show.date)}
                  </span>
                  {" · "}
                  {show.venueName}
                  {show.state ? `, ${show.state}` : ""}
                  {show.ticketUrl && (
                    <>
                      {" · "}
                      <a
                        href={show.ticketUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-700 hover:underline dark:text-zinc-300"
                      >
                        EDMTrain ↗
                      </a>
                    </>
                  )}
                  {show.interestedAt && (
                    <>
                      {" · "}
                      <span className="text-amber-600 dark:text-amber-400">
                        ★ Interested
                      </span>
                    </>
                  )}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  <form action={setInterestedAction}>
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <input type="hidden" name="showId" value={show.id} />
                    <input
                      type="hidden"
                      name="interested"
                      value={show.interestedAt ? "false" : "true"}
                    />
                    <PendingSubmitButton
                      variant="secondary"
                      size="sm"
                      pendingLabel="…"
                      aria-label={
                        show.interestedAt
                          ? "Unmark interested"
                          : "Mark interested"
                      }
                      title={
                        show.interestedAt
                          ? "Unmark interested"
                          : "Mark interested"
                      }
                      className={cn(
                        "h-8 w-8 px-0 text-base",
                        show.interestedAt
                          ? "border-amber-300 bg-amber-50 text-amber-600 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400 dark:hover:bg-amber-950"
                          : "border-zinc-200 text-zinc-500 hover:border-amber-300 hover:text-amber-500 dark:border-zinc-800 dark:text-zinc-500 dark:hover:border-amber-800 dark:hover:text-amber-400"
                      )}
                    >
                      {show.interestedAt ? "★" : "☆"}
                    </PendingSubmitButton>
                  </form>
                  <form
                    action={
                      show.dismissedAt ? restoreShowAction : dismissShowAction
                    }
                  >
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <input type="hidden" name="showId" value={show.id} />
                    <button
                      type="submit"
                      title={show.dismissedAt ? "Restore" : "Dismiss"}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-base text-zinc-500 transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                    >
                      {show.dismissedAt ? "↺" : "×"}
                    </button>
                  </form>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {show.matchedArtists.map((artist) => {
                  const emailContact = pickEmailContact(artist.contacts);
                  const phoneContact = pickPhoneContact(
                    artist.contacts,
                    emailContact
                  );
                  const directOutreachContact =
                    pickDirectOutreachContact(artist.contacts);
                  const contact =
                    emailContact ??
                    phoneContact ??
                    directOutreachContact ??
                    artist.contacts[0] ??
                    null;
                  const artistOutreaches = show.outreach.filter(
                    (outreach) =>
                      outreach.artistId === artist.id &&
                      outreach.kind === "original"
                  );
                  const manualMarker = artistOutreaches.find(
                    (outreach) =>
                      outreach.status === "sent" &&
                      outreach.isManualMarker
                  );
                  const sendability = emailContact
                    ? sendabilityByTarget.get(
                        `${show.id}\u0000${emailContact.id}`
                      )
                    : undefined;
                  const artistOutreach =
                    artistOutreaches.find(
                      (outreach) => outreach.status === "scheduled"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "retry_scheduled"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "sent"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "queued"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "manual_review"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "failed"
                    ) ??
                    artistOutreaches.find(
                      (outreach) => outreach.status === "test"
                    );
                  const outreach =
                    artistOutreach ??
                    (contact
                      ? show.outreach.find(
                          (row) =>
                            row.kind === "original" &&
                            row.contactId === contact.id
                        )
                      : undefined);
                  const followUpEligibility =
                    artistOutreaches
                      .map((row) => followUpByParent.get(row.id))
                      .find(
                        (row) =>
                          row &&
                          (row.state === "eligible" ||
                            row.state === "pending" ||
                            row.state === "sent"),
                      ) ??
                    artistOutreaches
                      .filter((row) => row.status === "sent")
                      .map((row) => followUpByParent.get(row.id))
                      .find((row) => row !== undefined);
                  const alreadySent =
                    sendability?.blockingStatus === "sent" ||
                    artistOutreach?.status === "sent";
                  const isScheduled =
                    isCancellableOutreachStatus(
                      sendability?.blockingStatus
                    ) ||
                    isCancellableOutreachStatus(artistOutreach?.status);
                  const emailDisabledLabel =
                    emailContact &&
                    !isScheduled &&
                    (!sendability || !sendability.sendable)
                      ? sendability?.blockingStatus === "queued"
                        ? "In progress"
                        : sendability?.blockingStatus === "retry_scheduled"
                          ? "Retry scheduled"
                          : sendability?.blockingStatus === "manual_review"
                            ? "Review"
                            : "Unavailable"
                      : undefined;
                  const scheduledOutreach =
                    artistOutreaches.find(
                      (row) =>
                        row.id === sendability?.blockingOutreachId
                    ) ??
                    (isCancellableOutreachStatus(artistOutreach?.status)
                      ? artistOutreach
                      : undefined);
                  const scheduledOutreachId =
                    sendability?.blockingOutreachId ?? scheduledOutreach?.id;
                  const scheduledStatus =
                    sendability?.blockingStatus ?? scheduledOutreach?.status;
                  const scheduledAt =
                    sendability?.blockingNextAttemptAt ??
                    scheduledOutreach?.nextAttemptAt ??
                    scheduledOutreach?.scheduledFor;
                  const scheduledInfo =
                    isScheduled && scheduledOutreachId
                      ? {
                          outreachId: scheduledOutreachId,
                          scheduledLabel: scheduledAt
                            ? `${
                                scheduledStatus === "retry_scheduled"
                                  ? "Retry"
                                  : "Scheduled"
                              } · ${scheduledAt.toLocaleString(
                                "en-US",
                                {
                                  timeZone: "America/New_York",
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                  hour12: true,
                                }
                              )}`
                            : scheduledStatus === "retry_scheduled"
                              ? "Retry scheduled"
                              : "Scheduled",
                        }
                      : null;
                  const recommendationBadge =
                    recommendationBadgeByTarget.get(
                      `${show.id}\u0000${artist.id}`,
                    );
                  const recommendationHref = recommendationBadge
                    ? `${buildRecommendationHref(
                        {
                          ...DEFAULT_RECOMMENDATION_QUERY,
                          tab: recommendationBadge.isSuggested
                            ? "suggested"
                            : recommendationBadge.arm === "momentum"
                              ? "momentum"
                              : recommendationBadge.arm,
                        },
                        "/recommendations",
                        returnTo,
                      )}#recommendation-${recommendationBadge.recommendationId}`
                    : null;

                  return (
                    <div
                      key={artist.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 bg-zinc-50/50 px-3 py-2 dark:border-zinc-900 dark:bg-zinc-900/40"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <ArtistLink
                          artistId={artist.id}
                          returnTo={returnTo}
                          className="text-sm font-medium"
                        >
                          {artist.name}
                        </ArtistLink>
                        {artist.topSignal && (
                          <Badge tone="success">
                            {formatRankLabel(
                              artist.topSignal.source,
                              artist.topSignal.rank
                            )}
                          </Badge>
                        )}
                        {recommendationHref && (
                          <Link
                            href={recommendationHref}
                            className="inline-flex items-center rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200 transition hover:bg-violet-100 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900 dark:hover:bg-violet-950"
                          >
                            Model recommendation
                          </Link>
                        )}
                        {!artist.topSignal && artist.popularity != null && (
                          <Badge
                            tone="info"
                            title="Spotify popularity (0-100)"
                          >
                            Popularity {artist.popularity}
                          </Badge>
                        )}
                        {artist.playlists.map((playlist) => (
                          <a
                            key={playlist.spotifyId}
                            href={`spotify:playlist:${playlist.spotifyId}`}
                            title={`Open "${playlist.name}" in Spotify`}
                            className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 transition hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900 dark:hover:bg-emerald-950"
                          >
                            ♪ {playlist.name}
                          </a>
                        ))}
                        {artist.playlistCount > artist.playlists.length && (
                          <span className="text-[10px] text-zinc-500">
                            +{artist.playlistCount - artist.playlists.length} more
                          </span>
                        )}
                        {artist.genres.map((genre) => (
                          <Badge key={genre} tone="muted" size="xs">
                            {genre}
                          </Badge>
                        ))}
                        {contact && (
                          <>
                            <Link
                              href={
                                artist.contacts.length > 1
                                  ? withWorkflowReturnTo(
                                      `/artists/${artist.id}`,
                                      returnTo
                                    )
                                  : withWorkflowReturnTo(
                                      `/dashboard/contact/${contact.id}`,
                                      returnTo
                                    )
                              }
                              className="inline-flex max-w-64 items-center truncate rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                              title={artist.contacts
                                .map((row) =>
                                  `${row.name ?? ""} ${
                                    row.email ? `<${row.email}>` : contactDisplayValue(row, "")
                                  }`.trim()
                                )
                                .join("\n")}
                            >
                              {hasDirectOutreachNote(contact)
                                ? contact.directOutreachNote
                                : artist.contacts.length > 1
                                  ? `${artist.contacts.length} contacts`
                                  : "edit"}
                            </Link>
                            {hasDirectOutreachNote(contact) && (
                              <Badge tone="warning" size="xs">
                                Direct outreach
                              </Badge>
                            )}
                            {emailContact?.isFullTeam && (
                              <Badge
                                tone="accent"
                                title="Email goes to the artist's full management team"
                              >
                                Full team
                              </Badge>
                            )}
                          </>
                        )}
                        {!contact && (
                          <Link
                            href={withWorkflowReturnTo(
                              `/dashboard/add-contact/${artist.id}`,
                              returnTo
                            )}
                            className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 transition hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900 dark:hover:bg-amber-950"
                          >
                            + Add contact
                          </Link>
                        )}
                        {outreach && (
                          <Badge tone={statusTone(outreach)}>
                            Original · {statusLabels(outreach).join(" · ")}
                          </Badge>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {(emailContact || phoneContact) && (
                          <div className="flex gap-1.5">
                            <SendButton
                              showId={show.id}
                              contactId={emailContact?.id ?? null}
                              contactName={emailContact?.name ?? null}
                              phone={phoneContact?.phone ?? null}
                              phoneContactName={phoneContact?.name ?? null}
                              alreadySent={alreadySent}
                              emailDisabledLabel={emailDisabledLabel}
                              emailDisabledReason={
                                sendability?.reason ?? undefined
                              }
                              isRetry={sendability?.mode === "retry"}
                              isWeekend={isWeekend}
                              scheduledInfo={scheduledInfo}
                              returnTo={returnTo}
                              action={sendNowAction}
                              cancelAction={cancelScheduledAction}
                            />
                            {emailContact &&
                              sendability?.mode !== "retry" && (
                              <LinkButton
                                href={withWorkflowReturnTo(
                                  `/dashboard/customize/${show.id}/${emailContact.id}`,
                                  returnTo
                                )}
                                variant="secondary"
                                size="sm"
                              >
                                Customize
                              </LinkButton>
                            )}
                          </div>
                        )}
                        {contact &&
                          !emailContact &&
                          !phoneContact &&
                          !isDirectOutreachOnly(contact) && (
                          <span className="text-[10px] text-amber-700 dark:text-amber-400">
                            No email or phone
                          </span>
                        )}
                        {emailContact && followUpEligibility && (
                          <FollowUpButton
                            eligibility={followUpEligibility}
                            returnTo={returnTo}
                            isWeekend={isWeekend}
                            action={sendFollowUpAction}
                            cancelAction={cancelScheduledAction}
                          />
                        )}
                        {artist.canMarkManually && (
                          <form action={markSentAction}>
                            <input
                              type="hidden"
                              name="returnTo"
                              value={returnTo}
                            />
                            <input
                              type="hidden"
                              name="showId"
                              value={show.id}
                            />
                            {contact ? (
                              <input
                                type="hidden"
                                name="contactId"
                                value={contact.id}
                              />
                            ) : (
                              <input
                                type="hidden"
                                name="artistId"
                                value={artist.id}
                              />
                            )}
                            <PendingSubmitButton
                              variant="ghost"
                              size="sm"
                              pendingLabel="Marking…"
                              title="Record as sent without actually emailing (use if you reached out via DM, personal email, etc.)"
                              className="h-auto px-0 py-0 text-[10px] font-normal text-zinc-500 hover:bg-transparent hover:text-zinc-900 dark:hover:bg-transparent dark:hover:text-zinc-100"
                            >
                              Mark sent (manual)
                            </PendingSubmitButton>
                          </form>
                        )}
                        {manualMarker && (
                          <form action={unmarkSentAction}>
                            <input
                              type="hidden"
                              name="returnTo"
                              value={returnTo}
                            />
                            <input
                              type="hidden"
                              name="outreachId"
                              value={manualMarker.id}
                            />
                            <PendingSubmitButton
                              variant="ghost"
                              size="sm"
                              pendingLabel="Unmarking…"
                              title="Remove this manual outreach marker"
                              className="h-auto px-0 py-0 text-[10px] font-normal text-zinc-500 hover:bg-transparent hover:text-zinc-900 dark:hover:bg-transparent dark:hover:text-zinc-100"
                            >
                              Unmark
                            </PendingSubmitButton>
                          </form>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {show.otherArtists.length > 0 && (
                <p className="mt-3 truncate text-xs text-zinc-400">
                  +{" "}
                  {show.otherArtists.map((artist, index) => (
                    <span key={artist.id}>
                      {index > 0 && ", "}
                      <ArtistLink
                        artistId={artist.id}
                        returnTo={returnTo}
                        className="hover:text-zinc-600 dark:hover:text-zinc-300"
                      >
                        {artist.name}
                      </ArtistLink>
                    </span>
                  ))}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      <div
        ref={sentinelRef}
        className="mt-6 flex min-h-20 flex-col items-center justify-center gap-3 text-center"
      >
        {loading && (
          <div
            aria-busy="true"
            aria-label={
              restoring
                ? "Restoring previous show position"
                : "Loading more shows"
            }
            className="w-full space-y-2"
          >
            <div className="h-16 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
            <div className="h-16 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
          </div>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
        {nextCursor || restoreRequest || snapshotExpired ? (
          <button
            type="button"
            onClick={() => {
              if (snapshotExpired) {
                window.location.reload();
              } else if (restoreRequest) {
                setRestoreAttempt((attempt) => attempt + 1);
              } else {
                void loadMore();
              }
            }}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
          >
            {loading
              ? restoring
                ? "Restoring…"
                : "Loading…"
              : snapshotExpired
                ? "Refresh results"
                : restoreRequest && error
                  ? "Retry restoration"
                  : error
                    ? "Retry"
                    : "Load more"}
          </button>
        ) : (
          shows.length > 0 && (
            <p className="text-sm text-zinc-500">You’ve reached the end.</p>
          )
        )}
        {nextCursor && !restoreRequest && !loading && !error && (
          <p className="text-xs text-zinc-500">
            {automaticLoading
              ? "More shows load automatically as you scroll."
              : "Automatic loading is off; use the Load more button."}
          </p>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
