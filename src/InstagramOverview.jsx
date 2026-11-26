import { useEffect, useId, useState } from "react";
import { CalendarDays, ExternalLink, Eye, Heart, Image, Instagram, LayoutGrid, RefreshCw, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, Rectangle, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import overviewCat from "./assets/overview-cat.png";
import { api } from "./model.js";

const numbers = new Intl.NumberFormat("en-SG", { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("en-SG", { notation: "compact", maximumFractionDigits: 1 });
const dates = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", timeZone: "UTC" });
const postDates = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const formatDate = (day) => dates.format(new Date(day));
const panel = "min-w-0 rounded-2xl border border-base-300 bg-base-100 p-5";
const duration = (value) => value == null ? null : `${numbers.format(value / 1000)} s`;
const percent = (value) => value == null ? null : `${numbers.format(value)}%`;
const mean = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;

function MetricList({ entries }) {
  const listId = useId();
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-2">
      {entries.map(([label, value, description], index) => {
        const tooltipId = `${listId}-metric-${index}`;
        const amount = value == null
          ? <><span aria-hidden="true">—</span><span className="sr-only">Unavailable</span></>
          : typeof value === "number" ? numbers.format(value) : value;
        return (
          <div key={label} className="flex items-baseline gap-1.5">
            <dt className="text-xs text-base-content/75">{label}</dt>
            <dd className="text-sm font-semibold tabular-nums">
              {description ? (
                <span className={`tooltip tooltip-primary ${index === 0 ? "tooltip-start" : ""}`}>
                  <span id={tooltipId} className="tooltip-content max-w-40" role="tooltip">{description}</span>
                  <span tabIndex={0} aria-describedby={tooltipId} className="cursor-help rounded-sm focus-visible:outline-2 focus-visible:outline-primary">{amount}</span>
                </span>
              ) : amount}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function TrendChart({ values, showEveryLabel = false, line = false }) {
  const Chart = line ? LineChart : BarChart;
  const hasLosses = values.some(({ value }) => value < 0);
  const format = (value) => value == null ? "Unavailable" : numbers.format(value);
  const axisStyle = { fill: "var(--color-base-content)", fontSize: 11 };
  return (
    <div className="relative h-52 min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <Chart data={values} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
          <CartesianGrid vertical={false} stroke="var(--color-base-300)" strokeDasharray="3 4" />
          <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: "var(--color-base-300)" }}
            minTickGap={8} interval={showEveryLabel ? 0 : "preserveEnd"} />
          <YAxis width={44} allowDecimals={false} tick={axisStyle} tickLine={false} axisLine={false}
            tickFormatter={(value) => compact.format(value)} />
          {hasLosses && <ReferenceLine y={0} stroke="var(--color-base-content)" strokeOpacity={0.4} />}
          <Tooltip cursor={{ fill: "var(--color-base-200)", opacity: 0.65 }} content={({ active, payload }) => {
            const point = payload?.[0]?.payload;
            return active && point ? (
              <div className="rounded-lg border border-base-300 bg-base-100 px-3 py-2 text-xs shadow-md">
                <p className="font-semibold">{point.fullLabel || point.label}</p>
                <p>{format(point.value)} {point.detail}</p>
              </div>
            ) : null;
          }} />
          {line ? (
            <Line type="linear" dataKey="value" stroke="var(--color-primary)" strokeWidth={2.5}
              dot={{ r: 3, fill: "var(--color-primary)" }} activeDot={{ r: 5 }}
              connectNulls={false} isAnimationActive={false} />
          ) : (
            <Bar dataKey="value" maxBarSize={34} isAnimationActive={false}
              shape={(props) => {
                const negative = props.height < 0;
                return <Rectangle {...props} fill={negative || props.payload?.highlight ? "var(--color-secondary)" : "var(--color-primary)"}
                  radius={negative ? [0, 0, 4, 4] : [4, 4, 0, 0]} />;
              }} />
          )}
        </Chart>
      </ResponsiveContainer>
      <ul className="sr-only">
        {values.map(({ label, fullLabel, value, detail, highlight }) => (
          <li key={label}>{fullLabel || label} · {format(value)} {detail}{highlight && " · Highest total"}</li>
        ))}
      </ul>
    </div>
  );
}

function WeeklyTrends({ weekly, days, trendInterval, setTrendInterval }) {
  const [metric, setMetric] = useState("engagement");
  const [dailyResults, setDailyResults] = useState({});
  const hasDailyOption = metric === "engagement" || metric === "views";
  const daily = hasDailyOption && trendInterval === "daily";
  const dailyResult = dailyResults[metric];
  useEffect(() => {
    if (!daily || dailyResult) return;
    const controller = new AbortController();
    api(`/meta/analytics/daily-${metric}?days=${days}`, { signal: controller.signal })
      .then(({ daily: values }) => {
        if (!controller.signal.aborted) setDailyResults((results) => ({ ...results, [metric]: { values } }));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setDailyResults((results) => ({ ...results, [metric]: { error: error.message } }));
      });
    return () => controller.abort();
  }, [daily, dailyResult, days, metric]);

  const choices = [
    ["engagement", "Engagement"], ["views", "Views"], ["reach", "Reach"], ["accountsEngaged", "Accounts engaged"],
    ["interactions", "Interactions"], ["profileLinkTaps", "Profile link taps"], ["follows", "Follows"],
    ["unfollows", "Unfollows"], ["netFollowers", "Net followers"], ["posts", "Posts published"],
  ];
  const label = choices.find(([key]) => key === metric)[1];
  const values = daily
    ? (dailyResult?.values ?? []).map(day => ({ label: formatDate(day.date), value: day[metric], detail: label.toLowerCase() }))
    : weekly.map(week => ({
      label: formatDate(week.start), value: week[metric],
      detail: `${label.toLowerCase()} through ${formatDate(week.end)}`,
    }));
  return (
    <section className={panel}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-semibold">
          {daily ? `${label} by day` : metric === "views" && weekly.length === 1 ? "Content views" : `${label} by week`}
        </h2>
        <select className="select select-sm w-auto" aria-label="Weekly trend metric" value={metric} onChange={(event) => setMetric(event.target.value)}>
          {choices.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select>
      </div>
      {hasDailyOption && (
        <div className="join mb-3" role="group" aria-label={`${label} interval`}>
          {[["daily", "Daily"], ["weekly", "Weekly"]].map(([interval, name]) => (
            <button key={interval} type="button" className={`btn btn-sm join-item ${trendInterval === interval ? "btn-primary" : ""}`}
              aria-pressed={trendInterval === interval} onClick={() => setTrendInterval(interval)}>{name}</button>
          ))}
        </div>
      )}
      <p className="mb-4 text-xs text-base-content/75">
        {daily ? `${metric === "engagement" ? "Likes, comments, shares and saves" : "Views"} per complete day (UTC).`
          : metric === "engagement" ? "Account-wide likes, comments, shares and saves per week (UTC)."
          : "7-day periods. The first period may be shorter."}
      </p>
      {daily && !dailyResult ? (
        <span className="loading loading-spinner" role="status" aria-label={`Loading daily ${label.toLowerCase()}`} />
      ) : daily && dailyResult.error ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
          <span>{dailyResult.error}</span>
          <button className="btn btn-sm" onClick={() => setDailyResults((results) => ({ ...results, [metric]: undefined }))}>Try again</button>
        </div>
      ) : values.some(({ value }) => value != null) ? (
        <div className="relative overflow-x-auto pb-1" tabIndex={0} aria-label={`${label} by ${daily ? "day" : "week"}`}>
          <div style={{ minWidth: values.length * 54 }}>
            <TrendChart values={values} line={metric === "engagement"} />
          </div>
        </div>
      ) : (
        <p className="rounded-xl bg-base-200/55 p-4 text-sm">{label} data is unavailable for this range.</p>
      )}
    </section>
  );
}

const demographicColors = [
  "var(--color-primary)", "var(--color-secondary)", "#638467", "#c78b53",
  "#9277af", "#4a8f99", "#b2556d", "#9f9649",
];
const countries = new Intl.DisplayNames(["en-SG"], { type: "region" });
const genderNames = { F: "Women", M: "Men", U: "Unspecified" };

function DemographicPie({ title, dimension, values }) {
  const total = values.reduce((sum, point) => sum + point.value, 0);
  const data = values.map(({ label, value }, index) => ({
    label,
    name: dimension === "gender" ? genderNames[label] || label
      : dimension === "country" && /^[A-Z]{2}$/.test(label) ? countries.of(label) || label : label,
    value,
    fill: demographicColors[index] ?? `hsl(${Math.round(index * 137.5) % 360} 42% ${index % 2 ? 43 : 64}%)`,
    share: total ? percent(value / total * 100) : null,
  }));
  return (
    <details name="follower-demographics" className="collapse collapse-arrow min-w-0 self-start rounded-xl border border-base-300 bg-base-200/45">
      <summary className="collapse-title text-sm font-semibold">{title}</summary>
      <div className="collapse-content">
        {total > 0 && (
          <div className="mx-auto h-39 w-full max-w-56">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <PieChart aria-label={`Followers by ${title.toLowerCase()}`}>
                <Pie data={data} dataKey="value" nameKey="name" outerRadius="90%" stroke="var(--color-base-100)" strokeWidth={1} isAnimationActive={false} />
                <Tooltip formatter={(value, name, item) => [`${numbers.format(value)} (${item.payload.share})`, name]} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
        {data.length ? (
          <ul className={`mt-3 grid gap-x-4 gap-y-1.5 ${data.length > 8 ? "sm:grid-cols-2" : ""}`}>
            {data.map(({ label, name, value, share, fill }) => (
              <li key={label} className="flex min-w-0 items-baseline gap-2 text-xs">
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: fill }} aria-hidden="true" />
                <span className="min-w-0 flex-1 wrap-anywhere">{name}</span>
                <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums">{numbers.format(value)}{share && ` · ${share}`}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-xs text-base-content/75">Unavailable</p>}
      </div>
    </details>
  );
}

function AudienceDemographics({ groups }) {
  const dimensions = [["age", "Age"], ["gender", "Gender"], ["country", "Country"], ["city", "City"]];
  return (
    <section className={panel} aria-label="Follower demographics">
      <h2 className="font-display text-xl font-semibold">Follower demographics</h2>
      <p className="mb-4 mt-1 text-xs text-base-content/75">Percentages use the counts Meta returned for each group this month.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {dimensions.map(([key, title]) => (
          <DemographicPie key={key} title={title} dimension={key} values={groups[key] ?? []} />
        ))}
      </div>
    </section>
  );
}

function Stories({ items }) {
  const actionLabels = {
    SWIPE_FORWARD: "Next story", TAP_BACK: "Back", TAP_EXIT: "Exits", TAP_FORWARD: "Forward",
  };
  return (
    <section className={panel}>
      <h2 className="font-display text-xl font-semibold">Story analytics</h2>
      <p className="mb-4 mt-1 text-xs text-base-content/75">Meta provides Story Insights for 24 hours after publishing.</p>
      {items?.length ? (
        <ul className="divide-y divide-base-300 rounded-xl border border-base-300">
          {items.map((story) => (
            <li key={story.id} className="flex min-w-0 gap-3 p-3">
              {story.image && <img src={story.image} alt="" loading="lazy" className="size-14 shrink-0 rounded-lg object-cover" />}
              <div className="min-w-0 flex-1 space-y-2">
                <time dateTime={story.date} className="block text-sm font-semibold">
                  {new Date(story.date).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" })} SGT
                </time>
                <MetricList entries={[
                  ["Views", story.insights?.views], ["Reach", story.insights?.reach],
                  ["Replies", story.insights?.replies], ["Shares", story.insights?.shares],
                  ["Navigation actions", story.insights?.navigation],
                  ...Object.entries(actionLabels).map(([key, label]) => [label, story.actions?.find(action => action.label === key)?.value]),
                ]} />
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="rounded-xl bg-base-200/55 p-4 text-sm">{items === null ? "Meta couldn’t load active Stories." : "No active Stories."}</p>}
    </section>
  );
}

function FeaturedPosts({ posts }) {
  const [mode, setMode] = useState(() => posts.top.length ? "top" : "recent");
  const items = posts[mode];
  const ranked = mode === "top";
  const counts = items.flatMap(post => post.engagements == null ? [] : [post.engagements]);
  const rates = items.flatMap(post => post.engagementRate == null ? [] : [post.engagementRate]);
  return (
    <section className={panel} aria-labelledby="featured-posts">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="featured-posts" className="font-display text-xl font-semibold">Post performance</h2>
          <p className="mt-1 text-xs text-base-content/75">
            {ranked ? "Top 15 across your account, ranked by lifetime engagements" : "Your latest 15 posts with lifetime metrics"}
          </p>
        </div>
        <div className="join" role="group" aria-label="Post order">
          {[["top", "Top posts"], ["recent", "Recent posts"]].map(([key, label]) => (
            <button key={key} type="button" className={`btn btn-sm join-item ${mode === key ? "btn-primary" : ""}`} aria-pressed={mode === key} onClick={() => setMode(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-base-content/75">
        Engagements are likes, comments, shares and saves. The rate is engagements ÷ reach. Meta doesn’t provide link clicks for feed posts or Reels.
      </p>
      {items.length > 0 && (
        <div className="mb-4 rounded-xl bg-base-200/55 px-3 py-2">
          <MetricList entries={[
            ["Average engagements per post", mean(counts)],
            ["Average engagement rate", percent(mean(rates))],
          ]} />
          <p className="mt-1 text-xs text-base-content/75">
            Engagement counts for {counts.length} of {items.length} posts · Rates for {rates.length}
          </p>
        </div>
      )}
      {items.length ? (
        <ol className="divide-y divide-base-300 rounded-xl border border-base-300" aria-label={ranked ? "Ranked Instagram posts" : "Recent Instagram posts"}>
          {items.map((post, index) => (
            <li key={post.id} className="flex min-w-0 items-start gap-3 p-3 sm:items-center">
              {ranked && <span className="w-5 shrink-0 pt-1 text-right text-xs font-semibold tabular-nums text-base-content/75 sm:pt-0">{index + 1}</span>}
              <div className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-base-200/50 sm:size-16">
                {post.image ? (
                  <img src={post.image} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
                ) : (
                  <Image size={24} className="text-base-content/50" aria-hidden="true" />
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="line-clamp-2 break-words text-sm font-medium">{post.caption || (post.type === "VIDEO" ? "Video" : "Instagram post")}</p>
                    <time dateTime={post.date} className="block text-xs text-base-content/75">{postDates.format(new Date(post.date))}</time>
                  </div>
                  {post.url && (
                    <a href={post.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-square btn-sm shrink-0" aria-label="Open post on Instagram">
                      <ExternalLink size={15} />
                    </a>
                  )}
                </div>
                <MetricList entries={[
                    ["Engagements", post.engagements], ["Engagement rate", percent(post.engagementRate)],
                    ["Likes", post.likes], ["Comments", post.comments],
                    ["Views", post.insights?.views], ["Reach", post.reach],
                    ["Saves", post.saved], ["Shares", post.shares],
                    ["Reposts", post.insights?.reposts], ["Interactions", post.insights?.total_interactions],
                    ...(post.reel ? [
                      ["Avg. watch time", duration(post.insights?.ig_reels_avg_watch_time)],
                      ["Total watch time", duration(post.insights?.ig_reels_video_view_total_time)],
                      ["Skip rate", percent(post.insights?.reels_skip_rate)],
                    ] : []),
                ]} />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-xl bg-base-200/55 p-4 text-sm">{ranked ? "No posts with engagement counts are available." : "No recent posts available."}</p>
      )}
    </section>
  );
}

function PublishingReachChart({ title, buckets }) {
  const peak = Math.max(0, ...buckets.map(bucket => bucket.reach));
  const peaks = buckets.filter(bucket => peak > 0 && bucket.reach === peak);
  return (
    <div className="min-w-0 rounded-xl border border-base-300 bg-base-200/35 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {peaks.length > 0 && (
          <span className="badge badge-secondary badge-sm h-auto py-0.5">
            Peak · {peaks.map(bucket => bucket.fullLabel || bucket.label).join(", ")}
          </span>
        )}
      </div>
      <TrendChart showEveryLabel values={buckets.map(bucket => ({
        label: bucket.label,
        fullLabel: bucket.fullLabel,
        value: bucket.reach,
        detail: `reach across ${bucket.posts} ${bucket.posts === 1 ? "post" : "posts"}`,
        highlight: peak > 0 && bucket.reach === peak,
      }))} />
    </div>
  );
}

function HighestReachPosts({ publishing }) {
  const hasReachData = publishing.weekdays.some(bucket => bucket.posts > 0);
  const hourLabel = (hour) => String(hour).padStart(2, "0");
  const windows = publishing.windows.map(bucket => ({
    ...bucket,
    label: `${hourLabel(bucket.startHour)}–${hourLabel(bucket.endHour)}`,
    fullLabel: `${hourLabel(bucket.startHour)}:00–${hourLabel(bucket.endHour)}:00`,
  }));
  return (
    <section className={`${panel} @container`} aria-labelledby="highest-reach-posts">
      <h2 id="highest-reach-posts" className="font-display text-xl font-semibold">Highest-reach posts</h2>
      <p className="mb-4 mt-1 text-xs text-base-content/75">
        Lifetime post reach grouped by when posts were published (SGT). An account reached by multiple posts counts once per post.
      </p>
      {hasReachData ? (
        <div className="grid gap-3 @xl:grid-cols-2">
          <PublishingReachChart title="Total reach by publish day" buckets={publishing.weekdays} />
          <PublishingReachChart title="Total reach by publish time" buckets={windows} />
        </div>
      ) : <p className="rounded-xl bg-base-200/55 p-4 text-sm">Meta hasn’t returned any post reach figures.</p>}
    </section>
  );
}

function Analytics({ data, days, trendInterval, setTrendInterval }) {
  const { username, followers, following, followerChange30Days, views, postCount, engagement, measuredPosts, weekly } = data;
  const account = data.accountMetrics;
  const shorterAccountRange = account?.uniqueAccountDays < days;
  const rangeSuffix = shorterAccountRange ? ` (last ${account.uniqueAccountDays} days)` : "";
  const metrics = [
    { title: "Views", value: views, detail: "Times your content was viewed", icon: Eye, tone: "pink" },
    {
      title: "Average engagement rate",
      value: engagement == null ? null : `${numbers.format(engagement)}%`,
      detail: `Mean of per-post rates · ${measuredPosts} of ${postCount} posts measured`,
      icon: Heart, tone: "blue",
    },
    {
      title: "Follower change",
      value: followerChange30Days == null ? null : `${followerChange30Days > 0 ? "+" : ""}${numbers.format(followerChange30Days)}`,
      detail: "Net change reported by Meta over the last 30 days", icon: Users, tone: "purple",
    },
    { title: "Posts published", value: postCount, detail: "Feed posts and reels", icon: LayoutGrid, tone: "brown" },
  ];
  const fullWeeks = weekly.filter(({ start, end }) => Date.parse(end) - Date.parse(start) === 6 * 86_400_000);
  const activeWeeks = fullWeeks.filter((week) => week.posts > 0).length;
  const consistency = Math.round(activeWeeks / fullWeeks.length * 100);

  return (
    <>
      {data.insightsPermissionDenied && (
        <div className="alert alert-warning text-sm" role="status">
          <span className="min-w-0 wrap-anywhere">To show views, follower growth, and more post metrics, enable <code>instagram_manage_insights</code> in Meta Unified Login and update the server’s access token.</span>
        </div>
      )}
      <div className="stats grid w-full grid-flow-row grid-cols-2 gap-3 overflow-visible xl:grid-cols-4" aria-label="Instagram metrics">
        {metrics.map(({ title, value, detail, icon: Icon, tone }) => (
          <div key={title} className={`stat flex flex-col gap-2 rounded-2xl bg-[var(--tone-bg)] px-4 py-4 sm:px-5 tone-${tone}`}>
            <div className="flex items-start justify-between gap-2 text-sm font-medium">
              <span>{title}</span><Icon size={17} className="mt-0.5 shrink-0 text-[var(--tone)]" aria-hidden="true" />
            </div>
            <div className="font-display text-3xl font-semibold tabular-nums">
              {value == null ? <><span aria-hidden="true">—</span><span className="sr-only">Unavailable</span></> : typeof value === "number" ? numbers.format(value) : value}
            </div>
            <p className="text-xs leading-relaxed text-base-content/75">{detail}</p>
          </div>
        ))}
      </div>
      <section className={panel} aria-label="Account activity">
        <h2 className="font-display text-xl font-semibold">Account activity</h2>
        <p className="mb-4 mt-1 text-xs text-base-content/75">
          {shorterAccountRange
            ? "Meta provides unique account totals for up to 30 days. Other metrics use the selected range."
            : "For the selected date range"}
        </p>
        <MetricList entries={[
          [`Reach${rangeSuffix}`, account?.reach, "Unique accounts that saw your content."],
          [`Accounts engaged${rangeSuffix}`, account?.accountsEngaged, "Unique accounts that interacted with your content."],
          ["Total interactions", account?.interactions, "Actions on your content, such as likes, comments, saves, shares and replies."],
          ["Profile link taps", account?.profileLinkTaps, "Times someone tapped a link or contact button on your profile."],
          ["Follows", account?.follows, "Accounts that started following you."],
          ["Unfollows", account?.unfollows, "Accounts that unfollowed you or left Instagram."],
        ]} />
      </section>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <WeeklyTrends weekly={weekly} days={days} trendInterval={trendInterval} setTrendInterval={setTrendInterval} />
        <HighestReachPosts publishing={data.reachByPublishingTime} />
        <section className={panel}>
          <h2 className="font-display text-xl font-semibold">Posting consistency</h2>
          <p className="mb-3 mt-1 text-xs text-base-content/75">Full weeks with at least one post</p>
          <p className="mb-2 font-display text-3xl font-semibold">{consistency}%</p>
          <progress className="progress progress-secondary w-full" aria-label="Posting consistency" value={activeWeeks} max={fullWeeks.length} />
          <p className="mt-1 text-sm">{activeWeeks} of {fullWeeks.length} weeks active</p>
        </section>
        <section className={panel}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-xl font-semibold">Audience today</h2>
            {username && <span className="text-sm text-base-content/75">@{username}</span>}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-4">
            <div><dt className="text-sm">Followers</dt><dd className="mt-1 font-display text-2xl font-semibold">{followers == null ? "Unavailable" : numbers.format(followers)}</dd></div>
            <div><dt className="text-sm">Following</dt><dd className="mt-1 font-display text-2xl font-semibold">{following == null ? "Unavailable" : numbers.format(following)}</dd></div>
          </dl>
        </section>
      </div>
      <AudienceDemographics groups={data.demographics || {}} />
      <FeaturedPosts posts={data.featuredPosts} />
      <Stories items={data.stories} />
    </>
  );
}

export default function InstagramOverview({ greeting, onIntegrations }) {
  const [days, setDays] = useState(30);
  const [trendInterval, setTrendInterval] = useState("weekly");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    api(`/meta/analytics?days=${days}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ state: "ready", ...data });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setResult({ state: "error", message: error.message });
      });
    return () => controller.abort();
  }, [days, attempt]);

  const selectDays = (next) => {
    if (next === days) return;
    setResult({ state: "loading" });
    setDays(next);
  };
  const retry = () => {
    setResult({ state: "loading" });
    setAttempt((value) => value + 1);
  };

  return (
    <section className="space-y-5" aria-label="Social analytics overview">
      <header className="border-l-4 border-secondary pl-4">
        <h1 className="flex items-center gap-3 font-display text-3xl font-semibold tracking-tight md:text-4xl">
          <span>Good {greeting} Yandy</span>
          <img src={overviewCat} alt="" width="96" height="96" className="size-16 shrink-0 object-contain sm:size-24" />
        </h1>
      </header>
      <section id="instagram-analytics" className="space-y-5" aria-labelledby="instagram-analytics-title" aria-busy={result.state === "loading"}>
        <h2 id="instagram-analytics-title" className="flex items-center gap-2 font-display text-xl font-semibold"><Instagram size={17} aria-hidden="true" /> Instagram analytics</h2>
        <div className="flex flex-wrap items-center gap-3">
          <div className="join" role="group" aria-label="Analytics date range">
            {[7, 30, 90].map((range) => (
              <button key={range} className={`btn btn-sm join-item ${days === range ? "btn-primary" : ""}`} aria-pressed={days === range} onClick={() => selectDays(range)}>
                {range} days
              </button>
            ))}
          </div>
          {result.analytics && (
            <span className="flex items-center gap-2 text-xs text-base-content/75">
              <CalendarDays size={15} aria-hidden="true" /> {formatDate(result.analytics.start)} – {formatDate(result.analytics.end)} UTC
            </span>
          )}
        </div>
        {result.state === "loading" && (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" role="status">
            <span className="sr-only">Loading Instagram analytics</span>
            {Array.from({ length: 4 }, (_, index) => <div key={index} className="skeleton h-28 rounded-2xl" aria-hidden="true" />)}
          </div>
        )}
        {result.state === "error" && (
          <div className="alert alert-warning">
            <span>{result.message}</span>
            <button className="btn btn-sm" onClick={retry}><RefreshCw size={15} /> Try again</button>
          </div>
        )}
        {result.state === "ready" && (result.analytics ? (
          <Analytics data={result.analytics} days={days} trendInterval={trendInterval} setTrendInterval={setTrendInterval} />
        ) : (
          <div className={panel}>
            <h2 className="font-display text-xl font-semibold">{result.configured ? "Unlock Instagram" : "Connect Instagram"}</h2>
            <p className="mb-4 mt-2 text-sm">Open Integrations to view analytics for the connected Instagram account.</p>
            <button className="btn btn-primary btn-sm" onClick={onIntegrations}>Open Integrations</button>
          </div>
        ))}
      </section>
    </section>
  );
}
