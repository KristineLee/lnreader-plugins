import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { load as parseHTML } from 'cheerio';

// Dragonholic Translations moved off the Madara WP theme onto a custom
// "Lumina" theme (Acorn/Laravel). It still exposes the default WordPress
// REST API, which is what this plugin talks to instead of scraping HTML.

type WPTerm = {
  id: number;
  taxonomy: string;
  name: string;
  slug: string;
};

type WPMedia = {
  source_url: string;
  media_details?: {
    sizes?: Record<string, { source_url: string }>;
  };
};

type WPSeries = {
  id: number;
  slug: string;
  title: { rendered: string };
  content: { rendered: string };
  _embedded?: {
    'wp:featuredmedia'?: WPMedia[];
    'wp:term'?: WPTerm[][];
  };
};

type WPChapter = {
  id: number;
  slug: string;
  link: string;
  date: string;
  title: { rendered: string };
  content: { rendered: string };
};

const STATUS_MAP: Record<string, string> = {
  'on-going': NovelStatus.Ongoing,
  end: NovelStatus.Completed,
  'on-hold': NovelStatus.Cancelled,
  upcoming: NovelStatus.OnHiatus,
  canceled: NovelStatus.Cancelled,
};

const htmlToText = (html: string): string =>
  parseHTML(`<div>${html.replace(/<\/p>/gi, '</p>\n\n')}</div>`)
    .text()
    .trim();

