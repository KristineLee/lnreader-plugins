import { CheerioAPI, load } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import dayjs from 'dayjs';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

class ChireadsPlugin implements Plugin.PluginBase {
  id = 'chireads';
  name = 'Chireads';
  icon = 'src/fr/chireads/icon.png';
  site = 'https://chireads.com';
  version = '1.0.2';

  async getCheerio(url: string): Promise<CheerioAPI> {
    const r = await fetchApi(url, {
      headers: { 'Accept-Encoding': 'deflate' },
    });
    const body = await r.text();
    const $ = load(body);
    return $;
  }

  async popularNovels(
    pageNo: number,
    { filters, showLatestNovels }: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    let url = this.site;
    let tag = 'all';
    if (showLatestNovels) url += '/category/translatedtales/page/' + pageNo;
    else {
      if (
        filters &&
        typeof filters.tag.value === 'string' &&
        filters.tag.value !== 'all'
      )
        tag = filters.tag.value;
      if (tag !== 'all') url += '/tag/' + tag + '/page/' + pageNo;
      else if (pageNo > 1) return [];
    }
    let $ = await this.getCheerio(url);

    const novels: Plugin.NovelItem[] = [];
    let novel: Plugin.NovelItem;

    if (showLatestNovels || tag !== 'all') {
      let loop = 1;
      if (showLatestNovels) loop = 2;
      for (let i = 0; i < loop; i++) {
        if (i === 1)
          $ = await this.getCheerio(
            this.site + '/category/original/page/' + pageNo,
          );
        // Chireads switched to a "refresh" WordPress theme; listing items
        // are now `#content li article` with the title/link inside
        // `.news-list-tit a` and the cover inside `.news-list-img img`.
        $('#content li article').each((i, elem) => {
          const $el = $(elem);
          const $link = $el.find('.news-list-tit a').first();
          const novelName = $link.text().trim();
          const novelCover = $el.find('.news-list-img img').attr('src');
          const novelUrl = $link.attr('href');

          if (novelUrl) {
            novel = {
              name: novelName,
              cover: novelCover,
              path: novelUrl.replace(this.site, ''),
            };
            novels.push(novel);
          }
        });
      }
    } else {
      // Homepage "Populaire" block: `.recommended-list li` with a cover
      // div (`.recommended-list-img img`) and a title/link div
      // (`.recommended-list-txt a`).
      $('.recommended-list li').each((i, elem) => {
        const $el = $(elem);
        const novelCover = $el.find('.recommended-list-img img').attr('src');
        const $link = $el.find('.recommended-list-txt a');
        const novelName = $link.text().trim();
        const novelUrl = $link.attr('href');

        if (novelUrl) {
          novel = {
            name: novelName,
            cover: novelCover || defaultCover,
            path: novelUrl.replace(this.site, ''),
          };
          novels.push(novel);
        }
      });
    }
    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const novel: Plugin.SourceNovel = { path: novelPath, name: 'Sans titre' };

    const $ = await this.getCheerio(this.site + novelPath);

    // "refresh" theme: title/cover/summary/meta all moved under
    // `.refresh-detail-*` classes.
    novel.name = $('h1.refresh-detail-title').text().trim() || novel.name;
    novel.cover =
      $('figure.refresh-detail-cover img').attr('src') || defaultCover;
    novel.summary = $('#refresh-detail-summary-content').text().trim();

    novel.author =
      $('dl.refresh-detail-meta dt:contains("Auteur")')
        .next('dd')
        .text()
        .trim() || 'Inconnu';

    const statusText = $(
      'dl.refresh-detail-meta dt:contains("Statut de Parution")',
    )
      .next('dd')
      .text()
      .trim()
      .toLowerCase();
    if (statusText.includes('pause')) {
      novel.status = NovelStatus.OnHiatus;
    } else if (
      statusText.includes('termin') ||
      statusText.includes('complet')
    ) {
      novel.status = NovelStatus.Completed;
    } else {
      novel.status = NovelStatus.Ongoing;
    }

    const chapters: Plugin.ChapterItem[] = [];

    $('.refresh-detail-chapter-list a').each((i, elem) => {
      const chapterName = $(elem).text().trim();
      const chapterUrl = $(elem).attr('href');
      const releaseDate = dayjs(
        chapterUrl?.substring(chapterUrl.length - 11, chapterUrl.length - 1),
      ).format('DD MMMM YYYY');

      if (chapterUrl) {
        chapters.push({
          name: chapterName,
          releaseTime: releaseDate,
          path: chapterUrl.replace(this.site, ''),
        });
      }
    });

    novel.chapters = chapters;

    return novel;
  }

