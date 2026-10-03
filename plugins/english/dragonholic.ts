import { Plugin } from '@/types/plugin';
import { fetchApi, FetchInit } from '@libs/fetch';
import { load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { FilterTypes, Filters } from '@libs/filterInputs';

type WPSeries = {
  slug: string;
  title: { rendered: string };
  _embedded?: {
    'wp:featuredmedia'?: {
      source_url?: string;
      media_details?: { sizes?: { medium?: { source_url?: string } } };
    }[];
  };
};

type LuminaChapter = {
  id?: string | number;
  name?: string;
  slug?: string;
  heading?: string;
  subtitle?: string;
  chapter_order?: string | number;
  created_at?: string;
  is_premium?: boolean;
};

type LuminaChaptersResponse = {
  success?: boolean;
  data?: {
    success?: boolean;
    chapters?: LuminaChapter[];
    hasMore?: boolean;
  };
  chapters?: LuminaChapter[];
};

type LuminaSearchResult = {
  id?: string | number;
  title?: string;
  url?: string;
  thumbnail?: string;
};

class Dragonholic implements Plugin.PluginBase {
  id = 'dragonholic';
  name = 'Dragonholic Translations';
  icon = 'src/en/dragonholic/icon.png';
  site = 'https://dragonholictranslations.com';
  version = '3.1.0';

  private decodeEntities(text: string): string {
    return text
      .replace(/&#(\d+);/g, (_, code) => {
        try {
          return String.fromCharCode(parseInt(code, 10));
        } catch {
          return _;
        }
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
        try {
          return String.fromCharCode(parseInt(code, 16));
        } catch {
          return _;
        }
      })
      .replace(/&(amp|lt|gt|quot|apos|nbsp|#039);/g, (_, entity) => {
        switch (entity) {
          case 'amp':
            return '&';
          case 'lt':
            return '<';
          case 'gt':
            return '>';
          case 'quot':
            return '"';
          case 'apos':
            return "'";
          case 'nbsp':
            return ' ';
          case '#039':
            return "'";
          default:
            return _;
        }
      });
  }

  // Throw (carrying the HTTP status) on a refused response so a block is
  // reported instead of being parsed into a false empty result.
  private async fetchSite(url: string, init?: FetchInit) {
    const res = await fetchApi(url, init);
    if (!res.ok) {
      throw Object.assign(new Error('Request failed: ' + res.status), {
        status: res.status,
      });
    }
    return res;
  }

  // Paths saved by the fork's 1.0.0 plugin look like `series/<novel>` and
  // `series/<novel>/<chapter>/?id=<id>`; strip both down to `<novel>[/<chapter>]`.
  private normalizePath(path: string): string {
    return path
      .replace(/[?#].*$/, '')
      .replace(/\/{2,}/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .replace(/^(novel|series)\//, '');
  }

  private isLegacyPath(path: string): boolean {
    return /^\/?series\//.test(path);
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    if (!showLatestNovels) {
      return this.browseSeries(pageNo, filters);
    }
    const url = pageNo > 1 ? this.site + '/?updates_page=' + pageNo : this.site;
    const res = await this.fetchSite(url);
    const body = await res.text();
    const loadedCheerio = loadCheerio(body);
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    loadedCheerio('[data-latest-updates-content] a[href*="/series/"]').each(
      (_, element) => {
        const href = loadedCheerio(element).attr('href') || '';
        const match = href.match(/\/series\/([^/]+)\/?/);
        if (!match) return;
        const slug = match[1];
        if (seen.has(slug)) return;
        seen.add(slug);

        const card = loadedCheerio(element).closest('div[class*="rounded"]');
        const name =
          card.find('h3 a').first().text().trim() ||
          loadedCheerio(element).first().text().trim();
        const cover =
          card.find('img').first().attr('src') ||
          loadedCheerio(element).find('img').first().attr('src') ||
          defaultCover;

        if (name) {
          novels.push({ name, path: slug, cover });
        }
      },
    );

    return novels;
  }

  // The homepage has no filtering, but the site's WordPress API still does.
  private async browseSeries(
    pageNo: number,
    filters?: Plugin.PopularNovelsOptions<typeof this.filters>['filters'],
  ): Promise<Plugin.NovelItem[]> {
    // Saved filter values may be missing or from another version; ignore
    // anything that isn't one of the current options.
    const raw = (key: string) =>
      (filters as Record<string, { value?: unknown }>)?.[key]?.value;
    const pick = (key: 'sort' | 'order') => {
      const value = raw(key);
      return this.filters[key].options.some(option => option.value === value)
        ? (value as string)
        : this.filters[key].value;
    };
    const checked = (key: 'status' | 'genre') => {
      const value = raw(key);
      return (Array.isArray(value) ? value : []).filter(id =>
        this.filters[key].options.some(option => option.value === id),
      );
    };
    const statuses = checked('status');
    const genres = checked('genre');

    const params = new URLSearchParams({
      page: pageNo.toString(),
      per_page: '20',
      _embed: 'wp:featuredmedia',
      orderby: pick('sort'),
      order: pick('order'),
    });
    if (statuses.length) params.append('story-status', statuses.join(','));
    if (genres.length) params.append('genre', genres.join(','));

    const res = await fetchApi(
      this.site + '/wp-json/wp/v2/series?' + params.toString(),
    );
    // WordPress answers 400 for a page past the end; treat it as no more results.
    if (res.status === 400) return [];
    if (!res.ok) {
      throw Object.assign(new Error('Request failed: ' + res.status), {
        status: res.status,
      });
    }
    const items = (await res.json()) as WPSeries[];

    return items.map(item => {
      const media = item._embedded?.['wp:featuredmedia']?.[0];
      return {
        name: this.decodeEntities(
          item.title.rendered.replace(/<[^>]+>/g, ''),
        ).trim(),
        path: item.slug,
        cover:
          media?.media_details?.sizes?.medium?.source_url ||
          media?.source_url ||
          defaultCover,
      };
    });
  }

  async parseNovel(path: string): Promise<Plugin.SourceNovel> {
    const novelPath = this.normalizePath(path);
    const legacy = this.isLegacyPath(path);
    const res = await this.fetchSite(this.resolveUrl(novelPath));
    const body = await res.text();
    const loadedCheerio = loadCheerio(body);

    const novel: Plugin.SourceNovel = {
      path: legacy ? path : novelPath,
      name: '',
    };

    novel.name = loadedCheerio('h1').first().text().trim();

    const cover =
      loadedCheerio('[x-data="coverModal()"] img').first().attr('src') ||
      loadedCheerio('h1').parent().parent().find('img').first().attr('src');
    novel.cover = cover || defaultCover;

    novel.author =
      loadedCheerio('a[href*="/author/"]').first().text().trim() || undefined;

    const genres: string[] = [];
    loadedCheerio('a[href*="/genre/"]').each((_, element) => {
      const genre = loadedCheerio(element).text().trim();
      if (genre) genres.push(genre);
    });
    if (genres.length) {
      novel.genres = genres.join(',');
    }

    const statusText = loadedCheerio('div[class*="rounded-full"]')
      .toArray()
      .map(element => loadedCheerio(element).text().trim().toLowerCase())
      .find(text => /ongoing|completed|hiatus|cancelled|dropped/.test(text));
    if (statusText) {
      if (statusText.includes('ongoing')) novel.status = NovelStatus.Ongoing;
      else if (statusText.includes('completed'))
        novel.status = NovelStatus.Completed;
      else if (statusText.includes('hiatus'))
        novel.status = NovelStatus.OnHiatus;
      else novel.status = NovelStatus.Unknown;
    }

    const summary = loadedCheerio('[x-ref="synopsis"] p')
      .toArray()
      .map(element => loadedCheerio(element).text().trim())
      .filter(text => text && !/^synopsis:?$/i.test(text))
      .join('\n');
    if (summary) {
      novel.summary = summary;
    }

    const seriesId = body.match(/seriesId:\s*(\d+)/)?.[1];
    const chapters: Plugin.ChapterItem[] = [];
    if (seriesId) {
      const chaptersRes = await this.fetchSite(
        this.site +
          '/api/chapters?series_id=' +
          seriesId +
          '&load_all=1&sort_order=asc',
        {
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
        },
      );
      const data = (await chaptersRes.json()) as LuminaChaptersResponse;
      const list = data?.data?.chapters || data?.chapters || [];
      list.forEach(item => {
        if (!item.slug) return;
        const order = Number(item.chapter_order);
        const title = this.decodeEntities(
          [item.heading || item.name, item.subtitle]
            .filter(part => part && part.trim())
            .join(' - ') || item.slug,
        );
        // Library novels from 1.0.0 keep their chapter path format so the app
        // matches existing chapters (read progress) instead of duplicating them.
        const chapterPath =
          legacy && item.id
            ? 'series/' + novelPath + '/' + item.slug + '/?id=' + item.id
            : novelPath + '/' + item.slug;
        chapters.push({
          name: item.is_premium ? '🔒 ' + title : title,
          path: chapterPath,
          releaseTime: item.created_at || undefined,
          chapterNumber: order > 0 ? order : chapters.length + 1,
        });
      });
    }
    novel.chapters = chapters;

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const res = await this.fetchSite(this.resolveUrl(chapterPath));
    const body = await res.text();
    const loadedCheerio = loadCheerio(body);
    const content = loadedCheerio('.chapter-content');

    content
      .find('script, style, ins, .ad-container, [data-lumina-ad-code]')
      .remove();

    let chapterText = '';
    content.find('p').each((_, element) => {
      const paragraph = loadedCheerio(element);
      if (paragraph.text().trim() || paragraph.find('img').length) {
        chapterText += '<p>' + (paragraph.html() || '').trim() + '</p>';
      }
    });

    return chapterText;
  }

  async searchNovels(searchTerm: string): Promise<Plugin.NovelItem[]> {
    const res = await this.fetchSite(
      this.site + '/api/search?q=' + encodeURIComponent(searchTerm),
      {
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
    );
    const data = (await res.json()) as {
      results?: LuminaSearchResult[];
    };
    const novels: Plugin.NovelItem[] = [];

    (data?.results || []).forEach(item => {
      const match = (item.url || '').match(/\/series\/([^/]+)\/?/);
      if (item.title && match) {
        novels.push({
          name: this.decodeEntities(item.title),
          path: match[1],
          cover: item.thumbnail || defaultCover,
        });
      }
    });

    return novels;
  }

  resolveUrl = (path: string) =>
    this.site + '/series/' + this.normalizePath(path) + '/';

  filters = {
    sort: {
      label: 'Sort by',
      value: 'modified',
      options: [
        { label: 'Recently Updated', value: 'modified' },
        { label: 'Latest Upload', value: 'date' },
        { label: 'Title', value: 'title' },
      ],
      type: FilterTypes.Picker,
    },
    order: {
      label: 'Order',
      value: 'desc',
      options: [
        { label: 'Descending', value: 'desc' },
        { label: 'Ascending', value: 'asc' },
      ],
      type: FilterTypes.Picker,
    },
    // Checkboxes rather than a dropdown: a 6-item dropdown in the third row
    // can open under the phone's navigation bar in the app's filter sheet.
    status: {
      label: 'Status',
      value: [] as string[],
      options: [
        // The site has two separate "ongoing" terms.
        { label: 'Ongoing', value: '876,5486' },
        { label: 'Completed', value: '5487' },
        { label: 'Hiatus', value: '5490' },
        { label: 'Dropped', value: '5489' },
        { label: 'Canceled', value: '5488' },
      ],
      type: FilterTypes.CheckboxGroup,
    },
    genre: {
      label: 'Genre',
      value: [] as string[],
      options: [
        { label: 'Action', value: '2' },
        { label: 'Adult', value: '3' },
        { label: 'Adventure', value: '4' },
        { label: 'BL', value: '389' },
        { label: 'Comedy', value: '6' },
        { label: 'Drama', value: '10' },
        { label: 'Ecchi', value: '11' },
        { label: 'Fantasy', value: '12' },
        { label: 'Harem', value: '390' },
        { label: 'Historical', value: '391' },
        { label: 'Horror', value: '392' },
        { label: 'Josei', value: '393' },
        { label: 'Martial Arts', value: '22' },
        { label: 'Mature', value: '23' },
        { label: 'Mecha', value: '24' },
        { label: 'Mystery', value: '25' },
        { label: 'Psychological', value: '27' },
        { label: 'Reincarnation', value: '394' },
        { label: 'Romance', value: '28' },
        { label: 'School Life', value: '29' },
        { label: 'Sci-fi', value: '30' },
        { label: 'Seinen', value: '31' },
        { label: 'Shoujo', value: '32' },
        { label: 'Shoujo Ai', value: '33' },
        { label: 'Slice of Life', value: '36' },
        { label: 'Smut', value: '37' },
        { label: 'Sports', value: '40' },
        { label: 'Supernatural', value: '41' },
        { label: 'Tragedy', value: '42' },
        { label: 'Webtoon', value: '43' },
        { label: 'Xianxia', value: '395' },
        { label: 'Yaoi', value: '44' },
        { label: 'Yuri', value: '45' },
      ],
      type: FilterTypes.CheckboxGroup,
    },
  } satisfies Filters;
}

export default new Dragonholic();