// Direct wp-content/uploads URLs 403 when the request's Referer isn't the
// site itself (Cloudflare hotlink protection), which is exactly the case
// when the app loads the image. Routing through Jetpack's Photon CDN
// (i0.wp.com) avoids that check, and the site's own frontend does the same.
const getCoverUrl = (media?: WPMedia): string | undefined => {
  if (!media) return undefined;
  const sized =
    media.media_details?.sizes?.medium?.source_url ||
    media.media_details?.sizes?.medium_large?.source_url;
  if (sized) return sized;
  return media.source_url?.replace(/^https?:\/\//, 'https://i0.wp.com/');
};

class DragonholicTranslations implements Plugin.PluginBase {
  id = 'dragonholic';
  name = 'Dragonholic Translations';
  icon = 'src/en/dragonholic/icon.png';
  site = 'https://dragonholictranslations.com/';
  version = '1.0.0';

  apiUrl = `${this.site}wp-json/wp/v2/`;

  parseNovels(items: WPSeries[]): Plugin.NovelItem[] {
    return items.map(item => ({
      name: htmlToText(item.title.rendered),
      path: `series/${item.slug}`,
      cover:
        getCoverUrl(item._embedded?.['wp:featuredmedia']?.[0]) || defaultCover,
    }));
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({
      page: pageNo.toString(),
      per_page: '20',
      _embed: '1',
    });

    if (showLatestNovels) {
      params.set('orderby', 'date');
      params.set('order', 'desc');
    } else {
      params.set('orderby', filters.sort.value);
      params.set('order', filters.order.value);
    }

    if (filters.status.value) {
      params.append('story-status[]', filters.status.value);
    }
    filters.genre.value.forEach(genreId => {
      params.append('genre[]', genreId);
    });

    const result = await fetchApi(`${this.apiUrl}series?${params.toString()}`);
    if (!result.ok) return [];
    const items: WPSeries[] = await result.json();
    return this.parseNovels(items);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const slug = novelPath.replace(/^series\//, '').replace(/\/$/, '');
    const result = await fetchApi(
      `${this.apiUrl}series?slug=${encodeURIComponent(slug)}&_embed=1`,
    );
    const [item]: WPSeries[] = result.ok ? await result.json() : [];

    if (!item) {
      return { path: novelPath, name: 'Untitled' };
    }

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: htmlToText(item.title.rendered),
      cover:
        getCoverUrl(item._embedded?.['wp:featuredmedia']?.[0]) || defaultCover,
      summary: htmlToText(item.content.rendered),
    };

    const terms = (item._embedded?.['wp:term'] || []).flat();

    const genres = terms
      .filter(term => term.taxonomy === 'genre')
      .map(term => term.name);
    if (genres.length) novel.genres = genres.join(',');

    const author = terms.find(term => term.taxonomy === 'series-author');
    if (author) novel.author = author.name;

    const artist = terms.find(term => term.taxonomy === 'series-artist');
    if (artist) novel.artist = artist.name;

    const status = terms.find(term => term.taxonomy === 'story-status');
    novel.status = status
      ? STATUS_MAP[status.slug] || NovelStatus.Unknown
      : NovelStatus.Unknown;

    const chapters: Plugin.ChapterItem[] = [];
    const perPage = 100;
    const maxPages = 50; // safety guard, 5000 chapters is far beyond any listed novel
    for (let page = 1; page <= maxPages; page++) {
      const chapterResult = await fetchApi(
        `${this.apiUrl}chapter?parent=${item.id}&per_page=${perPage}&page=${page}&orderby=date&order=asc`,
      );
      if (!chapterResult.ok) break;
      const chapterItems: WPChapter[] = await chapterResult.json();
      if (!chapterItems.length) break;

      chapterItems.forEach((chapter, idx) => {
        const numberMatch = chapter.slug.match(/(\d+(?:\.\d+)?)/);
        chapters.push({
          name: htmlToText(chapter.title.rendered),
          path: `${chapter.link.replace(this.site, '')}?id=${chapter.id}`,
          releaseTime: new Date(chapter.date).toISOString(),
          chapterNumber: numberMatch
            ? Number(numberMatch[1])
            : (page - 1) * perPage + idx + 1,
        });
      });

      if (chapterItems.length < perPage) break;
    }
    novel.chapters = chapters;

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const idMatch = chapterPath.match(/[?&]id=(\d+)/);
    if (!idMatch) return '';

    const result = await fetchApi(`${this.apiUrl}chapter/${idMatch[1]}`);
    if (!result.ok) return '';
    const chapter: WPChapter = await result.json();

    const loadedCheerio = parseHTML(`<div>${chapter.content.rendered}</div>`);
    loadedCheerio('span.dh-censored[data-original]').each((_, el) => {
      const $el = loadedCheerio(el);
      const original = $el.attr('data-original');
      if (!original) return;
      try {
        $el.replaceWith(Buffer.from(original, 'base64').toString('utf-8'));
      } catch {
        // leave the censored placeholder text if it fails to decode
      }
    });

    return loadedCheerio.html() || '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({
      search: searchTerm,
      page: pageNo.toString(),
      per_page: '20',
      _embed: '1',
    });

    const result = await fetchApi(`${this.apiUrl}series?${params.toString()}`);
    if (!result.ok) return [];
    const items: WPSeries[] = await result.json();
    return this.parseNovels(items);
  }

  filters = {
    sort: {
      value: 'modified',
      label: 'Sort by',
      options: [
        { label: 'Recently Updated', value: 'modified' },
        { label: 'Latest Upload', value: 'date' },
        { label: 'Title', value: 'title' },
      ],
      type: FilterTypes.Picker,
    },
    order: {
      value: 'desc',
      label: 'Order',
      options: [
        { label: 'Descending', value: 'desc' },
        { label: 'Ascending', value: 'asc' },
      ],
      type: FilterTypes.Picker,
    },
    status: {
      value: '',
      label: 'Status',
      options: [
        { label: 'All', value: '' },
        { label: 'Ongoing', value: '5486' },
        { label: 'Completed', value: '5487' },
        { label: 'Hiatus', value: '5490' },
        { label: 'Dropped', value: '5489' },
        { label: 'Canceled', value: '5488' },
      ],
      type: FilterTypes.Picker,
    },
    genre: {
      value: [],
      label: 'Genre',
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

export default new DragonholicTranslations();