  async parseChapter(chapterUrl: string): Promise<string> {
    const $ = await this.getCheerio(this.site + chapterUrl);

    const chapterText = $('#content').html() || '';

    return chapterText;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo !== 1) return [];
    let novels: Plugin.NovelItem[] = [];

    let i = 1;
    let finised = false;
    while (!finised) {
      await this.popularNovels(i, {
        showLatestNovels: true,
        filters: undefined,
      }).then(res => {
        if (res.length === 0) finised = true;
        novels.push(...res);
      });
      i++;
    }

    novels = novels.filter(novel =>
      novel.name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .includes(
          searchTerm
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, ''),
        ),
    );

    return novels;
  }

  filters = {
    tag: {
      type: FilterTypes.Picker,
      label: 'Tag',
      value: 'all',
      options: [
        { label: 'Tous', value: 'all' },
        { label: 'Arts martiaux', value: 'arts-martiaux' },
        { label: 'De faible à fort', value: 'de-faible-a-fort' },
        { label: 'Adapté en manhua', value: 'adapte-en-manhua' },
        { label: 'Cultivation', value: 'cultivation' },
        { label: 'Action', value: 'action' },
        { label: 'Aventure', value: 'aventure' },
        { label: 'Monstres', value: 'monstres' },
        { label: 'Xuanhuan', value: 'xuanhuan' },
        { label: 'Fantastique', value: 'fantastique' },
        { label: 'Adapté en Animé', value: 'adapte-en-anime' },
        { label: 'Alchimie', value: 'alchimie' },
        { label: 'Éléments de jeux', value: 'elements-de-jeux' },
        { label: 'Calme Protagoniste', value: 'calme-protagoniste' },
        {
          label: 'Protagoniste intelligent',
          value: 'protagoniste-intelligent',
        },
        { label: 'Polygamie', value: 'polygamie' },
        { label: 'Belle femelle Lea', value: 'belle-femelle-lea' },
        { label: 'Personnages arrogants', value: 'personnages-arrogants' },
        { label: 'Système de niveau', value: 'systeme-de-niveau' },
        { label: 'Cheat', value: 'cheat' },
        { label: 'Protagoniste génie', value: 'protagoniste-genie' },
        { label: 'Comédie', value: 'comedie' },
        { label: 'Gamer', value: 'gamer' },
        { label: 'Mariage', value: 'mariage' },
        { label: 'seeking Protag', value: 'seeking-protag' },
        { label: 'Romance précoce', value: 'romance-precoce' },
        { label: 'Croissance accélérée', value: 'croissance-acceleree' },
        { label: 'Artefacts', value: 'artefacts' },
        {
          label: 'Intelligence artificielle',
          value: 'intelligence-artificielle',
        },
        { label: 'Mariage arrangé', value: 'mariage-arrange' },
        { label: 'Mature', value: 'mature' },
        { label: 'Adulte', value: 'adulte' },
        {
          label: 'Administrateur de système',
          value: 'administrateur-de-systeme',
        },
        { label: 'Beau protagoniste', value: 'beau-protagoniste' },
        {
          label: 'Protagoniste charismatique',
          value: 'protagoniste-charismatique',
        },
        { label: 'Protagoniste masculin', value: 'protagoniste-masculin' },
        { label: 'Démons', value: 'demons' },
        { label: 'Reincarnation', value: 'reincarnation' },
        { label: 'Académie', value: 'academie' },
        {
          label: 'Cacher les vraies capacités',
          value: 'cacher-les-vraies-capacites',
        },
        {
          label: 'Protagoniste surpuissant',
          value: 'protagoniste-surpuissant',
        },
        { label: 'Joueur', value: 'joueur' },
        {
          label: 'Protagoniste fort dès le départ',
          value: 'protagoniste-fort-des-le-depart',
        },
        { label: 'Immortels', value: 'immortels' },
        { label: 'Cultivation rapide', value: 'cultivation-rapide' },
        { label: 'Harem', value: 'harem' },
        { label: 'Assasins', value: 'assasins' },
        { label: 'De pauvre à riche', value: 'de-pauvre-a-riche' },
        {
          label: 'Système de classement de jeux',
          value: 'systeme-de-classement-de-jeux',
        },
        { label: 'Capacités spéciales', value: 'capacites-speciales' },
        { label: 'Vengeance', value: 'vengeance' },
      ],
    },
  } satisfies Filters;
}

export default new ChireadsPlugin();
