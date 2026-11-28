import { IntegrationCard } from "./IntegrationCard.jsx";
import { GmailAttachments, GmailLinks } from "./GmailAttachments.jsx";
import { MessageText } from "./MessageText.jsx";
import { TikTokIntegration } from "./TikTokIntegration.jsx";
import collabCat from "./assets/collab-cat.png";
import greetingCat from "./assets/greeting-cat.png";
import sharkCat from "./assets/shark-cat.svg";
import {
  InstagramIntegration,
  InstagramPanel,
  syncInstagramLinks,
} from "./Instagram.jsx";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArrowDownUp,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  Mail,
  Menu,
  Paperclip,
  Pencil,
  Plug2,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Video,
  X,
} from "lucide-react";
import {
  api,
  age,
  BOARD_GROUPS,
  CLOSED,
  datePart,
  dayDiff,
  deadlineValue,
  FOLLOW_UP_STATUS,
  formatDate,
  formatTime,
  inGroup,
  isLive,
  isOverdue,
  isSoon,
  isStale,
  LIVE_GROUPS,
  PLATFORMS,
  searchDeals,
  sortDeals,
  sourceOf,
  SOURCE_COLORS,
  SOURCES,
  STATUSES,
  toDateInput,
  toTimeInput,
  TYPE_COLORS,
  TYPES,
  today,
} from "./model.js";
import { EMAIL_TEMPLATES, hasTemplateFields } from "./emailTemplates.js";
import { getMediaKit, removeMediaKit, saveMediaKit } from "./mediaKit.js";

const InstagramOverview = lazy(() => import("./InstagramOverview.jsx"));

const savedView = (() => {
  try {
    return JSON.parse(localStorage.getItem("cp-view") || "{}");
  } catch {
    return {};
  }
})();
const initialView = {
  board: savedView.board === "live" ? "live" : "ugc",
  stage: "",
  sort: savedView.sort || "last",
  hideEmpty: !!savedView.hideEmpty,
  sidebar: savedView.sidebar !== false,
};
const statusColor = (status) =>
  STATUSES.find((group) => group.key === status)?.color || "gray";
const apiPath = (id) => `/deals/${encodeURIComponent(id)}`;

function Filter({ label, values, counts, selected, onChange }) {
  const dropdown = useRef(null);

  useEffect(() => {
    function closeOnOutsidePress(event) {
      const menu = dropdown.current;
      if (menu?.open && !menu.contains(event.target)) menu.open = false;
    }
    document.addEventListener("pointerdown", closeOnOutsidePress, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress, true);
  }, []);

  return (
    <details ref={dropdown} className="dropdown">
      <summary
        className={`btn btn-sm rounded-full ${selected.length ? "btn-primary" : "btn-ghost border border-base-300"}`}
      >
        <SlidersHorizontal size={14} />
        {selected.length ? `${label} · ${selected.length}` : label}
        <ChevronDown size={13} />
      </summary>
      <div className="dropdown-content z-20 mt-2 w-58 rounded-xl border border-base-300 bg-base-100 p-3 shadow-xl">
        {values.map((value) => (
          <label
            key={value}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-base-200"
          >
            <input
              type="checkbox"
              className="checkbox checkbox-primary checkbox-xs"
              checked={selected.includes(value)}
              onChange={() =>
                onChange(
                  selected.includes(value)
                    ? selected.filter((v) => v !== value)
                    : [...selected, value],
                )
              }
            />
            <span className="flex-1">{value}</span>
            {counts ? (
              <span
                className="text-xs tabular-nums text-base-content/55"
                aria-label={`${counts[value] || 0} deals`}
              >
                {counts[value] || 0}
              </span>
            ) : (
              <span className="skeleton h-3 w-4" aria-hidden="true" />
            )}
          </label>
        ))}
        <button
          type="button"
          className="btn btn-ghost btn-xs mt-2 w-full"
          onClick={() => onChange([])}
        >
          Clear
        </button>
      </div>
    </details>
  );
}

