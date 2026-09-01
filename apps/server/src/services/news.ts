// ============================================================
// NEWS INTELLIGENCE SERVICE
// ============================================================
// Fetches stock/index-specific news from Google News RSS feeds
// (free, no API key, no rate limits). Results are cached in Redis
// for NEWS_CACHE_TTL_SECONDS so repeated polls from the same
// asset workspace tab don't fire new HTTP requests on every tick.
//
// The "NSE:" prefix in search queries helps Google News prioritize
// Indian stock market results over generic mentions of the same
// company name (e.g. "TCS" → Tata Consultancy Services, not a
// US-based or UK-based "TCS" result).
// ============================================================

import type { NewsArticle } from '@fno/shared';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

const NEWS_CACHE_TTL_SECONDS = 300; // 5 minutes — news doesn't need sub-minute freshness
const MAX_ARTICLES = 15;
const GOOGLE_NEWS_RSS_BASE = 'https://news.google.com/rss/search';
const FETCH_TIMEOUT_MS = 8000;

// Well-known index aliases — Google News understands "NIFTY 50" better
// than just "NIFTY", and "SENSEX" better than "BSE SENSEX".
const INDEX_SEARCH_MAP: Record<string, string> = {
  NIFTY: 'NIFTY 50 NSE',
  BANKNIFTY: 'Bank NIFTY NSE',
  FINNIFTY: 'Fin NIFTY NSE',
  MIDCPNIFTY: 'Midcap NIFTY NSE',
  SENSEX: 'BSE SENSEX',
  BANKEX: 'BSE BANKEX',
  INDIAVIX: 'India VIX',
};

// Company names for major F&O stocks — Google News finds more relevant
// results with the full company name than just the ticker symbol.
const STOCK_NAME_MAP: Record<string, string> = {
  RELIANCE: 'Reliance Industries',
  TCS: 'TCS Tata Consultancy',
  HDFCBANK: 'HDFC Bank',
  INFY: 'Infosys',
  ICICIBANK: 'ICICI Bank',
  HINDUNILVR: 'Hindustan Unilever',
  SBIN: 'State Bank of India SBI',
  BHARTIARTL: 'Bharti Airtel',
  KOTAKBANK: 'Kotak Mahindra Bank',
  ITC: 'ITC Limited',
  LT: 'Larsen Toubro',
  AXISBANK: 'Axis Bank',
  BAJFINANCE: 'Bajaj Finance',
  MARUTI: 'Maruti Suzuki',
  SUNPHARMA: 'Sun Pharma',
  TATAMOTORS: 'Tata Motors',
  TATASTEEL: 'Tata Steel',
  WIPRO: 'Wipro',
  HCLTECH: 'HCL Technologies',
  ADANIENT: 'Adani Enterprises',
  ADANIPORTS: 'Adani Ports',
  NTPC: 'NTPC Limited',
  POWERGRID: 'Power Grid Corporation',
  ONGC: 'ONGC Oil Natural Gas',
  COALINDIA: 'Coal India',
  DRREDDY: 'Dr Reddys',
  CIPLA: 'Cipla',
  DIVISLAB: 'Divis Laboratories',
  TECHM: 'Tech Mahindra',
  M_M: 'Mahindra Mahindra',
  BAJAJFINSV: 'Bajaj Finserv',
  NESTLEIND: 'Nestle India',
  ULTRACEMCO: 'UltraTech Cement',
  HINDALCO: 'Hindalco Industries',
  JSWSTEEL: 'JSW Steel',
  GRASIM: 'Grasim Industries',
  BRITANNIA: 'Britannia Industries',
  INDUSINDBK: 'IndusInd Bank',
  EICHERMOT: 'Eicher Motors',
  APOLLOHOSP: 'Apollo Hospitals',
  HEROMOTOCO: 'Hero MotoCorp',
  DLF: 'DLF Limited',
  VEDL: 'Vedanta Limited',
};

