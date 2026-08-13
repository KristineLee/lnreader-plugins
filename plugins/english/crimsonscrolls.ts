import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { storage } from '@libs/storage';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

type SearchJSON = {
  items: SearchItem[];
};

type SearchItem = {
  id: number;
  title: string;
  url: string;
  cover?: string;
  status?: string;
};

type ChapterJSON = {
  items: ChapterItem[];
  total: number;
  page: number;
  pages: number;
};

type ChapterItem = {
  id: number;
  number: string;
  title: string;
  url: string;
  tier: string;
};

class CrimsonScrollsPlugin implements Plugin.PluginBase {
  id = 'crimsonscrolls';
  name = 'Crimson Scrolls';
  icon = 'src/en/crimsonscrolls/icon.png';
  site = 'https://crimsonscrolls.net';
  version = '1.1.0';

  hideLocked = storage.get('hideLocked');
  pluginSettings = {
    hideLocked: {
      value: '',
      label: 'Hide locked chapters',
      type: 'Switch',
    },
  };

  async fetchChapters(id: number, page = 1): Promise<ChapterItem[]> {
    const url = `${this.site}/wp-json/crimsonscrolls/v2/novel-chapters?novel_id=${id}&tier=all&page=${page}&per_page=100&search=&order=ASC`;
    const data: ChapterJSON = await fetchApi(url).then(r => r.json());

    const items = data.items || [];

    if (data.pages && data.page < data.pages) {
      const nextItems = await this.fetchChapters(id, data.page + 1);
      return items.concat(nextItems);
    }

    return items;
  }

  parseNovels(loadedCheerio: CheerioAPI) {
    const novels: Plugin.NovelItem[] = [];

    loadedCheerio('article.cs-browse-card').each((i, el) => {
      const novelName = loadedCheerio(el).find('h2 a').text().trim();
      const novelCover =
        loadedCheerio(el)
          .find('.cs-browse-card__cover-wrap img')
          .attr('data-src') ||
        loadedCheerio(el).find('.cs-browse-card__cover-wrap img').attr('src');
      const novelUrl = loadedCheerio(el)
        .find('.cs-browse-card__cover')
        .attr('href');

      if (!novelUrl) return;

      const novel = {
        name: novelName
          .trim()
          .split(' ')
          .filter(e => e.length > 0)
          .join(' '),
        cover: novelCover,
        path: new URL(novelUrl, this.site).pathname.substring(1),
      };
      novels.push(novel);
    });
    return novels;
  }

  async popularNovels(page: number): Promise<Plugin.NovelItem[]> {
    const body = await fetchApi(`${this.site}/novels/?cs_page=${page}`).then(
      r => r.text(),
    );
    const loadedCheerio = parseHTML(body);
    return this.parseNovels(loadedCheerio);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const result = await fetchApi(`${this.site}/${novelPath}`).then(r =>
      r.text(),
    );

    const loadedCheerio = parseHTML(result);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: loadedCheerio('.cs-novel-info h1').text().trim() ?? 'Untitled',
      cover:
        loadedCheerio('.cs-cover img').attr('src')?.toString() ?? defaultCover,
      summary: loadedCheerio('#synopsis-full').text().trim(),
      author: loadedCheerio('.cs-novel-creator-card--author strong')
        .text()
        .trim(),
      chapters: [],
    };

    novel.genres = loadedCheerio('.cs-detail-genres a')
      .map((_, el) => loadedCheerio(el).text().trim())
      .toArray()
      .join(',');

    const rawStatus = loadedCheerio('.cs-cover-status').text().trim();
    const map: Record<string, string> = {
      ongoing: NovelStatus.Ongoing,
      hiatus: NovelStatus.OnHiatus,
      dropped: NovelStatus.Cancelled,
      cancelled: NovelStatus.Cancelled,
      completed: NovelStatus.Completed,
    };
    novel.status = map[rawStatus.toLowerCase()] ?? NovelStatus.Unknown;

    const id = loadedCheerio('[data-novel-chapters]').attr(
      'data-novel-chapters',
    );
    const chapters = await this.fetchChapters(Number(id));

    const novelChapters: Plugin.ChapterItem[] = [];
    chapters.forEach((chapter, index) => {
      const locked = chapter.tier !== 'free';
      if (!(locked && this.hideLocked)) {
        novelChapters.push({
          name: locked ? `🔒 ${chapter.title}` : chapter.title,
          path: chapter.url
            ? new URL(chapter.url, this.site).pathname.substring(1)
            : '',
          chapterNumber: index + 1,
        });
      }
    });
    novel.chapters = novelChapters;

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const body = await fetchApi(`${this.site}/${chapterPath}`).then(r =>
      r.text(),
    );
    const loadedCheerio = parseHTML(body);
    for (const i of [
      '.cs-chapter-ad',
      '.cs-reader-end-watermark',
      '.cs-copy-watermark',
      'header.cs-reader-title',
    ])
      loadedCheerio(`article.cs-reader ${i}`).remove();

    const chapterText = loadedCheerio('article.cs-reader').html() || '';
    return chapterText;
  }

  async searchNovels(searchTerm: string): Promise<Plugin.NovelItem[]> {
    const url = `${this.site}/wp-json/crimsonscrolls/v2/novel-search?q=${encodeURIComponent(searchTerm)}`;
    const data: SearchJSON = await fetchApi(url).then(r => r.json());

    return (data.items || []).map(item => ({
      name: item.title,
      cover: item.cover,
      path: new URL(item.url, this.site).pathname.substring(1),
    }));
  }
}

export default new CrimsonScrollsPlugin();
