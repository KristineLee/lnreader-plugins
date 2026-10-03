import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';
import { Plugin } from '@/types/plugin';

type ApiPage<T> = {
  data?: T[];
  meta?: { page?: number; totalPages?: number };
};

type ApiStory = {
  id: number;
  title: string;
  slug: string;
  coverUrl?: string;
  description?: string;
  status?: string;
  author?: { displayName?: string };
  genres?: { name: string }[];
  tags?: { name: string }[];
};

type ApiChapter = {
  id: number;
  title?: string;
  number?: number;
  content?: string;
  publishedAt?: string;
};

// The HTML site is behind a Cloudflare block that rejects the app's requests,
// so everything goes through the public JSON API the official ScribbleHub app uses.
class ScribbleHubPlugin implements Plugin.PluginBase {
  id = 'scribblehub';
  name = 'Scribble Hub';
  icon = 'src/en/scribblehub/icon.png';
  site = 'https://www.scribblehub.com/';
  version = '1.1.1';

  apiUrl = `${this.site}wp-json/fictionapp/v1/`;

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await fetchApi(this.apiUrl + path, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Scribble Hub request failed: ${res.status}`);
    }
    return res.json();
  }

  // Paths keep the website's URL format (as saved by 1.0.x) so library
  // entries and read progress still match:
  //   novel:   series/<id>/<slug>/
  //   chapter: read/<id>-<slug>/chapter/<chapterId>/
  private novelPath(story: ApiStory): string {
    const slug = story.slug.replace(new RegExp(`^${story.id}-`), '');
    return `series/${story.id}/${slug}/`;
  }

  private storyId(path: string): string {
    const id =
      path.match(/series\/(\d+)/)?.[1] || path.match(/read\/(\d+)-/)?.[1];
    if (!id) throw new Error(`Unrecognized Scribble Hub path: ${path}`);
    return id;
  }

  private parseNovels(stories: ApiStory[] = []): Plugin.NovelItem[] {
    return stories.map(story => ({
      name: story.title,
      cover: story.coverUrl || defaultCover,
      path: this.novelPath(story),
    }));
  }

  async popularNovels(
    page: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({ page: page.toString() });
    if (!showLatestNovels) {
      // The app can pass missing filters or values saved by 1.0.x (different
      // keys and option values), so fall back to defaults for anything unknown.
      const pick = (key: 'sort' | 'status' | 'genre') => {
        const value = (filters as Record<string, { value?: unknown }>)?.[key]
          ?.value;
        return this.filters[key].options.some(option => option.value === value)
          ? (value as string)
          : this.filters[key].value;
      };
      const sort = pick('sort');
      const status = pick('status');
      const genre = pick('genre');
      if (sort) params.append('sort', sort);
      if (status) params.append('status', status);
      if (genre) params.append('genre', genre);
    }

    const result = await this.fetchJson<ApiPage<ApiStory>>(
      `stories?${params.toString()}`,
    );
    return this.parseNovels(result.data);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const id = this.storyId(novelPath);
    const detail = await this.fetchJson<{ data?: ApiStory } & ApiStory>(
      `stories/${id}`,
    );
    const story = detail.data || detail;

    const genres = [...(story.genres || []), ...(story.tags || [])]
      .map(term => term.name)
      .join(',');

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: story.title || 'Untitled',
      cover: story.coverUrl || defaultCover,
      summary: story.description,
      author: story.author?.displayName,
      genres,
      status:
        story.status === 'completed'
          ? NovelStatus.Completed
          : story.status === 'ongoing'
            ? NovelStatus.Ongoing
            : story.status === 'hiatus'
              ? NovelStatus.OnHiatus
              : NovelStatus.Unknown,
    };

    // The API pages chapters 50 at a time regardless of per_page.
    const first = await this.fetchJson<ApiPage<ApiChapter>>(
      `stories/${id}/chapters?page=1`,
    );
    const totalPages = first.meta?.totalPages || 1;
    const rest: ApiPage<ApiChapter>[] = [];
    // Small batches keep long novels fast without hammering the API.
    for (let page = 2; page <= totalPages; page += 5) {
      const batch = Array.from(
        { length: Math.min(5, totalPages - page + 1) },
        (_, i) =>
          this.fetchJson<ApiPage<ApiChapter>>(
            `stories/${id}/chapters?page=${page + i}`,
          ),
      );
      rest.push(...(await Promise.all(batch)));
    }

    const readSlug = story.slug.startsWith(`${story.id}-`)
      ? story.slug
      : `${story.id}-${story.slug}`;

    novel.chapters = [first, ...rest]
      .flatMap(result => result.data || [])
      .map(chapter => ({
        name: chapter.title || `Chapter ${chapter.number}`,
        path: `read/${readSlug}/chapter/${chapter.id}/`,
        releaseTime: chapter.publishedAt || null,
        chapterNumber: chapter.number,
      }));

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const chapterId = chapterPath.match(/chapter\/(\d+)/)?.[1];
    if (!chapterId) {
      throw new Error(`Unrecognized Scribble Hub chapter path: ${chapterPath}`);
    }
    const result = await this.fetchJson<{ data?: ApiChapter } & ApiChapter>(
      `chapters/${chapterId}`,
    );
    return (result.data || result).content || '';
  }

  async searchNovels(
    searchTerm: string,
    page: number,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({
      search: searchTerm,
      page: page.toString(),
    });
    const result = await this.fetchJson<ApiPage<ApiStory>>(
      `stories?${params.toString()}`,
    );
    return this.parseNovels(result.data);
  }

  resolveUrl = (path: string) => this.site + path;

  filters = {
    sort: {
      label: 'Sort Results By',
      value: 'popular',
      options: [
        { label: 'Popular', value: 'popular' },
        { label: 'Last Updated', value: '' },
        { label: 'Newest', value: 'new' },
        { label: 'Readers', value: 'readers' },
        { label: 'Chapters', value: 'chapters' },
        { label: 'Total Words', value: 'words' },
      ],
      type: FilterTypes.Picker,
    },
    status: {
      label: 'Story Status',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Ongoing', value: 'ongoing' },
        { label: 'Completed', value: 'completed' },
      ],
      type: FilterTypes.Picker,
    },
    genre: {
      label: 'Genre',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Action', value: '9' },
        { label: 'Adult', value: '902' },
        { label: 'Adventure', value: '8' },
        { label: 'Boys Love', value: '891' },
        { label: 'Comedy', value: '7' },
        { label: 'Drama', value: '903' },
        { label: 'Ecchi', value: '904' },
        { label: 'Fanfiction', value: '38' },
        { label: 'Fantasy', value: '19' },
        { label: 'Gender Bender', value: '905' },
        { label: 'Girls Love', value: '892' },
        { label: 'Harem', value: '1015' },
        { label: 'Historical', value: '21' },
        { label: 'Horror', value: '22' },
        { label: 'Isekai', value: '37' },
        { label: 'Josei', value: '906' },
        { label: 'LitRPG', value: '1180' },
        { label: 'Martial Arts', value: '907' },
        { label: 'Mature', value: '20' },
        { label: 'Mecha', value: '908' },
        { label: 'Mystery', value: '909' },
        { label: 'Psychological', value: '910' },
        { label: 'Romance', value: '6' },
        { label: 'School Life', value: '911' },
        { label: 'Sci-fi', value: '912' },
        { label: 'Seinen', value: '913' },
        { label: 'Slice of Life', value: '914' },
        { label: 'Smut', value: '915' },
        { label: 'Sports', value: '916' },
        { label: 'Supernatural', value: '5' },
        { label: 'Tragedy', value: '901' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new ScribbleHubPlugin();