export async function getNewsForSymbol(symbol: string): Promise<NewsArticle[]> {
  const cacheKey = `news:${symbol}`;
  return cached(cacheKey, NEWS_CACHE_TTL_SECONDS, () => fetchNewsUncached(symbol));
}

async function fetchNewsUncached(symbol: string): Promise<NewsArticle[]> {
  const searchTerm = buildSearchQuery(symbol);

  try {
    const url = `${GOOGLE_NEWS_RSS_BASE}?q=${encodeURIComponent(searchTerm)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'FnO-Terminal/1.0' },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn({ status: response.status, symbol }, 'Google News RSS fetch failed');
      return [];
    }

    const xml = await response.text();
    // Google News RSS order is relevance-weighted, not strictly
    // chronological — sort newest-first before capping so the freshest
    // articles survive the MAX_ARTICLES cut instead of whatever the feed
    // happened to list first.
    return parseRssXml(xml)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, MAX_ARTICLES);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      logger.warn({ symbol }, 'Google News RSS fetch timed out');
    } else {
      logger.warn({ error: err.message, symbol }, 'News fetch failed');
    }
    return [];
  }
}

function buildSearchQuery(symbol: string): string {
  // Check index aliases first
  if (INDEX_SEARCH_MAP[symbol]) return INDEX_SEARCH_MAP[symbol];

  // Check stock name map
  const sanitized = symbol.replace(/[&-]/g, '_');
  if (STOCK_NAME_MAP[sanitized] || STOCK_NAME_MAP[symbol]) {
    return `${STOCK_NAME_MAP[sanitized] || STOCK_NAME_MAP[symbol]} stock NSE`;
  }

  // Fallback: use symbol name + NSE context
  return `${symbol} stock NSE share price`;
}

/**
 * Minimal RSS XML parser — Google News RSS is well-structured XML with
 * <item> elements containing <title>, <link>, <pubDate>, <source>,
 * and <description>. No need for a full XML parser dependency.
 */
function parseRssXml(xml: string): NewsArticle[] {
  const articles: NewsArticle[] = [];
  const items = xml.split('<item>').slice(1); // skip the channel header

  for (const item of items) {
    const title = extractTag(item, 'title');
    const url = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const source = extractTag(item, 'source');
    const description = extractTag(item, 'description');

    if (!title || !url) continue;

    // Google News titles often end with " - Source Name"; strip that
    // since we show source separately.
    const cleanTitle = title.replace(/ - [^-]+$/, '').trim();

    // The <description> Google News RSS gives us is HTML *entity-encoded*
    // (e.g. "&lt;a href=...&gt;Title&lt;/a&gt;"), not literal markup — so
    // entities must be decoded FIRST and the now-literal tags stripped
    // SECOND. Doing it in the other order (as this used to) is a no-op on
    // the tag-strip (no literal '<' exists yet to match) and then the
    // entity-decode step turns "&lt;a href=...&gt;" right back into a
    // literal "<a href=...>" tag, so raw HTML leaked straight into the
    // snippet shown to the user instead of being stripped.
    const snippet = description
      ? decodeHtmlEntities(description)
          .replace(/<[^>]*>/g, ' ') // strip now-literal HTML tags (space, not '', so adjacent tags don't glue words together)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200)
      : '';

    articles.push({
      title: decodeHtmlEntities(cleanTitle),
      url: url.trim(),
      source: source ? decodeHtmlEntities(source) : 'Unknown',
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      snippet,
    });
  }

  return articles;
}

function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA sections: <title><![CDATA[...]]></title>
  const cdataMatch = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (cdataMatch) return cdataMatch[1];

  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // must run before &nbsp; below, not after: the RSS source XML-escapes its embedded HTML once, so an original "&nbsp;" separator arrives here as "&amp;nbsp;" — &nbsp; never appears literally until &amp; has been decoded first. (And &amp; itself must still run after quot/lt/gt/etc, so a genuinely double-escaped "&amp;lt;" resolves to the literal text "&lt;" rather than being mis-decoded straight through to "<".)
    .replace(/&nbsp;/g, ' ');
}