function DealSkeletons() {
  return (
    <div className="space-y-2" role="status" aria-label="Loading deals">
      {[0, 1].map((index) => (
        <div
          key={index}
          aria-hidden="true"
          className="space-y-2.5 rounded-xl border border-base-300 bg-base-100 p-3"
        >
          <div className="skeleton h-4 w-3/5" />
          <div className="flex gap-2">
            <div className="skeleton h-4 w-12 rounded-full" />
            <div className="skeleton h-4 w-16 rounded-full" />
          </div>
          <div className="skeleton h-3 w-full" />
          <div className="skeleton h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function SearchBox({ query, setQuery, results, onSelect, ready }) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedId, setHighlightedId] = useState(null);
  const [showAura, setShowAura] = useState(false);
  const inputRef = useRef(null);
  const expanded = Boolean(query.trim()) && showSuggestions;
  const highlightedIndex =
    expanded && ready
      ? results.findIndex((deal) => deal.id === highlightedId)
      : -1;
  const optionId = (index) => `search-deal-option-${index}`;

  useEffect(() => {
    let auraTimer;
    function focusSearch(event) {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "k"
      )
        return;
      event.preventDefault();
      onSelect(null);
      inputRef.current?.focus();
      setShowSuggestions(true);
      setShowAura(true);
      window.clearTimeout(auraTimer);
      auraTimer = window.setTimeout(() => setShowAura(false), 2200);
    }
    window.addEventListener("keydown", focusSearch);
    return () => {
      window.removeEventListener("keydown", focusSearch);
      window.clearTimeout(auraTimer);
    };
  }, [onSelect]);

  useEffect(() => {
    if (highlightedIndex >= 0)
      document
        .getElementById(optionId(highlightedIndex))
        ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, highlightedId]);

  function closeSuggestions() {
    setShowSuggestions(false);
    setHighlightedId(null);
  }

  function pickDeal(deal) {
    closeSuggestions();
    onSelect(deal.id);
  }

  function handleSearchKey(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      closeSuggestions();
      return;
    }
    if (!ready || !query.trim() || !results.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next =
        highlightedIndex < 0
          ? step === 1
            ? 0
            : results.length - 1
          : (highlightedIndex + step + results.length) % results.length;
      setShowSuggestions(true);
      setHighlightedId(results[next].id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pickDeal(results[highlightedIndex < 0 ? 0 : highlightedIndex]);
    }
  }

  return (
    <div
      className="relative w-full max-w-md"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          closeSuggestions();
          setShowAura(false);
        }
      }}
    >
      <div className={`block w-full p-0.5 ${showAura ? "aura aura-rainbow motion-reduce:animate-none" : ""}`}>
        <div className={`input input-bordered flex h-10 w-full items-center gap-2 bg-base-100 ${showAura ? "focus-within:-outline-offset-2" : ""}`}>
          <Search size={16} className="shrink-0 opacity-40" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-keyshortcuts="Meta+K Control+K"
            className="min-w-0 grow text-sm"
            placeholder="Search all brands and deals…"
            aria-label="Search all deals"
            aria-expanded={expanded}
            aria-controls={expanded ? "search-suggestions" : undefined}
            aria-activedescendant={
              highlightedIndex >= 0 ? optionId(highlightedIndex) : undefined
            }
            value={query}
            onFocus={() => setShowSuggestions(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlightedId(null);
              setShowSuggestions(true);
            }}
            onKeyDown={handleSearchKey}
          />
          {query ? (
            <button
              type="button"
              className="btn btn-ghost btn-square btn-xs"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                closeSuggestions();
                inputRef.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          ) : (
            <kbd aria-hidden="true" className="kbd kbd-sm hidden shrink-0 whitespace-nowrap sm:inline-flex">
              {/Mac/.test(navigator.platform) ? "⌘ K" : "Ctrl K"}
            </kbd>
          )}
        </div>
      </div>
      {expanded && (
        <div className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-xl">
          <div
            className="border-b border-base-200 px-3 py-2 text-xs font-semibold text-base-content/55"
            aria-live="polite"
          >
            {ready
              ? `${results.length} ${results.length === 1 ? "match" : "matches"}`
              : "Deals not loaded"}
          </div>
          <div
            id="search-suggestions"
            role="listbox"
            aria-label="Matching deals"
            className="max-h-[min(14rem,50vh)] overflow-y-auto"
          >
            {ready &&
              results.map((deal, index) => {
                const highlighted = index === highlightedIndex;
                const column = (deal.live ? LIVE_GROUPS : BOARD_GROUPS).find(
                  (group) => inGroup(group, deal),
                );
                return (
                  <button
                    key={deal.id}
                    id={optionId(index)}
                    type="button"
                    role="option"
                    aria-selected={highlighted}
                    tabIndex={-1}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left ${highlighted ? "bg-secondary/20" : "hover:bg-base-200"}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pickDeal(deal)}
                  >
                    <span className="min-w-0 truncate text-sm font-semibold">
                      {deal.brand}
                    </span>
                    <span
                      className={`tone-${column?.color || statusColor(deal.status)} max-w-[48%] shrink-0 truncate text-xs text-[color:var(--tone)]`}
                    >
                      {deal.status}
                    </span>
                  </button>
                );
              })}
          </div>
          {!ready ? (
            <p className="px-3 py-4 text-sm text-base-content/55">
              Connect to Notion to search your deals.
            </p>
          ) : (
            !results.length && (
              <p className="px-3 py-4 text-sm text-base-content/55">
                No matching brands or deals.
              </p>
            )
          )}
          {ready && results.length > 6 && (
            <button
              type="button"
              className="w-full border-t border-base-200 px-3 py-2 text-left text-xs font-semibold text-primary hover:bg-base-200"
              onClick={() => {
                closeSuggestions();
                document
                  .getElementById("search-results")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              View all {results.length} matches
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SearchResults({ query, results, onOpen, ready }) {
  return (
    <section
      id="search-results"
      className="mx-auto w-full max-w-4xl scroll-mt-24"
      aria-live="polite"
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="eyebrow">Across UGC, livestreams and archive</p>
          <h2 className="section-title mt-1">
            Search results for “{query.trim()}”
          </h2>
        </div>
        {ready && (
          <span className="badge badge-primary badge-soft">
            {results.length} {results.length === 1 ? "match" : "matches"}
          </span>
        )}
      </div>
      {!ready ? (
        <div className="rounded-2xl border border-dashed border-base-300 bg-base-100 px-6 py-14 text-center">
          <Search size={28} className="mx-auto mb-3 text-base-content/30" />
          <b>Search unavailable</b>
          <p className="mt-1 text-sm text-base-content/55">
            Connect to Notion to search your deals.
          </p>
        </div>
      ) : results.length ? (
        <div className="space-y-2">
          {results.map((deal) => (
            <button
              key={deal.id}
              type="button"
              className="deal-card flex w-full items-start justify-between gap-4 text-left"
              onClick={() => onOpen(deal.id)}
            >
              <div className="min-w-0">
                <h3 className="font-semibold text-base-content">
                  {deal.brand}
                </h3>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span
                    className={`tone-chip tone-${statusColor(deal.status)}`}
                  >
                    {deal.status || "No status"}
                  </span>
                  <span className="badge badge-ghost badge-xs h-auto py-1">
                    {deal.live ? "Livestream" : "UGC video"}
                  </span>
                  {CLOSED.has(deal.status) && (
                    <span className="badge badge-outline badge-xs h-auto py-1">
                      Archived
                    </span>
                  )}
                </div>
                {deal.next && (
                  <p className="mt-2 line-clamp-2 text-xs text-base-content/60">
                    {deal.next}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-xs text-base-content/45">
                {deal.deadlineStart
                  ? formatDate(deal.deadlineStart)
                  : age(deal.edited)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-base-300 bg-base-100 px-6 py-14 text-center">
          <img
            src={sharkCat}
            alt=""
            className="mx-auto mb-3 size-8 opacity-85"
          />
          <b>0 matches</b>
          <p className="mt-1 text-sm text-base-content/55">
            Try another brand or keyword.
          </p>
        </div>
      )}
    </section>
  );
}

function DealCard({ deal, onOpen, onDrag }) {
  const overdue = isOverdue(deal);
  return (
    <div
      className="deal-card group"
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", deal.id);
        onDrag(deal.id);
      }}
      onDragEnd={() => onDrag(null)}
      onClick={() => onOpen(deal.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(deal.id);
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-semibold leading-snug text-base-content">
          {deal.brand}
        </h4>
        <Pencil
          size={14}
          className="mt-0.5 shrink-0 opacity-0 group-hover:opacity-50"
        />
      </div>
      {deal.deadlineStart && (
        <div
          className={`mt-2 flex items-center gap-1.5 text-xs font-semibold ${overdue ? "text-error" : "text-primary"}`}
        >
          <CalendarDays size={13} />
          {deal.live
            ? `${formatDate(deal.deadlineStart)} · ${formatTime(deal.deadlineStart)}${deal.deadlineEnd ? `–${formatTime(deal.deadlineEnd)}` : ""}`
            : overdue
              ? `${-dayDiff(deal.deadlineStart)}d overdue`
              : `Due ${formatDate(deal.deadlineStart)}`}
        </div>
      )}
      {(deal.type.length > 0 || deal.platforms.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-1">
          {deal.type.map((type) => (
            <span
              key={type}
              className={`tone-chip tone-${TYPE_COLORS[type] || "gray"}`}
            >
              {type}
            </span>
          ))}
          {deal.platforms.map((platform) => (
            <span
              key={platform}
              className="badge badge-outline badge-xs h-auto py-1"
            >
              {platform}
            </span>
          ))}
        </div>
      )}
      <p
        className={`mt-3 line-clamp-2 text-xs leading-relaxed ${deal.next ? "text-base-content/75" : "italic text-base-content/40"}`}
      >
        {deal.next || "Add a next step"}
      </p>
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-base-200 pt-3 text-[11px] text-base-content/50">
        <span className="flex items-center gap-1.5">
          <span
            className={`tone-chip tone-${SOURCE_COLORS[deal.source] || "gray"}`}
          >
            {deal.source}
          </span>
          {deal.has?.includes("Attachments") && (
            <Paperclip size={13} className="text-primary/70" role="img" aria-label="Has attachments">
              <title>Has attachments</title>
            </Paperclip>
          )}
          {deal.has?.includes("Links") && (
            <Link2 size={13} className="text-primary/70" role="img" aria-label="Has links">
              <title>Has links</title>
            </Link2>
          )}
        </span>
        <span className={isStale(deal) ? "font-semibold text-warning" : ""}>
          {deal.status === FOLLOW_UP_STATUS ? (
            "Follow-up needed"
          ) : (
            <>
              {isStale(deal) ? "Gone quiet · " : ""}
              {age(deal.last || deal.edited)}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function Calendar({ deals, month, setMonth, onOpen, ready }) {
  const [previewDate, setPreviewDate] = useState(null);
  const previewDialog = useRef(null);
  const year = month.getFullYear(),
    index = month.getMonth();
  const first = new Date(year, index, 1);
  const start = new Date(first);
  start.setDate(1 - ((start.getDay() + 6) % 7));
  const last = new Date(year, index + 1, 0);
  const weeks = Math.ceil(
    (Math.round((last.getTime() - start.getTime()) / 864e5) + 1) / 7,
  );
  const dates = Array.from({ length: weeks * 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const byDate = new Map();
  deals
    .filter((d) => d.deadlineStart)
    .forEach((deal) => {
      const key = datePart(deal.deadlineStart);
      byDate.set(key, [...(byDate.get(key) || []), deal]);
    });
  const iso = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const todayKey = today();
  const sortedEvents = (key) => [...(byDate.get(key) || [])].sort((a, b) =>
    a.deadlineStart.localeCompare(b.deadlineStart) || a.brand.localeCompare(b.brand),
  );
  const dayLabel = (date) => date.toLocaleDateString("en-SG", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const previewEvents = previewDate ? sortedEvents(iso(previewDate)) : [];
  return (
    <section className="rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm md:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="section-title">Deadlines</h3>
          <p className="text-xs text-base-content/50">
            {ready
              ? `${deals.filter((d) => datePart(d.deadlineStart).slice(0, 7) === iso(month).slice(0, 7)).length} this month`
              : "Your dates will appear when Notion connects"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => setMonth(new Date())}
          >
            Today
          </button>
          <button
            className="btn btn-ghost btn-square btn-xs"
            aria-label="Previous month"
            onClick={() => setMonth(new Date(year, index - 1, 1))}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="w-28 text-center text-xs font-semibold">
            {month.toLocaleDateString("en-SG", {
              month: "long",
              year: "numeric",
            })}
          </span>
          <button
            className="btn btn-ghost btn-square btn-xs"
            aria-label="Next month"
            onClick={() => setMonth(new Date(year, index + 1, 1))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="calendar-grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
          <div
            key={day}
            className="py-2 text-center text-[10px] font-bold uppercase tracking-widest text-base-content/45"
          >
            {day}
          </div>
        ))}
        {dates.map((date) => {
          const key = iso(date),
            events = sortedEvents(key);
          return (
            <button
              key={key}
              type="button"
              disabled={!ready}
              aria-haspopup="dialog"
              aria-label={`${dayLabel(date)}, ${events.length} ${events.length === 1 ? "deadline" : "deadlines"}`}
              className={`flex min-h-21 min-w-0 flex-col items-start border-t border-base-200 p-1.5 text-left enabled:hover:bg-base-200/70 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-primary ${date.getMonth() !== index ? "bg-base-200/40 text-base-content/45" : ""}`}
              onClick={() => {
                setPreviewDate(date);
                previewDialog.current?.showModal();
              }}
            >
              <span
                className={`mb-1 flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${key === todayKey ? "bg-primary font-bold text-primary-content" : ""}`}
              >
                {date.getDate()}
              </span>
              {events.slice(0, 3).map((deal) => (
                  <span
                    key={deal.id}
                    className={`mb-0.5 block w-full truncate rounded px-1 text-left text-[10px] ${isOverdue(deal) ? "bg-error/15 text-error" : "bg-primary/10 text-primary"}`}
                    title={deal.brand}
                  >
                    {deal.brand}
                  </span>
                ))}
              {events.length > 3 && (
                <span className="text-[10px] opacity-60">
                  +{events.length - 3} more
                </span>
              )}
            </button>
          );
        })}
      </div>
      <dialog ref={previewDialog} className="modal" aria-labelledby="calendar-day-title" onClose={() => setPreviewDate(null)}>
        <div className="modal-box max-w-lg border border-base-300 bg-base-100 p-5">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 id="calendar-day-title" className="section-title">{previewDate ? dayLabel(previewDate) : "Deadlines"}</h3>
              <p className="mt-1 text-sm text-base-content/65">{previewEvents.length} {previewEvents.length === 1 ? "deadline" : "deadlines"}</p>
            </div>
            <form method="dialog">
              <button type="submit" className="btn btn-ghost btn-square" aria-label="Close deadline preview" autoFocus><X size={18} /></button>
            </form>
          </header>
          {previewEvents.length ? <ul className="space-y-3">
            {previewEvents.map(deal => <li key={deal.id} className="rounded-xl border border-base-300 bg-base-200/40 p-3 sm:p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="min-w-0 break-words font-semibold">{deal.brand}</h4>
                <span className={`tone-chip tone-${statusColor(deal.status)}`}>{deal.status || "No status"}</span>
              </div>
              {deal.deadlineStart.includes("T") && <p className="mt-1 text-sm text-base-content/75">
                {formatTime(deal.deadlineStart)}{deal.deadlineEnd && ` – ${formatTime(deal.deadlineEnd)}`} SGT
              </p>}
              {deal.platforms.length > 0 && <p className="mt-1 text-xs text-base-content/70">{deal.platforms.join(", ")}</p>}
              {deal.next && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-base-content/80"><b>Next step:</b> {deal.next}</p>}
              <div className="mt-2 flex justify-end">
                <button type="button" className="btn btn-outline btn-sm min-h-11" aria-label={`Edit deal: ${deal.brand}`} onClick={() => {
                  previewDialog.current?.close();
                  onOpen(deal.id);
                }}>Edit deal</button>
              </div>
            </li>)}
          </ul> : <p className="rounded-xl bg-base-200/50 p-4 text-sm text-base-content/75">No deadlines for this day.</p>}
        </div>
        <form method="dialog" className="modal-backdrop"><button type="submit" tabIndex={-1}>Close deadline preview</button></form>
      </dialog>
    </section>
  );
}

const MAX_ATTACHMENT_BYTES = 2.5 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const formatSize = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function AttachmentPicker({ files, mediaKit, onAdd, onRemove, disabled }) {
  return (
    <details className="rounded-lg border border-base-300">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-2 text-xs font-semibold">
        <Paperclip size={14} />
        Attachments{files.length ? ` · ${files.length}` : ""}
        <ChevronDown size={13} className="ml-auto" />
      </summary>
      <div className="space-y-2 border-t border-base-300 p-2">
        {mediaKit && (
          <button
            type="button"
            className="btn btn-outline btn-sm w-full justify-start"
            disabled={disabled}
            onClick={() => onAdd([mediaKit])}
          >
            <Paperclip size={14} />
            Attach saved media kit · {mediaKit.name}
          </button>
        )}
        <label
          className="flex min-h-20 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-base-300 bg-base-200/50 p-3 text-center text-xs hover:bg-base-200"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (!disabled) onAdd(event.dataTransfer.files);
          }}
        >
          <Paperclip size={16} />
          <span className="mt-1">Drop files here or click to choose</span>
          <span className="mt-0.5 opacity-60">
            PDFs, PR kits and other files · 2.5 MB total
          </span>
          <input
            type="file"
            multiple
            className="sr-only"
            disabled={disabled}
            onChange={(event) => {
              onAdd(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
        {files.length > 0 && (
          <ul className="space-y-1">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${file.lastModified}-${index}`}
                className="flex items-center gap-2 rounded bg-base-200 px-2 py-1 text-xs"
              >
                <span className="min-w-0 flex-1 truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="opacity-55">{formatSize(file.size)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-square btn-xs"
                  aria-label={`Remove ${file.name}`}
                  disabled={disabled}
                  onClick={() => onRemove(index)}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function encodeAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        name: file.name,
        type: file.type || "application/octet-stream",
        data: String(reader.result).split(",")[1] || "",
      });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function GmailPanel({ deal, onLinked }) {
  const [status, setStatus] = useState(null);
  const [thread, setThread] = useState(null);
  const threadRef = useRef(null);
  const [linkInput, setLinkInput] = useState("");
  const [linking, setLinking] = useState(false);
  const [form, setForm] = useState({ to: "", subject: "", body: "" });
  const [attachments, setAttachments] = useState([]);
  const [mediaKit, setMediaKit] = useState(null);
  const [kitBusy, setKitBusy] = useState(false);
  const [draftId, setDraftId] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    getMediaKit()
      .then((file) => {
        if (active) setMediaKit(file);
      })
      .catch((error) => {
        if (active)
          setMessage(`Could not load the saved media kit: ${error.message}`);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (threadRef.current && thread?.messages?.length)
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [thread]);
  useEffect(() => {
    let active = true;
    setStatus(null);
    setThread(null);
    setDraftId(null);
    setMessage("");
    setForm({ to: "", subject: "", body: "" });
    setAttachments([]);
    api("/gmail/status")
      .then(async (value) => {
        if (!active) return;
        setStatus(value);
        if (!value.connected || !deal.gmail) return;
        const result = await api(`${apiPath(deal.id)}/gmail`);
        if (!active) return;
        setThread(result.thread);
        if (result.deal) onLinked(result.deal);
        setForm({
          to: result.reply?.to || "",
          subject: result.reply?.subject || "",
          body: "",
        });
      })
      .catch((error) => {
        if (active) {
          setStatus(
            (previous) => previous || { configured: false, connected: false },
          );
          setMessage(error.message);
        }
      });
    return () => {
      active = false;
    };
  }, [deal.id, deal.gmail]);
  const linkThread = async (event) => {
    event.preventDefault();
    setBusy("link");
    setMessage("");
    try {
      const result = await api(`${apiPath(deal.id)}/gmail/link`, {
        method: "POST",
        body: JSON.stringify({ url: linkInput.trim() }),
      });
      setLinkInput("");
      setLinking(false);
      onLinked(result.deal);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };
  const act = async (action) => {
    if (action === "send" && hasTemplateFields(form.body)) {
      setMessage("Replace the [bracketed details] before sending.");
      return;
    }
    if (
      action === "send" &&
      !window.confirm(
        `Send this email to ${form.to}${attachments.length ? ` with ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}` : ""}?`,
      )
    )
      return;
    setBusy(action);
    setMessage("");
    try {
      const files = await Promise.all(attachments.map(encodeAttachment));
      const result = await api(`${apiPath(deal.id)}/gmail/${action}`, {
        method: "POST",
        body: JSON.stringify({ ...form, draftId, attachments: files }),
      });
      setMessage(
        result.warning ||
          (action === "draft"
            ? "Draft saved in Gmail."
            : "Email sent through Gmail."),
      );
      if (action === "draft") setDraftId(result.id);
      if (action === "send") {
        setDraftId(null);
        setAttachments([]);
        setForm((previous) => ({ ...previous, body: "" }));
        const result = await api(`${apiPath(deal.id)}/gmail`);
        setThread(result.thread);
        setForm((previous) => ({
          ...previous,
          to: result.reply?.to || previous.to,
          subject: result.reply?.subject || previous.subject,
        }));
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };
  const applyTemplate = (template) => {
    if (
      form.body.trim() &&
      !window.confirm("Replace the current message with this template?")
    )
      return;
    setForm((previous) => ({ ...previous, body: template.body(deal.brand) }));
  };
  const addAttachments = (selected) => {
    const incoming = Array.from(selected || []);
    const next = [
      ...attachments,
      ...incoming.filter(
        (file) =>
          !attachments.some(
            (current) =>
              current.name === file.name &&
              current.size === file.size &&
              current.lastModified === file.lastModified,
          ),
      ),
    ];
    if (next.length > MAX_ATTACHMENTS) {
      setMessage(`Choose up to ${MAX_ATTACHMENTS} attachments.`);
      return;
    }
    if (
      next.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES
    ) {
      setMessage("Attachments must total 2.5 MB or less.");
      return;
    }
    setAttachments(next);
    setMessage("");
  };
  const saveKit = async (selected) => {
    const file = selected?.[0];
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setMessage("The media kit must be 2.5 MB or less.");
      return;
    }
    setKitBusy(true);
    setMessage("");
    try {
      await saveMediaKit(file);
      setMediaKit(file);
      setMessage("Media kit saved on this device.");
    } catch (error) {
      setMessage(`Could not save the media kit: ${error.message}`);
    } finally {
      setKitBusy(false);
    }
  };
  const clearKit = async () => {
    setKitBusy(true);
    setMessage("");
    try {
      await removeMediaKit();
      setMediaKit(null);
      setMessage("Saved media kit removed from this device.");
    } catch (error) {
      setMessage(`Could not remove the media kit: ${error.message}`);
    } finally {
      setKitBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy("disconnect");
    setMessage("");
    try {
      await api("/gmail/disconnect", { method: "POST" });
      setStatus((previous) => ({ ...previous, connected: false }));
      setThread(null);
      setDraftId(null);
      setForm({ to: "", subject: "", body: "" });
      setAttachments([]);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };
  const latestMessageId =
    [...(thread?.messages || [])].reverse().find((mail) => !mail.draft)?.id ||
    thread?.messages?.at(-1)?.id;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="section-title">Gmail conversation</h3>
        {status?.connected && (
          <span className="badge badge-success badge-soft badge-sm">
            {status.email || "Connected"}
          </span>
        )}
      </div>
      <details className="rounded-lg border border-base-300 p-2">
        <summary className="cursor-pointer text-xs font-semibold">
          Saved media kit{mediaKit ? ` · ${mediaKit.name}` : ""}
        </summary>
        <div className="mt-2 space-y-2 text-xs">
          <p className="text-base-content/60">
            Save one media kit on this device to attach it quickly to future
            replies.
          </p>
          {mediaKit && (
            <p className="truncate" title={mediaKit.name}>
              {mediaKit.name} · {formatSize(mediaKit.size)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <label className="btn btn-outline btn-xs">
              {mediaKit ? "Replace media kit" : "Choose media kit"}
              <input
                type="file"
                className="sr-only"
                disabled={kitBusy}
                onChange={(event) => {
                  saveKit(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
            {mediaKit && (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                disabled={kitBusy}
                onClick={clearKit}
              >
                Remove saved kit
              </button>
            )}
          </div>
        </div>
      </details>
      {!status ? (
        <span className="loading loading-spinner loading-sm" />
      ) : !status.configured ? (
        <p className="text-sm text-base-content/60">
          Gmail setup is needed before you can read or reply here.
        </p>
      ) : !status.connected ? (
        <div className="space-y-2">
          <p className="text-sm text-base-content/60">
            Connect your Google account to read this thread, save drafts and
            send replies.
          </p>
          <a className="btn btn-primary btn-sm" href="/api/gmail/auth/start">
            Connect Gmail
          </a>
        </div>
      ) : !deal.gmail || linking ? (
        <form onSubmit={linkThread} className="space-y-2">
          <p className="text-sm text-base-content/60">
            Paste the Gmail conversation link or thread ID to attach all its
            messages to this Notion deal.
          </p>
          <label className="block text-xs">
            Gmail conversation
            <input
              className="input input-bordered mt-1 w-full"
              type="text"
              value={linkInput}
              onChange={(event) => setLinkInput(event.target.value)}
              placeholder="Gmail conversation URL or thread ID"
            />
          </label>
          <div className="flex gap-2">
            <button
              className="btn btn-primary btn-sm"
              disabled={!!busy || !linkInput.trim()}
              type="submit"
            >
              {deal.gmail ? "Replace conversation" : "Link conversation"}
            </button>
            {deal.gmail && (
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => setLinking(false)}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <>
          <button
            className="btn btn-ghost btn-xs"
            type="button"
            onClick={() => setLinking(true)}
          >
            Change conversation
          </button>
          {thread?.messages?.length ? (
            <div
              ref={threadRef}
              className="max-h-80 space-y-2 overflow-y-auto rounded-xl border border-base-300 p-2"
            >
              {thread.messages.map((mail) => (
                <details
                  key={mail.id}
                  open={mail.id === latestMessageId}
                  className={`rounded-lg p-3 text-xs ${mail.outgoing ? "message-outgoing" : "bg-base-200"}`}
                >
                  <summary className="cursor-pointer font-semibold">
                    {mail.from}{" "}
                    <span className="float-right font-normal opacity-55">
                      {mail.date
                        ? new Date(mail.date).toLocaleDateString("en-SG")
                        : ""}
                    </span>
                  </summary>
                  <p className="mt-1 opacity-60">To: {mail.to}</p>
                  <MessageText text={mail.body} />
                </details>
              ))}
            </div>
          ) : (
            <p className="text-sm text-base-content/55">
              No messages found in the linked thread.
            </p>
          )}
          <GmailAttachments messages={thread?.messages || []} gmailUrl={`/api${apiPath(deal.id)}/gmail`} formatSize={formatSize} />
          <GmailLinks messages={thread?.messages || []} />
          <div className="space-y-2 rounded-xl border border-base-300 p-3">
            <h4 className="text-sm font-semibold">Reply</h4>
            <div>
              <p className="mb-2 text-xs font-semibold">
                Start from a template
              </p>
              <div className="flex flex-wrap gap-1.5">
                {EMAIL_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="btn btn-outline btn-xs"
                    disabled={!!busy}
                    onClick={() => applyTemplate(template)}
                  >
                    {template.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-base-content/55">
                Review and replace any [bracketed details] before saving a
                draft.
              </p>
            </div>
            <label className="block text-xs">
              To
              <input
                className="input input-bordered mt-1 w-full"
                type="email"
                value={form.to}
                onChange={(event) =>
                  setForm({ ...form, to: event.target.value })
                }
              />
            </label>
            <label className="block text-xs">
              Subject
              <input
                className="input input-bordered mt-1 w-full"
                value={form.subject}
                readOnly
              />
            </label>
            <label className="block text-xs">
              Message
              <textarea
                className="textarea textarea-bordered mt-1 min-h-32 w-full"
                value={form.body}
                onChange={(event) =>
                  setForm({ ...form, body: event.target.value })
                }
              />
            </label>
            <AttachmentPicker
              files={attachments}
              mediaKit={mediaKit}
              onAdd={addAttachments}
              onRemove={(index) =>
                setAttachments((files) => files.filter((_, i) => i !== index))
              }
              disabled={!!busy}
            />
            <div className="flex gap-2">
              <button
                className="btn btn-outline btn-sm"
                disabled={!!busy || !form.to || !form.body.trim()}
                onClick={() => act("draft")}
              >
                Save draft
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={!!busy || !form.to || !form.body.trim()}
                onClick={() => act("send")}
              >
                Send email
              </button>
            </div>
          </div>
          <button
            className="btn btn-ghost btn-xs"
            disabled={!!busy}
            onClick={disconnect}
          >
            Disconnect Gmail
          </button>
        </>
      )}
      {message && (
        <p
          className={`text-sm ${/saved|sent/i.test(message) ? "text-success" : "text-error"}`}
          role="status"
        >
          {message}
        </p>
      )}
    </section>
  );
}

function IntegrationsDrawer({ onClose, onInstagramUnlocked, onInstagramLocked }) {
  const [gmail, setGmail] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api("/gmail/status")
      .then((status) => {
        if (active) setGmail(status);
      })
      .catch((reason) => {
        if (active) {
          setGmail({ configured: false, connected: false, unavailable: true });
          setError(reason.message);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  const disconnectGmail = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/gmail/disconnect", { method: "POST" });
      setGmail((previous) => ({ ...previous, connected: false, email: "" }));
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/35" onClick={onClose} />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-base-100 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Integrations"
      >
        <div className="flex items-start justify-between border-b border-base-300 p-5">
          <div>
            <p className="eyebrow">Workspace</p>
            <h2 className="section-title mt-1 flex items-center gap-2">
              Integrations{" "}
              <img src={sharkCat} alt="" className="size-6 opacity-85" />
            </h2>
            <p className="mt-1 text-sm text-base-content/55">
              Connect the places where brand conversations happen.
            </p>
          </div>
          <button
            className="btn btn-ghost btn-square btn-sm"
            aria-label="Close integrations"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto p-5">
          <IntegrationCard
            name="Gmail"
            icon={Mail}
            iconStyle="bg-rose-100 text-rose-700"
            description="Read linked threads, save drafts and send replies from your deals."
            detail={gmail?.connected ? gmail.email : ""}
            status={
              gmail?.unavailable
                ? "unavailable"
                : gmail?.connected
                  ? "connected"
                  : gmail?.configured
                    ? "disconnected"
                    : gmail
                      ? "setup"
                      : null
            }
            action={
              gmail?.connected ? (
                <button
                  className="btn btn-outline btn-sm"
                  disabled={busy}
                  onClick={disconnectGmail}
                >
                  {busy ? "Disconnecting…" : "Disconnect Gmail"}
                </button>
              ) : gmail?.configured ? (
                <a
                  className="btn btn-primary btn-sm"
                  href="/api/gmail/auth/start"
                >
                  Connect Gmail
                </a>
              ) : null
            }
            error={error}
          />
          <InstagramIntegration onUnlocked={onInstagramUnlocked} onLocked={onInstagramLocked} />
          <TikTokIntegration onDisconnected={onInstagramLocked} />
        </div>
      </aside>
    </>
  );
}

function DealDrawer({
  deal,
  body,
  bodyError,
  onClose,
  onSave,
  onLinked,
  onInstagramUnlocked,
}) {
  const [draft, setDraft] = useState(null);
  useEffect(
    () =>
      setDraft(
        deal
          ? {
              status: deal.status,
              type: deal.type,
              fee: deal.fee,
              next: deal.next,
              date: toDateInput(deal.deadlineStart),
              start: toTimeInput(deal.deadlineStart),
              end: toTimeInput(deal.deadlineEnd),
            }
          : null,
      ),
    [deal?.id],
  );
  if (!deal || !draft) return null;
  const save = (prop, value) => onSave(deal, prop, value);
  const saveDeadline = (patch) => {
    const updated = { ...draft, ...patch };
    setDraft(updated);
    save(
      "dl",
      deadlineValue(
        updated.date,
        deal.live ? updated.start : "",
        deal.live ? updated.end : "",
      ),
    );
  };
  const historyAt = body?.search(/^## Email history\s*$/m) ?? -1;
  const notes = historyAt < 0 ? body : body?.slice(0, historyAt);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/35" onClick={onClose} />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col bg-base-100 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={deal.brand}
      >
        <div className="flex items-start justify-between gap-3 border-b border-base-300 p-5">
          <div className="min-w-0">
            <p className="eyebrow">Collaboration details</p>
            <h2 className="break-words font-display text-2xl font-semibold">
              {deal.brand}
            </h2>
          </div>
          <button
            className="btn btn-ghost btn-square btn-sm"
            aria-label="Close details"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <div className="grid grid-cols-2 gap-3">
            <label className="form-control">
              <span className="label-text mb-1 text-xs font-semibold">
                Status
              </span>
              <select
                className="select select-bordered w-full"
                value={draft.status}
                onChange={(event) => {
                  setDraft({ ...draft, status: event.target.value });
                  save("status", event.target.value);
                }}
              >
                {STATUSES.map((s) => (
                  <option key={s.key}>{s.key}</option>
                ))}
              </select>
            </label>
            <div>
              <span className="mb-1 block text-xs font-semibold">
                Deal type
              </span>
              <details className="dropdown w-full">
                <summary className="btn btn-outline w-full justify-between gap-2 font-normal">
                  <span className="flex min-w-0 flex-wrap gap-1">
                    {draft.type.length
                      ? draft.type.map((type) => (
                          <span
                            key={type}
                            className={`tone-chip tone-${TYPE_COLORS[type] || "gray"}`}
                          >
                            {type}
                          </span>
                        ))
                      : "None"}
                  </span>
                  <ChevronDown size={14} className="shrink-0" />
                </summary>
                <div className="dropdown-content z-10 mt-1 w-full rounded-xl border border-base-300 bg-base-100 p-3 shadow-xl">
                  {TYPES.map((type) => (
                    <label
                      key={type}
                      className="flex cursor-pointer items-center gap-2 py-1 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="checkbox checkbox-primary checkbox-xs"
                        checked={draft.type.includes(type)}
                        onChange={() => {
                          const value = draft.type.includes(type)
                            ? draft.type.filter((t) => t !== type)
                            : [...draft.type, type];
                          setDraft({ ...draft, type: value });
                          save("type", value);
                        }}
                      />
                      <span
                        className={`tone-dot tone-${TYPE_COLORS[type] || "gray"}`}
                      />
                      {type}
                    </label>
                  ))}
                </div>
              </details>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="mb-1 block text-xs font-semibold">
                {deal.live ? "Stream date" : "Deadline"}
              </span>
              <input
                type="date"
                className="input input-bordered w-full"
                value={draft.date}
                onChange={(event) => saveDeadline({ date: event.target.value })}
              />
            </label>
            <label>
              <span className="mb-1 block text-xs font-semibold">Fee</span>
              <input
                className="input input-bordered w-full"
                value={draft.fee}
                onChange={(event) =>
                  setDraft({ ...draft, fee: event.target.value })
                }
                onBlur={() => save("fee", draft.fee)}
              />
            </label>
          </div>
          {deal.live && (
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className="mb-1 block text-xs font-semibold">Starts</span>
                <input
                  type="time"
                  className="input input-bordered w-full"
                  value={draft.start}
                  onChange={(event) =>
                    saveDeadline({ start: event.target.value })
                  }
                />
              </label>
              <label>
                <span className="mb-1 block text-xs font-semibold">Ends</span>
                <input
                  type="time"
                  className="input input-bordered w-full"
                  value={draft.end}
                  onChange={(event) =>
                    saveDeadline({ end: event.target.value })
                  }
                />
              </label>
            </div>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-semibold">Next step</span>
            <textarea
              className="textarea textarea-bordered min-h-24 w-full"
              value={draft.next}
              onChange={(event) =>
                setDraft({ ...draft, next: event.target.value })
              }
              onBlur={() => save("next", draft.next)}
            />
          </label>
          {deal.status === FOLLOW_UP_STATUS && (
            <div className="alert alert-warning text-sm">
              <Clock3 size={17} />
              <span>
                This deal moved here after at least 14 days since its last
                recorded activity. Its status was saved to Notion.
              </span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-base-200 p-4 text-xs">
            <div>
              <b>Agency / platform</b>
              <p className="mt-1 opacity-65">{deal.agency || "—"}</p>
            </div>
            <div>
              <b>Platforms</b>
              <p className="mt-1 opacity-65">
                {deal.platforms.join(", ") || "—"}
              </p>
            </div>
            <div>
              <b>Last activity</b>
              <p className="mt-1 opacity-65">{formatDate(deal.last) || "—"}</p>
            </div>
            <div>
              <b>Last edited</b>
              <p className="mt-1 opacity-65">
                {deal.edited
                  ? new Date(deal.edited).toLocaleString("en-SG", {
                      timeZone: "Asia/Singapore",
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })
                  : "—"}
              </p>
            </div>
            <div>
              <b>Source</b>
              <p className="mt-1 opacity-65">{deal.source}</p>
            </div>
            <img
              src={collabCat}
              alt=""
              width="56"
              height="56"
              className="size-24 self-end justify-self-end object-contain"
            />
          </div>
          <a
            className="link link-primary inline-flex items-center gap-1 text-sm"
            href={deal.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in Notion <ExternalLink size={13} />
          </a>
          <section>
            <h3 className="section-title mb-2">From the Notion page</h3>
            {bodyError ? (
              <p className="text-sm text-error">{bodyError}</p>
            ) : body == null ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              <div className="prose prose-sm max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {notes?.trim() || "No notes yet."}
                </ReactMarkdown>
              </div>
            )}
          </section>
          {deal.source === "Email" && (
            <GmailPanel deal={deal} onLinked={onLinked} />
          )}
          {deal.source === "Instagram" && (
            <InstagramPanel
              key={deal.id}
              deal={deal}
              onLinked={onLinked}
              onUnlocked={onInstagramUnlocked}
            />
          )}
        </div>
      </aside>
    </>
  );
}

const onOverview = () => window.location.hash !== "#deal-board";

export default function App() {
  const [deals, setDeals] = useState([]);
  const updateLinkedDeal = useCallback((linked) => {
    setDeals((items) => items.map((item) => item.id === linked.id
      ? { ...linked, live: isLive(linked), source: sourceOf(linked) }
      : item));
  }, []);
  const [load, setLoad] = useState({ state: "loading", message: "", at: null });
  const [view, setView] = useState(initialView);
  const [overview, setOverview] = useState(onOverview);
  const [boardExpanded, setBoardExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({
    type: [],
    platform: [],
    source: [],
    kpi: "",
  });
  const [drawer, setDrawer] = useState(null);
  const [instagramAccessRevision, setInstagramAccessRevision] = useState(0);
  const [body, setBody] = useState(null);
  const [bodyError, setBodyError] = useState("");
  const [log, setLog] = useState([]);
  const [notice, setNotice] = useState("");
  const [month, setMonth] = useState(new Date());
  const [dragId, setDragId] = useState(null);
  const [, setClockTick] = useState(0);
  const queue = useRef(Promise.resolve());
  const refreshing = useRef(null);
  const instagramSync = useRef(null);

  useEffect(() => {
    function updatePage() {
      setOverview(onOverview());
      setQuery("");
    }
    window.addEventListener("popstate", updatePage);
    window.addEventListener("hashchange", updatePage);
    return () => {
      window.removeEventListener("popstate", updatePage);
      window.removeEventListener("hashchange", updatePage);
    };
  }, []);

  function refreshInstagramAccess() {
    setInstagramAccessRevision((revision) => revision + 1);
  }

  function instagramUnlocked() {
    refreshInstagramAccess();
    refresh();
  }

  useEffect(() => {
    try {
      localStorage.setItem(
        "cp-view",
        JSON.stringify({
          board: view.board,
          sort: view.sort,
          hideEmpty: view.hideEmpty,
          sidebar: view.sidebar,
        }),
      );
    } catch {
      /* Preferences are optional. */
    }
  }, [view]);
  function refresh() {
    if (refreshing.current) return refreshing.current;
    setLoad((previous) => ({
      ...previous,
      state: previous.at ? "refreshing" : "loading",
    }));
    refreshing.current = api("/deals")
      .then((result) => {
        const rows = result.deals.map((deal) => ({
          ...deal,
          live: isLive(deal),
          source: sourceOf(deal),
        }));
        setDeals(rows);
        setLoad({
          state: "ready",
          message: "",
          warnings: result.warnings || [],
          at: new Date(),
        });
        if (
          !instagramSync.current &&
          rows.some(
            (deal) => deal.source === "Instagram" && !deal.instagramLinked,
          )
        ) {
          instagramSync.current = syncInstagramLinks((linked) => {
            setDeals((items) =>
              items.map((item) =>
                item.id === linked.id
                  ? {
                      ...item,
                      instagramLinked: true,
                      last: linked.last > item.last ? linked.last : item.last,
                    }
                  : item,
              ),
            );
          })
            .catch((error) => setNotice(`Instagram sync: ${error.message}`))
            .finally(() => {
              instagramSync.current = null;
            });
        }
      })
      .catch((error) => {
        setLoad((previous) => ({
          ...previous,
          state: previous.at ? "ready" : "error",
          message: error.message,
          warnings: [],
        }));
        setNotice(`Refresh failed: ${error.message}`);
      })
      .finally(() => {
        refreshing.current = null;
      });
    return refreshing.current;
  }
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    if (!drawer || drawer === "log" || drawer === "integrations") return;
    let active = true;
    setBody(null);
    setBodyError("");
    api(`${apiPath(drawer)}/body`)
      .then((data) => {
        if (active) setBody(data.markdown);
      })
      .catch((error) => {
        if (active) setBodyError(error.message);
      });
    return () => {
      active = false;
    };
  }, [drawer]);
  useEffect(() => {
    const handler = (event) => {
      if (event.key === "Escape") setDrawer(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => refresh(), 15 * 60_000);
    return () => clearInterval(timer);
  }, []);

  const save = (deal, prop, value) => {
    const before = deals.find((item) => item.id === deal.id);
    if (!before) return;
    const patch =
      prop === "dl"
        ? { deadlineStart: value?.start || "", deadlineEnd: value?.end || "" }
        : { [prop]: value };
    setDeals((items) =>
      items.map((item) => {
        if (item.id !== deal.id) return item;
        const next = { ...item, ...patch, edited: new Date().toISOString() };
        return { ...next, live: isLive(next) };
      }),
    );
    const entry = {
      id: crypto.randomUUID(),
      brand: deal.brand,
      prop,
      value,
      at: new Date(),
      status: "Waiting",
    };
    setLog((items) => [entry, ...items]);
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        setLog((items) =>
          items.map((item) =>
            item.id === entry.id ? { ...item, status: "Saving" } : item,
          ),
        );
        try {
          const data = await api(apiPath(deal.id), {
            method: "PATCH",
            body: JSON.stringify({ prop, value }),
          });
          setDeals((items) =>
            items.map((item) => {
              if (
                item.id !== deal.id ||
                (prop === "dl"
                  ? item.deadlineStart !== patch.deadlineStart
                  : item[prop] !== value)
              )
                return item;
              const next = {
                ...item,
                ...(prop === "dl"
                  ? {
                      deadlineStart: data.deal.deadlineStart,
                      deadlineEnd: data.deal.deadlineEnd,
                    }
                  : { [prop]: data.deal[prop] }),
                last: data.deal.last,
                edited: data.deal.edited,
              };
              return { ...next, live: isLive(next), source: sourceOf(next) };
            }),
          );
          setLog((items) =>
            items.map((item) =>
              item.id === entry.id ? { ...item, status: "Saved" } : item,
            ),
          );
        } catch (error) {
          setDeals((items) =>
            items.map((item) => {
              if (
                item.id !== deal.id ||
                (prop === "dl"
                  ? item.deadlineStart !== patch.deadlineStart
                  : item[prop] !== value)
              )
                return item;
              const next = {
                ...item,
                ...(prop === "dl"
                  ? {
                      deadlineStart: before.deadlineStart,
                      deadlineEnd: before.deadlineEnd,
                    }
                  : { [prop]: before[prop] }),
              };
              return { ...next, live: isLive(next) };
            }),
          );
          setLog((items) =>
            items.map((item) =>
              item.id === entry.id
                ? { ...item, status: "Failed", error: error.message }
                : item,
            ),
          );
          setNotice(`Couldn't save ${prop} on ${deal.brand}: ${error.message}`);
        }
      });
  };

  const scoped = useMemo(
    () => deals.filter((d) => (view.board === "live" ? d.live : !d.live)),
    [deals, view.board],
  );
  const boardCount = scoped.filter((deal) => !CLOSED.has(deal.status)).length;
  const searchActive = Boolean(query.trim());
  const searchResults = useMemo(
    () => searchDeals(deals, query),
    [deals, query],
  );
  useEffect(() => {
    if (searchActive)
      document
        .getElementById("search-results")
        ?.scrollIntoView({ block: "start" });
  }, [searchActive]);
  const groups = view.board === "live" ? LIVE_GROUPS : BOARD_GROUPS;
  const metrics = [
    {
      key: "new",
      label: "Need first reply",
      icon: Inbox,
      test: (d) => d.status === "New - not replied",
      tint: "tone-pink",
    },
    {
      key: "overdue",
      label: "Overdue",
      icon: Clock3,
      test: isOverdue,
      tint: "tone-red",
    },
    {
      key: "soon",
      label: "Due in 7 days",
      icon: CalendarDays,
      test: isSoon,
      tint: "tone-blue",
    },
    {
      key: "stale",
      label: "Gone quiet",
      icon: Send,
      test: isStale,
      tint: "tone-gray",
    },
  ];
  const filterBase = scoped.filter((d) => {
    if (view.hideEmpty && !d.last && !d.next) return false;
    if (filters.kpi && !metrics.find((m) => m.key === filters.kpi)?.test(d))
      return false;
    return true;
  });
  const selectedGroup = groups.find((g) => g.key === view.stage);
  const phases = selectedGroup
    ? [selectedGroup.phase]
    : view.stage === "@archive"
      ? ["Archive"]
      : view.board === "live"
        ? ["Inbound", "Scheduled", "Wrap-up"]
        : ["Inbound", "Production", "Wrap-up"];
  const inStage = (d) =>
    view.stage === "@archive"
      ? CLOSED.has(d.status)
      : selectedGroup
        ? inGroup(selectedGroup, d)
        : !CLOSED.has(d.status);
  const counts = {
    type: Object.create(null),
    platform: Object.create(null),
    source: Object.create(null),
  };
  const visible = filterBase.filter((deal) => {
    const matchesType =
      !filters.type.length ||
      deal.type.some((value) => filters.type.includes(value));
    const matchesPlatform =
      !filters.platform.length ||
      deal.platforms.some((value) => filters.platform.includes(value));
    const matchesSource =
      !filters.source.length || filters.source.includes(deal.source);
    if (inStage(deal)) {
      if (matchesPlatform && matchesSource)
        for (const value of new Set(deal.type))
          counts.type[value] = (counts.type[value] || 0) + 1;
      if (matchesType && matchesSource)
        for (const value of new Set(deal.platforms))
          counts.platform[value] = (counts.platform[value] || 0) + 1;
      if (matchesType && matchesPlatform)
        counts.source[deal.source] = (counts.source[deal.source] || 0) + 1;
    }
    return matchesType && matchesPlatform && matchesSource;
  });
  const calendarDeals = visible.filter(inStage);
  const loadingDeals = load.state === "loading";
  const activeDeal =
    drawer && drawer !== "log" ? deals.find((d) => d.id === drawer) : null;
  const changeView = useCallback((patch) =>
    setView((previous) => ({ ...previous, ...patch })), []);
  const navigatePage = useCallback((nextOverview) => {
    if (overview !== nextOverview) {
      window.history.pushState(null, "", nextOverview ? "#overview" : "#deal-board");
      setOverview(nextOverview);
      window.scrollTo(0, 0);
    }
    setQuery("");
  }, [overview]);
  const chooseStage = useCallback((stage) => {
    navigatePage(false);
    changeView({ stage });
    setFilters((previous) => ({ ...previous, kpi: "" }));
  }, [changeView, navigatePage]);
  useEffect(() => {
    function switchPage(event) {
      if (event.defaultPrevented || event.isComposing || event.repeat || !event.metaKey || event.altKey || event.ctrlKey) return;
      const digit = event.code === "Digit1" ? "1" : event.code === "Digit2" ? "2" : event.key;
      if (digit !== "1" && digit !== "2") return;
      event.preventDefault();
      if (digit === "1") {
        navigatePage(true);
      } else {
        setBoardExpanded(true);
        chooseStage("");
      }
    }
    window.addEventListener("keydown", switchPage);
    return () => window.removeEventListener("keydown", switchPage);
  }, [navigatePage, chooseStage]);
  const toggleStage = (stage) =>
    chooseStage(!overview && view.stage === stage ? "" : stage);
  const drop = (event, group) => {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain") || dragId;
    const deal = deals.find((d) => d.id === id);
    setDragId(null);
    if (deal && deal.status !== group.key) save(deal, "status", group.key);
  };
  const singaporeHour = Number(
    new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date()),
  );
  const greeting =
    singaporeHour < 12
      ? "morning"
      : singaporeHour < 18
        ? "afternoon"
        : "evening";

  return (
    <div className="min-h-screen bg-base-200 text-base-content">
      <div className="flex min-h-screen">
        {view.sidebar && (
          <aside className="sidebar hidden w-64 shrink-0 flex-col overflow-y-auto px-4 py-6 lg:flex">
            <h1 className="mb-3 px-2">
              <span className="sr-only">Content Creator Command Center</span>
              <img src={sharkCat} alt="" className="size-11 rounded-full" />
            </h1>
            <button
              className="sidebar-link mb-8 border border-white/25 bg-white/10"
              onClick={() => setDrawer("integrations")}
            >
              <Plug2 size={16} /> Integrations{" "}
              <ChevronRight size={15} className="ml-auto opacity-60" />
            </button>
            <button className="sidebar-link mb-1" aria-keyshortcuts="Meta+1 Meta+Shift+1" aria-current={overview ? "page" : undefined} onClick={() => navigatePage(true)}>
              <LayoutGrid size={16} /> Overview
            </button>
            <details className="collapse collapse-arrow" open={!overview && boardExpanded}>
              <summary
                className="sidebar-link collapse-title min-h-0"
                aria-keyshortcuts="Meta+2 Meta+Shift+2"
                aria-current={!overview ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  setBoardExpanded(overview || !boardExpanded);
                  chooseStage("");
                }}
              >
                <LayoutDashboard size={16} /> Deal board
                <span className="sidebar-count text-xs" aria-label={`${boardCount} open deals`}>{boardCount}</span>
              </summary>
              <div className="collapse-content px-0">
                <div className="ml-3 border-l border-white/15 pl-3">
                  {(view.board === "live"
                    ? ["Inbound", "Scheduled", "Wrap-up"]
                    : ["Inbound", "Production", "Wrap-up"]
                  ).map((phase) => (
                    <div key={phase}>
                      <p className="sidebar-phase">{phase}</p>
                      {groups
                        .filter((group) => group.phase === phase)
                        .map((group) => (
                          <button
                            key={group.key}
                            className={`sidebar-stage ${!overview && view.stage === group.key ? "active" : ""}`}
                            aria-pressed={!overview && view.stage === group.key}
                            onClick={() => toggleStage(group.key)}
                          >
                            <span
                              className={`tone-dot tone-${group.color}`}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1">
                              {group.label || group.key}
                            </span>
                            <span className="sidebar-count">
                              {scoped.filter((d) => inGroup(group, d)).length}
                            </span>
                          </button>
                        ))}
                    </div>
                  ))}
                </div>
              </div>
            </details>
            <button
              className="sidebar-link mt-5"
              onClick={() => chooseStage("@archive")}
            >
              <Archive size={16} /> Archive{" "}
              <span className="ml-auto text-xs text-primary-content/75">
                {scoped.filter((d) => CLOSED.has(d.status)).length}
              </span>
            </button>
            <button className="sidebar-link" onClick={() => setDrawer("log")}>
              <ArrowDownUp size={16} /> Notion writes{" "}
              <span className="ml-auto text-xs text-primary-content/75">
                {log.filter((e) => e.status !== "Saved").length}
              </span>
            </button>
            <div className="mt-auto rounded-xl border border-white/15 bg-white/5 p-3 text-xs leading-relaxed text-primary-content/80">
              Changes save to Notion. Your view preferences stay on this device.
            </div>
          </aside>
        )}
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex min-h-17 items-center gap-3 border-b border-base-300 bg-base-200/95 px-4 backdrop-blur md:px-7">
            <button
              className="btn btn-ghost btn-square btn-sm hidden lg:inline-flex"
              aria-label="Toggle sidebar"
              onClick={() => changeView({ sidebar: !view.sidebar })}
            >
              <Menu size={18} />
            </button>
            <SearchBox
              query={query}
              setQuery={setQuery}
              results={searchResults}
              onSelect={setDrawer}
              ready={Boolean(load.at)}
            />
            <button
              className="btn btn-ghost btn-sm ml-auto gap-2 text-xs"
              disabled={load.state === "loading" || load.state === "refreshing"}
              onClick={refresh}
            >
              <RefreshCw
                size={14}
                className={load.state === "refreshing" ? "animate-spin" : ""}
              />
              <span className="hidden sm:inline">
                {load.state === "ready"
                  ? `Live from Notion · ${load.at?.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })}`
                  : "Refresh"}
              </span>
            </button>
            <button
              className="btn btn-ghost btn-sm gap-2 text-xs"
              aria-label="Integrations"
              onClick={() => setDrawer("integrations")}
            >
              <Plug2 size={16} />
              <span className="hidden md:inline">Integrations</span>
            </button>
          </header>
          <nav aria-label="Dashboard pages" className={`flex gap-2 border-b border-base-300 px-4 py-2 md:px-7 ${view.sidebar ? "lg:hidden" : ""}`}>
            <button className={`btn btn-sm ${overview ? "btn-primary" : "btn-ghost"}`} aria-keyshortcuts="Meta+1 Meta+Shift+1" aria-current={overview ? "page" : undefined} onClick={() => navigatePage(true)}>
              <LayoutGrid size={15} /> Overview
            </button>
            <button className={`btn btn-sm ${!overview ? "btn-primary" : "btn-ghost"}`} aria-keyshortcuts="Meta+2 Meta+Shift+2" aria-current={!overview ? "page" : undefined} onClick={() => chooseStage("")}>
              <LayoutDashboard size={15} /> Deal board
              <span className="badge badge-xs" aria-label={`${boardCount} open deals`}>{boardCount}</span>
            </button>
          </nav>
          <main className="mx-auto max-w-[1800px] space-y-7 px-4 py-7 md:px-7 lg:mx-0">
            {overview && !searchActive ? (
              <Suspense fallback={<span className="loading loading-spinner" role="status" aria-label="Loading Overview" />}>
                <InstagramOverview
                  key={instagramAccessRevision}
                  greeting={greeting}
                  onIntegrations={() => setDrawer("integrations")}
                />
              </Suspense>
            ) : (
            <>
              <div className="border-l-4 border-secondary pl-4">
                <h1 className="flex items-center gap-3 font-display text-3xl font-semibold tracking-tight md:text-4xl">
                  <span>Good {greeting} Yandy</span>
                  <img
                    src={greetingCat}
                    alt=""
                    width="96"
                    height="96"
                    className="size-16 shrink-0 object-contain sm:size-24"
                  />
                </h1>
                <ul
                  className="mt-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-base-content/75"
                  aria-label="What's new"
                >
                  <li>
                    <strong>Find a deal.</strong> Press{" "}
                    <kbd className="kbd kbd-xs">⌘K</kbd>, type a brand, then use ↑
                    or ↓ and Enter to open a match.
                  </li>
                  <li>
                    <strong>Filter the board.</strong> Deal type, Platform, and
                    Source show how many deals match each option.
                  </li>
                  <li>
                    <strong>Read Instagram DMs.</strong> Unlock the inbox in
                    Integrations, then open an Instagram deal to see its linked
                    conversation.
                  </li>
                  <li>
                    <strong>Spot your replies.</strong> Messages from your
                    connected Gmail or Instagram account are highlighted in pink.
                  </li>
                </ul>
              </div>
            {load.state === "error" && (
              <div className="alert alert-warning items-start">
                <CircleAlert size={20} />
                <div>
                  <b>Couldn’t load the tracker</b>
                  <p className="text-sm">{load.message}</p>
                </div>
                <button className="btn btn-sm" onClick={refresh}>
                  Try again
                </button>
              </div>
            )}
            {load.warnings?.length > 0 && (
              <div className="alert alert-warning items-start">
                <CircleAlert size={20} />
                <div>
                  <b>
                    {load.warnings.length} follow-up update
                    {load.warnings.length === 1 ? "" : "s"} failed in Notion
                  </b>
                  <p className="text-sm">
                    {load.warnings[0]}
                    {load.warnings.length > 1
                      ? ` (+${load.warnings.length - 1} more)`
                      : ""}
                  </p>
                </div>
                <button className="btn btn-sm" onClick={refresh}>
                  Retry
                </button>
              </div>
            )}
            {searchActive ? (
              loadingDeals ? (
                <div id="search-results" className="mx-auto w-full max-w-4xl">
                  <DealSkeletons />
                </div>
              ) : (
                <SearchResults
                  query={query}
                  results={searchResults}
                  onOpen={setDrawer}
                  ready={Boolean(load.at)}
                />
              )
            ) : (
              <>
                {load.state === "ready" && (
                  <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-primary px-5 py-4 text-primary-content">
                    <div className="rounded-full bg-white/15 p-2">
                      <CalendarDays size={18} />
                    </div>
                    <div className="flex-1">
                      <b>
                        {scoped.filter(isOverdue).length} overdue ·{" "}
                        {scoped.filter(isSoon).length} due this week
                      </b>
                      <p className="text-xs text-primary-content/85">
                        {
                          scoped.filter((d) => d.status === "New - not replied")
                            .length
                        }{" "}
                        new inquiries are waiting for a first reply.
                      </p>
                    </div>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() =>
                        setFilters((previous) => ({
                          ...previous,
                          kpi: previous.kpi === "overdue" ? "" : "overdue",
                        }))
                      }
                    >
                      {filters.kpi === "overdue" ? "Show all" : "Show overdue"}
                    </button>
                  </div>
                )}
                <section
                  className="stats grid w-full grid-flow-row grid-cols-2 gap-3 overflow-visible md:grid-cols-4"
                  aria-label="Summary"
                >
                  {metrics.map((metric) => (
                    <button
                      key={metric.key}
                      type="button"
                      aria-pressed={filters.kpi === metric.key}
                      className={`stat min-h-24 min-w-0 rounded-2xl border-none bg-[var(--tone-bg)] px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${metric.tint} ${filters.kpi === metric.key ? "ring-2 ring-primary" : ""}`}
                      onClick={() => {
                        setFilters((previous) => ({
                          ...previous,
                          kpi: previous.kpi === metric.key ? "" : metric.key,
                        }));
                        changeView({ stage: "" });
                      }}
                    >
                      <span className="stat-figure self-start text-base-content/65">
                        <metric.icon size={17} aria-hidden="true" />
                      </span>
                      <span className="stat-title whitespace-normal text-xs font-medium text-base-content/75">
                        {metric.label}
                      </span>
                      <span className="stat-value font-display text-3xl">
                        {load.at
                          ? scoped.filter(metric.test).length
                          : "–"}
                      </span>
                    </button>
                  ))}
                </section>
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <div className="tabs tabs-box w-fit bg-base-100">
                      <button
                        className={`tab gap-2 ${view.board === "live" ? "tab-active" : ""}`}
                        onClick={() => {
                          changeView({ board: "live", stage: "" });
                          setFilters((previous) => ({ ...previous, kpi: "" }));
                        }}
                      >
                        <Video size={15} /> Livestreams{" "}
                        <span className="badge badge-xs">
                          {
                            deals.filter((d) => d.live && !CLOSED.has(d.status))
                              .length
                          }
                        </span>
                      </button>
                      <button
                        className={`tab gap-2 ${view.board === "ugc" ? "tab-active" : ""}`}
                        onClick={() => {
                          changeView({ board: "ugc", stage: "" });
                          setFilters((previous) => ({ ...previous, kpi: "" }));
                        }}
                      >
                        <Send size={15} /> UGC Videos{" "}
                        <span className="badge badge-xs">
                          {
                            deals.filter(
                              (d) => !d.live && !CLOSED.has(d.status),
                            ).length
                          }
                        </span>
                      </button>
                    </div>
                    <h2 className="section-title mt-4">
                      {view.stage === "@archive"
                        ? "Archive"
                        : selectedGroup?.label ||
                          selectedGroup?.key ||
                          "Deal board"}
                    </h2>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Filter
                      label="Deal type"
                      values={TYPES}
                      counts={loadingDeals ? null : counts.type}
                      selected={filters.type}
                      onChange={(value) =>
                        setFilters({ ...filters, type: value })
                      }
                    />
                    <Filter
                      label="Platform"
                      values={PLATFORMS}
                      counts={loadingDeals ? null : counts.platform}
                      selected={filters.platform}
                      onChange={(value) =>
                        setFilters({ ...filters, platform: value })
                      }
                    />
                    <Filter
                      label="Source"
                      values={SOURCES}
                      counts={loadingDeals ? null : counts.source}
                      selected={filters.source}
                      onChange={(value) =>
                        setFilters({ ...filters, source: value })
                      }
                    />
                    <select
                      className="select select-bordered select-sm w-auto rounded-full"
                      aria-label="Sort cards"
                      value={view.sort}
                      onChange={(e) => changeView({ sort: e.target.value })}
                    >
                      <option value="last">Last activity</option>
                      <option value="deadline">Deadline</option>
                      <option value="edited">Last edited</option>
                      <option value="brand">Brand A–Z</option>
                    </select>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-xs"
                        checked={view.hideEmpty}
                        onChange={(e) =>
                          changeView({ hideEmpty: e.target.checked })
                        }
                      />{" "}
                      Hide empty
                    </label>
                  </div>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-2 lg:hidden">
                  <button
                    className="btn btn-sm"
                    onClick={() => chooseStage("")}
                  >
                    All
                  </button>
                  {groups.map((group) => (
                    <button
                      key={group.key}
                      className={`tone-chip tone-${group.color} shrink-0 ${view.stage === group.key ? "ring-2 ring-primary" : ""}`}
                      aria-pressed={view.stage === group.key}
                      onClick={() => toggleStage(group.key)}
                    >
                      {group.label || group.key}
                    </button>
                  ))}
                  <button
                    className="btn btn-sm"
                    onClick={() => chooseStage("@archive")}
                  >
                    Archive
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => setDrawer("log")}
                  >
                    Writes
                  </button>
                </div>
                <div
                  className={`board-phases ${selectedGroup ? "solo" : ""}`}
                  aria-busy={loadingDeals}
                >
                  {phases.map((phase) => {
                    const phaseGroups = selectedGroup
                      ? [selectedGroup]
                      : groups.filter((group) => group.phase === phase);
                    const phaseCount = visible.filter((deal) =>
                      phaseGroups.some((group) => inGroup(group, deal)),
                    ).length;
                    return (
                      <section key={phase} className="board-phase">
                        <div className="mb-3 flex items-center gap-2">
                          <span className="eyebrow">{phase}</span>
                          {loadingDeals ? (
                            <span
                              className="skeleton h-3 w-10"
                              aria-hidden="true"
                            />
                          ) : (
                            <span className="text-xs text-base-content/40">
                              {phaseCount} deals
                            </span>
                          )}
                        </div>
                        <div className="board-phase-columns flex gap-3 pb-3">
                          {phaseGroups.map((group) => {
                            const items = sortDeals(
                              visible.filter((deal) => inGroup(group, deal)),
                              view.sort,
                            );
                            return (
                              <div
                                key={group.key}
                                className={`board-column ${selectedGroup ? "solo min-w-70 max-w-2xl flex-1" : "w-68 min-w-68"}`}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => drop(event, group)}
                              >
                                <div className="flex items-center gap-2 border-b border-base-300 px-3 py-3">
                                  <span
                                    className={`tone-chip tone-${group.color}`}
                                  >
                                    {group.label || group.key}
                                  </span>
                                  {loadingDeals ? (
                                    <span
                                      className="skeleton h-3 w-4"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <span
                                      className="text-xs tabular-nums text-base-content/55"
                                      aria-label={`${items.length} deals`}
                                    >
                                      {items.length}
                                    </span>
                                  )}
                                </div>
                                <div
                                  className={`board-column-body min-h-24 space-y-2 p-2 ${dragId ? "bg-primary/5" : ""}`}
                                >
                                  {loadingDeals ? (
                                    <DealSkeletons />
                                  ) : (
                                    <>
                                      {group.key === FOLLOW_UP_STATUS && (
                                        <p className="px-2 pt-1 text-[11px] leading-snug text-base-content/45">
                                          Automatically moved here 14 days after
                                          the last recorded activity. Status
                                          saved to Notion.
                                        </p>
                                      )}
                                      {items.length ? (
                                        items.map((deal) => (
                                          <DealCard
                                            key={deal.id}
                                            deal={deal}
                                            onOpen={setDrawer}
                                            onDrag={setDragId}
                                          />
                                        ))
                                      ) : (
                                        <div className="p-5 text-center text-xs text-base-content/35">
                                          Drop a card here
                                        </div>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
                <Calendar
                  deals={calendarDeals}
                  month={month}
                  setMonth={setMonth}
                  onOpen={setDrawer}
                  ready={Boolean(load.at)}
                />
              </>
            )}
            </>
            )}
          </main>
        </div>
      </div>
      {activeDeal && (
        <DealDrawer
          deal={activeDeal}
          body={body}
          bodyError={bodyError}
          onClose={() => setDrawer(null)}
          onSave={save}
          onInstagramUnlocked={instagramUnlocked}
          onLinked={updateLinkedDeal}
        />
      )}
      {drawer === "integrations" && (
        <IntegrationsDrawer
          onInstagramUnlocked={instagramUnlocked}
          onInstagramLocked={refreshInstagramAccess}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer === "log" && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/35"
            onClick={() => setDrawer(null)}
          />
          <aside
            className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto bg-base-100 p-5 shadow-2xl"
            role="dialog"
            aria-label="Notion writes"
          >
            <div className="mb-5 flex items-center justify-between">
              <h2 className="section-title">Notion writes</h2>
              <button
                className="btn btn-ghost btn-square btn-sm"
                onClick={() => setDrawer(null)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="mb-5 text-xs text-base-content/60">
              Every edit is sent to the Collab Tracker page in Notion. Failed
              changes are undone on the board.
            </p>
            {log.length ? (
              log.map((entry) => (
                <div
                  key={entry.id}
                  className="mb-3 rounded-xl border border-base-300 p-3 text-sm"
                >
                  <div className="flex justify-between">
                    <b>{entry.brand}</b>
                    <span
                      className={`badge badge-sm ${entry.status === "Failed" ? "badge-error" : entry.status === "Saved" ? "badge-success" : "badge-warning"}`}
                    >
                      {entry.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs opacity-60">
                    {entry.prop} · {entry.at.toLocaleTimeString("en-SG")} ·{" "}
                    {Array.isArray(entry.value)
                      ? entry.value.join(", ")
                      : typeof entry.value === "object"
                        ? JSON.stringify(entry.value)
                        : entry.value}
                  </p>
                  {entry.error && (
                    <p className="mt-1 text-xs text-error">{entry.error}</p>
                  )}
                </div>
              ))
            ) : (
              <p className="text-sm opacity-50">No changes yet.</p>
            )}
          </aside>
        </>
      )}
      {notice && (
        <div className="toast toast-end z-[60]">
          <div className="alert alert-error max-w-sm text-sm">
            <span>{notice}</span>
            <button
              className="btn btn-ghost btn-xs"
              aria-label="Dismiss"
              onClick={() => setNotice("")}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
