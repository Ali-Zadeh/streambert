import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import MediaCard from "../components/MediaCard";
import TrendingCarousel from "../components/TrendingCarousel";
import { PlayIcon, StarIcon } from "../components/Icons";
import { imgUrl, tmdbFetch } from "../utils/api";
import { useRatings, getRatingForItem } from "../utils/useRatings";
import { isRestricted } from "../utils/ageRating";
import { storage } from "../utils/storage";
import { loadHomeLayout, loadHomeViewMode } from "../utils/homeLayout";

/**
 * Extract up to `count` unique, recently watched items from the user's
 * history (within the last 30 days).  Returns newest-first and dedupes
 * by TMDB id + media_type so we don't fire duplicate API calls.
 */
function getRecentHistoryItems(history, count = 5) {
  if (!history || history.length === 0) return [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = history
    .filter((h) => h.watchedAt && h.watchedAt > thirtyDaysAgo)
    .sort((a, b) => b.watchedAt - a.watchedAt);

  const seen = new Set();
  const unique = [];
  for (const item of recent) {
    const key = `${item.media_type || "movie"}_${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= count) break;
  }
  return unique;
}

const SHOW_MORE_STEP = 10;

function useShowMore(baseItems, initialCount, fetchPage) {
  const [count, setCount] = useState(initialCount);
  const [extraItems, setExtraItems] = useState([]);
  const [nextPage, setNextPage] = useState(2);
  const [exhausted, setExhausted] = useState(!fetchPage);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setCount(initialCount);
    setExtraItems([]);
    setNextPage(2);
    setExhausted(!fetchPage);
    setLoading(false);
  }, [baseItems, initialCount, fetchPage]);

  const items = useMemo(() => {
    const seen = new Set();
    return [...baseItems, ...extraItems].filter((item) => {
      const key = `${item.media_type}_${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [baseItems, extraItems]);

  const visible = useMemo(() => items.slice(0, count), [items, count]);

  const showMore = useCallback(async () => {
    const target = count + SHOW_MORE_STEP;
    if (items.length >= target || exhausted) {
      setCount(target);
      return;
    }
    const gen = generation.current;
    setLoading(true);
    try {
      const { results, totalPages } = await fetchPage(nextPage);
      if (gen !== generation.current) return;
      setExtraItems((prev) => [...prev, ...results]);
      setNextPage(nextPage + 1);
      if (results.length === 0 || nextPage >= totalPages) setExhausted(true);
      setCount(target);
    } catch (e) {
      console.warn("Show more fetch failed", e);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [count, items.length, exhausted, fetchPage, nextPage]);

  return {
    visible,
    hasMore: count < items.length || !exhausted,
    loading,
    showMore,
  };
}

export default function HomePage({
  trending,
  trendingTV,
  loading,
  onSelect,
  progress,
  inProgress,
  offline,
  onRetry,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  history,
  apiKey,
}) {
  const hero = trending[0];

  const [recommendedItems, setRecommendedItems] = useState([]);
  const [topRatedItems, setTopRatedItems] = useState([]);

  // Load layout config (order + visibility) once on mount
  const [layout] = useState(() => loadHomeLayout());
  const { order: rowOrder, visible: rowVisible } = layout;

  const [viewMode] = useState(() => loadHomeViewMode());

  const trendingMovieItems = useMemo(
    () => trending.map((i) => ({ ...i, media_type: "movie" })),
    [trending],
  );
  const trendingTVItems = useMemo(
    () => trendingTV.map((i) => ({ ...i, media_type: "tv" })),
    [trendingTV],
  );

  const fetchTrendingPage = useMemo(() => {
    const byType = (type) => (page) =>
      tmdbFetch(`/trending/${type}/week?page=${page}`, apiKey).then((d) => ({
        results: (d.results || []).map((i) => ({ ...i, media_type: type })),
        totalPages: d.total_pages || page,
      }));
    return { movie: byType("movie"), tv: byType("tv") };
  }, [apiKey]);

  const fetchTopRatedPage = useCallback(
    (page) =>
      Promise.all([
        tmdbFetch(`/movie/top_rated?page=${page}`, apiKey),
        tmdbFetch(`/tv/top_rated?page=${page}`, apiKey),
      ]).then(([moviesData, tvData]) => {
        const movies = (moviesData.results || []).map((i) => ({
          ...i,
          media_type: "movie",
        }));
        const tv = (tvData.results || []).map((i) => ({
          ...i,
          media_type: "tv",
        }));
        const results = [];
        const max = Math.max(movies.length, tv.length);
        for (let i = 0; i < max; i++) {
          if (movies[i]) results.push(movies[i]);
          if (tv[i]) results.push(tv[i]);
        }
        return {
          results,
          totalPages: Math.max(
            moviesData.total_pages || page,
            tvData.total_pages || page,
          ),
        };
      }),
    [apiKey],
  );

  const trendingMoviesRow = useShowMore(
    trendingMovieItems,
    10,
    fetchTrendingPage.movie,
  );
  const trendingTVRow = useShowMore(trendingTVItems, 10, fetchTrendingPage.tv);
  const recommendedRow = useShowMore(recommendedItems, 20);
  const topRatedRow = useShowMore(topRatedItems, 16, fetchTopRatedPage);

  // All items for batch ratings fetch
  const allItems = useMemo(
    () => [
      ...inProgress,
      ...trendingMoviesRow.visible,
      ...trendingTVRow.visible,
      ...recommendedRow.visible,
      ...topRatedRow.visible,
    ],
    [
      inProgress,
      trendingMoviesRow.visible,
      trendingTVRow.visible,
      recommendedRow.visible,
      topRatedRow.visible,
    ],
  );

  const { ratingsMap, ageLimitSetting } = useRatings(allItems);

  const getRating = useCallback(
    (item) => getRatingForItem(item, ratingsMap),
    [ratingsMap],
  );
  const itemRestricted = useCallback(
    (item) =>
      isRestricted(getRatingForItem(item, ratingsMap).minAge, ageLimitSetting),
    [ratingsMap, ageLimitSetting],
  );

  // Enrich ratingsMap with restricted flag for carousels
  const enrichedRatingsMap = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(ratingsMap)) {
      out[k] = { ...v, restricted: isRestricted(v.minAge, ageLimitSetting) };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratingsMap, ageLimitSetting]);

  // Filter recommended items that exceed age limit setting
  const filteredRecommendedItems = useMemo(() => {
    return recommendedRow.visible.filter((item) => !itemRestricted(item));
  }, [recommendedRow.visible, itemRestricted]);

  // Fetch personalised recommendations from multiple recent history items
  useEffect(() => {
    if (!apiKey || offline || !history || history.length === 0) return;
    const sources = getRecentHistoryItems(history, 5);
    if (sources.length === 0) return;

    const controller = new AbortController();

    // Build a Set of already-watched TMDB ids for dedup
    const watchedIds = new Set(
      (history || []).map((h) => `${h.media_type || "movie"}_${h.id}`),
    );

    // For each source, try /recommendations first, fall back to /similar
    const fetches = sources.map((source) => {
      const type = source.media_type === "tv" ? "tv" : "movie";
      return tmdbFetch(`/${type}/${source.id}/recommendations`, apiKey, {
        signal: controller.signal,
      })
        .then((data) => {
          const results = (data.results || []).map((i) => ({
            ...i,
            media_type: type,
          }));
          if (results.length > 0) return results;
          // Fall back to /similar if /recommendations returned nothing
          return tmdbFetch(`/${type}/${source.id}/similar`, apiKey, {
            signal: controller.signal,
          }).then((d) =>
            (d.results || []).map((i) => ({ ...i, media_type: type })),
          );
        })
        .catch(() => []);
    });

    Promise.all(fetches)
      .then((arrays) => {
        // Interleave results from each source for variety
        const merged = [];
        const maxLen = Math.max(...arrays.map((a) => a.length));
        for (let i = 0; i < maxLen; i++) {
          for (const arr of arrays) {
            if (arr[i]) merged.push(arr[i]);
          }
        }

        // Deduplicate and filter out already-watched items
        const seen = new Set();
        const deduped = merged.filter((item) => {
          const key = `${item.media_type}_${item.id}`;
          if (seen.has(key) || watchedIds.has(key)) return false;
          seen.add(key);
          return true;
        });

        setRecommendedItems(deduped);
      })
      .catch((e) => {
        if (e.name !== "AbortError")
          console.warn("Recommendations fetch failed", e);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, offline, history?.length]);

  // Fetch top rated movies + TV, merge and shuffle
  useEffect(() => {
    if (!apiKey || offline) return;
    fetchTopRatedPage(1)
      .then(({ results }) => setTopRatedItems(results))
      .catch((e) => console.warn("Top rated fetch failed", e));
  }, [apiKey, offline, fetchTopRatedPage]);

  return (
    <div className="fade-in">
      {/* ── Offline ── */}
      {offline && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "60vh",
            gap: 16,
            color: "var(--text2)",
          }}
        >
          <div style={{ fontSize: 48 }}>📡</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)" }}>
            No internet connection
          </div>
          <div style={{ fontSize: 14, color: "var(--text3)" }}>
            Trending and search require an internet connection. Your downloads
            and library still work offline.
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 8 }}
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      )}

      {!offline && loading && (
        <div className="loader">
          <div className="spinner" />
        </div>
      )}

      {/* ── Hero (always first) ── */}
      {!loading && hero && (
        <div className="hero">
          <div
            className="hero-bg"
            style={{
              backgroundImage: `url(${imgUrl(hero.backdrop_path, "original")})`,
            }}
          />
          <div className="hero-gradient" />
          <div className="hero-content">
            <div className="hero-type">Trending · Movie</div>
            <div className="hero-title">{hero.title || hero.name}</div>
            <div className="hero-meta">
              <span className="hero-rating">
                <StarIcon /> {hero.vote_average?.toFixed(1)}
              </span>
              <span>{hero.release_date?.slice(0, 4)}</span>
            </div>
            <div className="hero-overview">{hero.overview}</div>
            <div className="hero-actions">
              <button
                className="btn btn-primary"
                onClick={() => onSelect(hero)}
              >
                <PlayIcon /> Watch Now
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => onSelect(hero)}
              >
                More Info
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Rows in user-configured order ── */}
      {rowOrder.map((id) => {
        if (!rowVisible[id]) return null;

        if (id === "continue") {
          if (inProgress.length === 0) return null;
          return (
            <div key="continue" className="section">
              <div className="section-title">Continue Watching</div>
              <div className="cards-grid">
                {inProgress.map((item) => {
                  const pk =
                    item.media_type === "movie"
                      ? `movie_${item.id}`
                      : `tv_${item.id}_s${item.season}e${item.episode}`;
                  const r = getRating(item);
                  const restr = itemRestricted(item);
                  return (
                    <MediaCard
                      key={`${item.media_type}_${item.id}`}
                      item={item}
                      onClick={() => onSelect(item)}
                      progress={progress[pk] || 0}
                      watched={watched}
                      onMarkWatched={onMarkWatched}
                      onMarkUnwatched={onMarkUnwatched}
                      ageRating={r.cert}
                      restricted={restr}
                    />
                  );
                })}
              </div>
            </div>
          );
        }

        // Render a section as a flat cards-grid (list view)
        const renderList = (key, title, titleHighlight, items, row) => {
          if (!items || items.length === 0) return null;
          return (
            <div key={key} className="section">
              <div className="section-title">
                {titleHighlight ? (
                  <>
                    {title}&nbsp;
                    <span style={{ color: "var(--red)" }}>
                      {titleHighlight}
                    </span>
                  </>
                ) : (
                  title
                )}
              </div>
              <div className="cards-grid">
                {items.map((item) => {
                  const type = item.media_type === "tv" ? "tv" : "movie";
                  const rk = `${type}_${item.id}`;
                  const rd = enrichedRatingsMap[rk] || {};
                  return (
                    <MediaCard
                      key={`${item.media_type}_${item.id}`}
                      item={item}
                      onClick={() => onSelect(item)}
                      progress={0}
                      watched={watched}
                      onMarkWatched={onMarkWatched}
                      onMarkUnwatched={onMarkUnwatched}
                      ageRating={rd.cert}
                      restricted={rd.restricted}
                    />
                  );
                })}
              </div>
              {row.hasMore && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    marginTop: 16,
                  }}
                >
                  <button
                    className="btn btn-secondary"
                    onClick={row.showMore}
                    disabled={row.loading}
                  >
                    {row.loading ? "Loading…" : "Show more"}
                  </button>
                </div>
              )}
            </div>
          );
        };

        if (id === "recommended") {
          if (filteredRecommendedItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "recommended",
              "Recommended for You",
              null,
              filteredRecommendedItems,
              recommendedRow,
            );
          return (
            <TrendingCarousel
              key="recommended"
              items={filteredRecommendedItems}
              title="Recommended for You"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        if (id === "trendingMovies") {
          if (trendingMoviesRow.visible.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "trendingMovies",
              "Trending Movies",
              null,
              trendingMoviesRow.visible,
              trendingMoviesRow,
            );
          return (
            <TrendingCarousel
              key="trendingMovies"
              items={trendingMoviesRow.visible}
              title="Trending Movies"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        if (id === "trendingTV") {
          if (trendingTVRow.visible.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "trendingTV",
              "Trending Series",
              null,
              trendingTVRow.visible,
              trendingTVRow,
            );
          return (
            <TrendingCarousel
              key="trendingTV"
              items={trendingTVRow.visible}
              title="Trending Series"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        if (id === "topRated") {
          if (topRatedItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "topRated",
              "Top Rated",
              null,
              topRatedRow.visible,
              topRatedRow,
            );
          return (
            <TrendingCarousel
              key="topRated"
              items={topRatedRow.visible}
              title="Top Rated"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
