import { fetchApi } from '@libs/fetch';
import { CheerioAPI, load as parseHTML } from 'cheerio';
import { Element } from 'domhandler';
import { Plugin } from '@/types/plugin';

class SkyTheWood implements Plugin.PluginBase {
  id = 'skythewoodtranslations';
  name = 'Skythewood Translations';
  site = 'https://skythewood.blogspot.com';
  icon = 'src/en/skythewood/icon.png';
  version = '1.0.0';

  async popularNovels(pageNo: number): Promise<Plugin.NovelItem[]> {
    // I'm fetching all the completed project here in one go
    // There are no novels in the ongoing projects page right now so that won't work
    //   And this is a blogger site with a messy link structure so not every novel is visible
    // tbh idk how i can fix that but some is better than none so "\-(シ)-/"
    if (pageNo > 1) return [];

    type SkyProjects = {
      names: string[][];
      novels: {
        name: string;
        href: string;
        cover: string | undefined;
      }[];
    };

    const doneProjects: SkyProjects = await this.getDoneProjects();
    const ongoingProjects: SkyProjects = { names: [], novels: [] };

    const projects = ongoingProjects.novels.concat(doneProjects.novels);

    const novels: Plugin.NovelItem[] = [];

    for (const proj of projects) {
      const newNovel: Plugin.NovelItem = this.projectToNovel(proj);
      novels.push(newNovel);
    }

    // console.log(novels);

    return novels;
  }

  private async getDoneProjects() {
    const pageRes = await fetchApi(
      'https://skythewood.blogspot.com/p/done.html',
    );

    const page = await pageRes.text();

    const $ = parseHTML(page);

    const anchors = $('.post-body > div a').toArray();

    const projects = anchors
      .filter(el => $(el).attr('href'))
      .filter(el => {
        const href = $(el).attr('href')!;
        return (
          href.startsWith('http://skythewood.blogspot.sg/p/') ||
          href.startsWith('http://skythewood.blogspot.com/p/') ||
          href.startsWith('https://skythewood.blogspot.sg/p/') ||
          href.startsWith('https://skythewood.blogspot.com/p/')
        );
      })
      .filter(el => $(el).text());

    // console.log(projects.map(el => [$(el).text(), $(el).attr('href')]));

    const dedup: Element[] = [];
    const names: string[][] = [];

    for (const proj of projects) {
      if ($(proj).text().length == 0) continue;

      const dupIndex = dedup.findIndex(
        el => $(el).attr('href') == $(proj).attr('href'),
      );
      if (dupIndex === -1) {
        dedup.push(proj);
        names.push([$(proj).text()]);
      } else names[dupIndex].push($(proj).text());
    }

    const withCovers = findCovers($, dedup);

    return {
      novels: withCovers,
      names: names,
    };
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const pageRes = await fetchApi(novelPath);
    const page = await pageRes.text();
    const $ = parseHTML(page);

    const name = $('.post-title').text();

    let artist: string | undefined;
    {
      const boldEls = $('b').toArray();
      const authorEl = boldEls.find(el => $(el).text().startsWith('Author'));
      if (authorEl) {
        artist = $(authorEl).text().split(':')[1].trim();
      }
    }

    const chapterAnchors = $('.post-body a').toArray();

    const filtered = chapterAnchors
      .filter(el => $(el).attr('href'))
      .filter(el => $(el).attr('href')!.includes('skythewood'));

    const withVolumes = findVolumes($, filtered);

    const chapters: Plugin.ChapterItem[] = [];

    for (const ch of withVolumes) {
      const name = ch.volume ? `${ch.volume} - ${ch.name}` : ch.name;
      const chapter: Plugin.ChapterItem = {
        name: name,
        path: ch.href.replace('http://', 'https://'),
      };
      chapters.push(chapter);
    }

    return {
      name: name,
      path: novelPath,
      cover: $('img').eq(1).attr('src'),
      artist,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const pageRes = await fetchApi(chapterPath);
    const page = await pageRes.text();
    const $ = parseHTML(page);

    const body = $('.post-body').html();

    return body || '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];

    const projects = await this.getDoneProjects();

    const result = new Set<Plugin.NovelItem>();

    for (let i = 0; i < projects.novels.length; i++) {
      const names = projects.names[i];
      if (!names) continue;

      if (
        names.some(name =>
          name.toLowerCase().includes(searchTerm.toLocaleLowerCase()),
        )
      ) {
        result.add(this.projectToNovel(projects.novels[i]));
      }
    }

    return Array.from(result);
  }

  projectToNovel(proj: {
    name: string;
    href: string;
    cover: string | undefined;
  }): Plugin.NovelItem {
    return {
      name: proj.name,
      path: proj.href.replace('http://', 'https://'),
      cover: proj.cover,
    };
  }
}

function findCovers($: CheerioAPI, anchors: Element[]) {
  const anchorSet = new Set(anchors);
  const result: { name: string; href: string; cover: string | undefined }[] =
    [];
  let lastImg: string | undefined;

  $('.post-body')
    .find('*')
    .each((_, el) => {
      const $el = $(el);

      if ($el.prop('tagName') === 'IMG') {
        lastImg = $el.attr('src') || undefined;
      }

      if (anchorSet.has(el)) {
        result.push({
          name: $el.text(),
          href: $el.attr('href') || '',
          cover: lastImg,
        });
      }
    });

  return result;
}

function findVolumes($: CheerioAPI, anchors: Element[]) {
  const anchorSet = new Set(anchors);
  const result: { name: string; href: string; volume: string | null }[] = [];
  let lastVolume: string | null = null;

  $('.post-body')
    .find('*')
    .each((_, el) => {
      const $el = $(el);
      const text = $el.text();

      if (text.startsWith('Volume')) {
        lastVolume = text;
      }

      if (anchorSet.has(el)) {
        result.push({
          name: text,
          href: $el.attr('href') || '',
          volume: lastVolume,
        });
      }
    });

  return result;
}

export default new SkyTheWood();
