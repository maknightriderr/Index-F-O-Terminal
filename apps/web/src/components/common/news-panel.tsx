'use client';

import React, { useEffect, useState } from 'react';
import type { NewsArticle } from '@fno/shared';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/relative-time';

// News doesn't need the same 15s poll as prices — Google News RSS itself is
// only cached 5 minutes server-side (see apps/server/src/services/news.ts),
// so polling faster than that just re-serves the same cached response.
const NEWS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function NewsPanel({ symbol }: { symbol: string }) {
  const [articles, setArticles] = useState<NewsArticle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setArticles(null);
    setError(null);
    setLoading(true);

    const fetchNews = async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const data = await api.getNews(symbol);
        if (!cancelled) setArticles(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load news');
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    };

    fetchNews();
    const interval = setInterval(() => fetchNews(true), NEWS_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [symbol]);

  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 border-t-2 border-t-indigo-500/50 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] hover:border-gray-700/80 light:hover:border-slate-300 transition-all duration-200 p-4">
      <h3 className="text-xs font-bold text-gray-300 light:text-slate-700 uppercase tracking-wide mb-3">
        Latest News <span className="text-gray-500 light:text-slate-500 font-medium normal-case">— {symbol}</span>
      </h3>

      {loading && (
        <div className="text-xs text-gray-500 light:text-slate-500 py-6 text-center">Loading news…</div>
      )}

      {!loading && error && (
        <div className="text-xs text-red-400 py-4">{error}</div>
      )}

      {!loading && !error && articles && articles.length === 0 && (
        <div className="text-xs text-gray-500 light:text-slate-500 py-6 text-center">No recent news found for {symbol}.</div>
      )}

      {!loading && !error && articles && articles.length > 0 && (
        <div className="space-y-2.5 max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
          {articles.map((a) => (
            <a
              key={a.url}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg px-3 py-2.5 bg-gray-900/40 light:bg-slate-100 hover:bg-gray-900/70 light:hover:bg-slate-200 transition-colors group"
            >
              <div className="text-[12px] font-medium text-gray-200 light:text-slate-800 leading-snug group-hover:text-indigo-300 light:group-hover:text-indigo-700 transition-colors">
                {a.title}
              </div>
              {a.snippet && (
                <p className="text-[10px] text-gray-500 light:text-slate-500 mt-1 leading-snug line-clamp-2">{a.snippet}</p>
              )}
              <div className="flex items-center gap-2 mt-1.5 text-[10px] text-gray-500 light:text-slate-500">
                <span className="font-medium text-gray-400 light:text-slate-600">{a.source}</span>
                <span>·</span>
                <span>{relativeTime(new Date(a.publishedAt).getTime())}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
