import { load } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';

class IndraTranslations implements Plugin.PluginBase {
  id = 'indratranslations';
  name = 'Indra Translations';
  site = 'https://indratranslations.com';
  version = '1.2.1';
  icon = 'src/en/indratranslations/icon.png';
  // customCSS = 'src/en/indratranslations/customCSS.css';
  // (optional) Add these files to the repo and uncomment the lines above if you want an icon/custom CSS.

  // Browser-like headers (important for Cloudflare-y sites)
  private headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    Referer: this.site,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };

  private async fetchHtml(url: string): Promise<string> {
    const res = await fetchApi(url, { headers: this.headers });
    return await res.text();
  }

  private absolute(url?: string): string | undefined {
    if (!url) return undefined;
    const u = String(url).trim();
    if (!u) return undefined;
    if (u.startsWith('http')) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) return this.site + u;
    return this.site + '/' + u;
  }

  private clean(text: unknown): string {
    return String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private chapterNum(name: string): number {
    const m = String(name).match(/(\d+(\.\d+)?)/);
    return m ? Number(m[1]) : 0;
  }

  /**
   * The site was rebuilt on a custom theme (no longer Madara/WP-manga).
   * Novel cards are `<div class="series-card">` with the destination URL
   * embedded in an `onclick="location.href='...'"` attribute instead of a
   * plain `<a href>`.
   */
  private parseNovelCards($: ReturnType<typeof load>) {
    const out: { name: string; path: string; cover?: string }[] = [];
    const seen = new Set<string>();

    const push = (name?: string, path?: string, cover?: string) => {
      const cleanName = this.clean(name);
      const cleanPath = String(path || '')
        .replace(this.site, '')
        .trim();
      if (!cleanName || !cleanPath) return;

      // Normalize trailing slash for consistency
      const normalized = cleanPath.endsWith('/') ? cleanPath : cleanPath + '/';
      if (seen.has(normalized)) return;

      seen.add(normalized);
      out.push({
        name: cleanName,
        path: normalized,
        cover: cover ? this.absolute(cover) : undefined,
      });
    };

    $('.series-card').each((_, el) => {
      const $el = $(el);
      const onclick = $el.attr('onclick') || '';
      const hrefMatch = onclick.match(/location\.href=['"]([^'"]+)['"]/);
      const href = hrefMatch?.[1] || $el.find('a').first().attr('href') || '';
      if (!href) return;

      const title =
        this.clean($el.find('.series-card-title').attr('title')) ||
        this.clean($el.find('.series-card-title').text());

      const img =
        $el.find('img').attr('data-src') ||
        $el.find('img').attr('data-lazy-src') ||
        $el.find('img').attr('src');

      push(title, href, img || undefined);
    });

    return out;
  }

  async popularNovels(pageNo: number) {
    if (pageNo !== 1) return [];
    const html = await this.fetchHtml(`${this.site}/series/`);
    const $ = load(html);
    const parsed = this.parseNovelCards($);

    return parsed.map(n => ({
      name: n.name,
      path: n.path,
      cover: n.cover,
    }));
  }

  async searchNovels(searchTerm: string, pageNo: number) {
    if (pageNo !== 1) return [];
    const url = `${this.site}/series/?keyword=${encodeURIComponent(searchTerm)}`;
    const html = await this.fetchHtml(url);
    const $ = load(html);
    return this.parseNovelCards($);
  }

  async parseNovel(novelPath: string) {
    const url = novelPath.startsWith('http')
      ? novelPath
      : this.site + novelPath;
    const html = await this.fetchHtml(url);
    const $ = load(html);

    const title =
      this.clean($('h1.story-main-title').text()) ||
      this.clean($('h1').first().text()) ||
      'Unknown';

    const cover = this.absolute(
      $('.story-cover-card img').attr('data-src') ||
        $('.story-cover-card img').attr('data-lazy-src') ||
        $('.story-cover-card img').attr('src'),
    );

    const summary =
      this.clean($('#story-synopsis').text()) ||
      this.clean($('.synopsis-wrapper').text()) ||
      undefined;

    let statusText = '';
    $('.story-meta-list > div').each((_, el) => {
      const label = this.clean(
        $(el).find('.td-hero-subtext').first().text(),
      ).toLowerCase();
      if (label.includes('status')) {
        statusText = this.clean($(el).find('a').text());
      }
    });

    const genres = $('.story-meta-list a[href*="/series-genre/"]')
      .map((_, el) => this.clean($(el).text()))
      .get()
      .filter(Boolean)
      .join(', ');

    const author =
      this.clean($('.story-meta-list a[href*="/tac-gia/"]').first().text()) ||
      undefined;

    const chapters: { name: string; path: string; chapterNumber?: number }[] =
      [];

    $('#chapter-list-container a.chap-item, .chapter-item-wrapper a').each(
      (_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const name = this.clean(
          $(el).find('span').first().text() || $(el).text(),
        );
        const normalized = href.replace(this.site, '');
        chapters.push({
          name,
          path: normalized,
          chapterNumber: this.chapterNum(name),
        });
      },
    );

    chapters.sort((a, b) => (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0));

    const statusLower = String(statusText).toLowerCase();
    const status = statusLower.includes('complete')
      ? NovelStatus.Completed
      : statusLower.includes('hiatus')
        ? NovelStatus.OnHiatus
        : statusLower.includes('drop') || statusLower.includes('cancel')
          ? NovelStatus.Cancelled
          : NovelStatus.Ongoing;

    return {
      name: title,
      path: novelPath.endsWith('/') ? novelPath : novelPath + '/',
      cover,
      summary,
      author,
      genres: genres || undefined,
      status,
      chapters,
    };
  }

  async parseChapter(chapterPath: string) {
    const url = chapterPath.startsWith('http')
      ? chapterPath
      : this.site + chapterPath;
    const html = await this.fetchHtml(url);
    const $ = load(html);

    const content = $('#chapter-content-text').first().length
      ? $('#chapter-content-text').first()
      : $('.chapter-content').first();

    if (!content.length) {
      return `\nUnable to load chapter content.\n\n`;
    }

    // Site injects invisible "noise" spans (random strings, aria-hidden)
    // into the text as an anti-scraping watermark — strip them along with
    // ads/scripts so they don't pollute the chapter body.
    content
      .find('script, style, ins, iframe, noscript, .td-ad-wrapper, .td-s-noise')
      .remove();

    return content.html() ?? '';
  }

  filters: Filters = {
    sort: {
      label: 'Sort',
      value: 'Latest',
      options: [{ label: 'Latest', value: 'Latest' }],
      type: FilterTypes.Picker,
    },
  };
}

export default new IndraTranslations();
