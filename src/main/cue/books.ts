/**
 * The canonical 66-book table — bibliographic METADATA only.
 *
 * ## Standing Rule 4
 *
 * Everything in this file is a book *name*, a *count*, or an *abbreviation*. There is no verse
 * text here and there never may be. Book names and chapter counts are bibliographic facts about a
 * work, not the work; the text itself is resolved at runtime from a licensed API or a verified
 * public-domain source (`docs/v2-notes/LEGAL_AND_CONTENT.md`). The Korean 개역한글 (KRV) translation
 * is under a legal hold and must not become selectable as a *text source* — that quarantine lives
 * in the resolver, not here, because Korean book *names* are not KRV content.
 *
 * ## Why the table carries counts at all
 *
 * `chapters` is the cheapest false-positive filter in the whole detector. John has 21 chapters, so
 * "John 99" is not a reference the ASR heard slightly wrong — it is a mis-detection, and dropping
 * it silently is strictly better than offering it. `docs/v2-notes/PLAN_LESSONS.md` Phase-06 records
 * that broad single-token matching was the prior project's main source of false positives.
 *
 * `maxVerse` is deliberately a **conservative upper bound**, not the true maximum verse count of
 * the book's longest chapter. Every value here is at or above the real maximum. That asymmetry is
 * intentional: a `maxVerse` that is too *low* silently rejects a real reference the pastor just
 * spoke (a failure the operator can never see), while one that is too *high* merely lets a rare
 * absurd number through to a suggestion the operator can ignore. Per-chapter verse counts (1,189
 * numbers) were rejected as a hand-authored dataset for exactly that reason — one typo becomes an
 * invisible mid-service failure.
 *
 * ## Ordinal books
 *
 * Numbered books are stored as `ordinal` + `baseName` rather than as an opaque string, because
 * their *spoken* forms diverge far more than their written ones: "first John", "one John",
 * "I John", 요한1서, 요한일서. Generating the variants from `ordinal` keeps all of those in sync
 * with a single edit.
 *
 * Node-global free by construction (pure data + pure functions), though it lives under `src/main`.
 */

/** Old or New Testament. Used only for grouping in the UI. */
export type Testament = 'ot' | 'nt'

/** One canonical book of the Protestant 66-book canon. */
export interface BibleBook {
  /**
   * Canonical English name and the resolution key handed to a Bible provider.
   *
   * For numbered books this is the full spoken-neutral form, e.g. `1 Corinthians`.
   */
  readonly id: string
  /** `1` | `2` | `3` for numbered books, `null` otherwise. */
  readonly ordinal: 1 | 2 | 3 | null
  /** The name without its numeral — `Corinthians` for `1 Corinthians`. Equals `id` when unnumbered. */
  readonly baseName: string
  /** Alternate *full* English names of {@link baseName} (e.g. `Song of Songs`, `Revelations`). */
  readonly aliases: readonly string[]
  /**
   * Standard English abbreviations of {@link baseName}, written WITHOUT the ordinal numeral.
   *
   * Two-letter abbreviations that collide with ordinary English words (`Am`, `Is`, `So`) or with
   * another book (`Co`, `Ti`, `Hb`) are deliberately omitted: an abbreviation match scores
   * `CONFIDENCE_EXACT`, so a collision here is the most expensive kind of mistake the detector can
   * make.
   */
  readonly abbreviations: readonly string[]
  /** Canonical Korean name, e.g. `요한복음`. */
  readonly ko: string
  /** Standard Korean abbreviation, e.g. `요`. */
  readonly koAbbr: string
  /** Other Korean spellings actually spoken or captioned, e.g. `요한1서` for 요한일서. */
  readonly koAliases: readonly string[]
  /** Exact number of chapters. Used to reject impossible references. */
  readonly chapters: number
  /** Conservative upper bound on any chapter's verse count in this book — see the module note. */
  readonly maxVerse: number
  readonly testament: Testament
}

/**
 * Spoken and written forms of each ordinal prefix.
 *
 * `1`/`1st`/`I`/`First` all reach the same book; the detector normalises them to the digit before
 * indexing so that only one key per book survives.
 */
export const ORDINAL_PREFIXES: Readonly<Record<1 | 2 | 3, readonly string[]>> = {
  1: ['1', '1st', 'I', 'First'],
  2: ['2', '2nd', 'II', 'Second'],
  3: ['3', '3rd', 'III', 'Third'],
}

/** Leading ordinal token → digit, applied only when a further token follows (so `Isaiah` is safe). */
export const ORDINAL_WORD_TO_DIGIT: Readonly<Record<string, string>> = {
  '1': '1',
  '1st': '1',
  i: '1',
  one: '1',
  first: '1',
  '2': '2',
  '2nd': '2',
  ii: '2',
  two: '2',
  second: '2',
  '3': '3',
  '3rd': '3',
  iii: '3',
  three: '3',
  third: '3',
}

/**
 * The 66 books, in canonical order.
 *
 * `Jon` is intentionally NOT listed as an abbreviation of Jonah. It is a common given name, and
 * `docs/v2-notes/ASR_PIPELINE.md` uses "Jon 3:16" as the canonical Levenshtein-1 example that must
 * resolve to *John* in the `fuzzy` band. Listing it here would promote that case to `exact` and
 * point it at the wrong book — the exact failure the confidence bands exist to prevent.
 */
export const BOOKS: readonly BibleBook[] = [
  // ── Old Testament ────────────────────────────────────────────────────────────────────────
  {
    id: 'Genesis',
    ordinal: null,
    baseName: 'Genesis',
    aliases: [],
    abbreviations: ['Gen', 'Ge', 'Gn'],
    ko: '창세기',
    koAbbr: '창',
    koAliases: [],
    chapters: 50,
    maxVerse: 70,
    testament: 'ot',
  },
  {
    id: 'Exodus',
    ordinal: null,
    baseName: 'Exodus',
    aliases: [],
    abbreviations: ['Exod', 'Exo', 'Ex'],
    ko: '출애굽기',
    koAbbr: '출',
    koAliases: [],
    chapters: 40,
    maxVerse: 55,
    testament: 'ot',
  },
  {
    id: 'Leviticus',
    ordinal: null,
    baseName: 'Leviticus',
    aliases: [],
    abbreviations: ['Lev', 'Lv'],
    ko: '레위기',
    koAbbr: '레',
    koAliases: [],
    chapters: 27,
    maxVerse: 60,
    testament: 'ot',
  },
  {
    id: 'Numbers',
    ordinal: null,
    baseName: 'Numbers',
    aliases: [],
    abbreviations: ['Num', 'Nm'],
    ko: '민수기',
    koAbbr: '민',
    koAliases: [],
    chapters: 36,
    maxVerse: 95,
    testament: 'ot',
  },
  {
    id: 'Deuteronomy',
    ordinal: null,
    baseName: 'Deuteronomy',
    aliases: [],
    abbreviations: ['Deut', 'Deu', 'Dt'],
    ko: '신명기',
    koAbbr: '신',
    koAliases: [],
    chapters: 34,
    maxVerse: 70,
    testament: 'ot',
  },
  {
    id: 'Joshua',
    ordinal: null,
    baseName: 'Joshua',
    aliases: [],
    abbreviations: ['Josh', 'Jos'],
    ko: '여호수아',
    koAbbr: '수',
    koAliases: [],
    chapters: 24,
    maxVerse: 65,
    testament: 'ot',
  },
  {
    id: 'Judges',
    ordinal: null,
    baseName: 'Judges',
    aliases: [],
    abbreviations: ['Judg', 'Jdg'],
    ko: '사사기',
    koAbbr: '삿',
    koAliases: [],
    chapters: 21,
    maxVerse: 60,
    testament: 'ot',
  },
  {
    id: 'Ruth',
    ordinal: null,
    baseName: 'Ruth',
    aliases: [],
    abbreviations: ['Rth'],
    ko: '룻기',
    koAbbr: '룻',
    koAliases: [],
    chapters: 4,
    maxVerse: 25,
    testament: 'ot',
  },
  {
    id: '1 Samuel',
    ordinal: 1,
    baseName: 'Samuel',
    aliases: [],
    abbreviations: ['Sam', 'Sm'],
    ko: '사무엘상',
    koAbbr: '삼상',
    koAliases: ['사무엘 상'],
    chapters: 31,
    maxVerse: 60,
    testament: 'ot',
  },
  {
    id: '2 Samuel',
    ordinal: 2,
    baseName: 'Samuel',
    aliases: [],
    abbreviations: ['Sam', 'Sm'],
    ko: '사무엘하',
    koAbbr: '삼하',
    koAliases: ['사무엘 하'],
    chapters: 24,
    maxVerse: 60,
    testament: 'ot',
  },
  {
    id: '1 Kings',
    ordinal: 1,
    baseName: 'Kings',
    aliases: [],
    abbreviations: ['Kgs', 'Kin'],
    ko: '열왕기상',
    koAbbr: '왕상',
    koAliases: ['열왕기 상'],
    chapters: 22,
    maxVerse: 70,
    testament: 'ot',
  },
  {
    id: '2 Kings',
    ordinal: 2,
    baseName: 'Kings',
    aliases: [],
    abbreviations: ['Kgs', 'Kin'],
    ko: '열왕기하',
    koAbbr: '왕하',
    koAliases: ['열왕기 하'],
    chapters: 25,
    maxVerse: 50,
    testament: 'ot',
  },
  {
    id: '1 Chronicles',
    ordinal: 1,
    baseName: 'Chronicles',
    aliases: [],
    abbreviations: ['Chron', 'Chr'],
    ko: '역대상',
    koAbbr: '대상',
    koAliases: ['역대 상'],
    chapters: 29,
    maxVerse: 85,
    testament: 'ot',
  },
  {
    id: '2 Chronicles',
    ordinal: 2,
    baseName: 'Chronicles',
    aliases: [],
    abbreviations: ['Chron', 'Chr'],
    ko: '역대하',
    koAbbr: '대하',
    koAliases: ['역대 하'],
    chapters: 36,
    maxVerse: 45,
    testament: 'ot',
  },
  {
    id: 'Ezra',
    ordinal: null,
    baseName: 'Ezra',
    aliases: [],
    abbreviations: ['Ezr'],
    ko: '에스라',
    koAbbr: '스',
    koAliases: [],
    chapters: 10,
    maxVerse: 75,
    testament: 'ot',
  },
  {
    id: 'Nehemiah',
    ordinal: null,
    baseName: 'Nehemiah',
    aliases: [],
    abbreviations: ['Neh'],
    ko: '느헤미야',
    koAbbr: '느',
    koAliases: [],
    chapters: 13,
    maxVerse: 75,
    testament: 'ot',
  },
  {
    id: 'Esther',
    ordinal: null,
    baseName: 'Esther',
    aliases: [],
    abbreviations: ['Esth', 'Est'],
    ko: '에스더',
    koAbbr: '에',
    koAliases: [],
    chapters: 10,
    maxVerse: 35,
    testament: 'ot',
  },
  {
    id: 'Job',
    ordinal: null,
    baseName: 'Job',
    aliases: [],
    abbreviations: [],
    ko: '욥기',
    koAbbr: '욥',
    koAliases: [],
    chapters: 42,
    maxVerse: 45,
    testament: 'ot',
  },
  {
    id: 'Psalms',
    ordinal: null,
    baseName: 'Psalms',
    aliases: ['Psalm'],
    abbreviations: ['Ps', 'Psa', 'Pss'],
    ko: '시편',
    koAbbr: '시',
    koAliases: [],
    chapters: 150,
    maxVerse: 176,
    testament: 'ot',
  },
  {
    id: 'Proverbs',
    ordinal: null,
    baseName: 'Proverbs',
    aliases: [],
    abbreviations: ['Prov', 'Prv'],
    ko: '잠언',
    koAbbr: '잠',
    koAliases: [],
    chapters: 31,
    maxVerse: 40,
    testament: 'ot',
  },
  {
    id: 'Ecclesiastes',
    ordinal: null,
    baseName: 'Ecclesiastes',
    aliases: [],
    abbreviations: ['Eccl', 'Eccles'],
    ko: '전도서',
    koAbbr: '전',
    koAliases: [],
    chapters: 12,
    maxVerse: 30,
    testament: 'ot',
  },
  {
    id: 'Song of Solomon',
    ordinal: null,
    baseName: 'Song of Solomon',
    aliases: ['Song of Songs', 'Canticles'],
    abbreviations: ['Song', 'SoS'],
    ko: '아가',
    koAbbr: '아',
    koAliases: [],
    chapters: 8,
    maxVerse: 20,
    testament: 'ot',
  },
  {
    id: 'Isaiah',
    ordinal: null,
    baseName: 'Isaiah',
    aliases: [],
    abbreviations: ['Isa'],
    ko: '이사야',
    koAbbr: '사',
    koAliases: [],
    chapters: 66,
    maxVerse: 45,
    testament: 'ot',
  },
  {
    id: 'Jeremiah',
    ordinal: null,
    baseName: 'Jeremiah',
    aliases: [],
    abbreviations: ['Jer'],
    ko: '예레미야',
    koAbbr: '렘',
    koAliases: [],
    chapters: 52,
    maxVerse: 70,
    testament: 'ot',
  },
  {
    id: 'Lamentations',
    ordinal: null,
    baseName: 'Lamentations',
    aliases: [],
    abbreviations: ['Lam'],
    ko: '예레미야애가',
    koAbbr: '애',
    koAliases: ['애가'],
    chapters: 5,
    maxVerse: 70,
    testament: 'ot',
  },
  {
    id: 'Ezekiel',
    ordinal: null,
    baseName: 'Ezekiel',
    aliases: [],
    abbreviations: ['Ezek', 'Eze'],
    ko: '에스겔',
    koAbbr: '겔',
    koAliases: [],
    chapters: 48,
    maxVerse: 70,
    testament: 'ot',
  },
  {
    id: 'Daniel',
    ordinal: null,
    baseName: 'Daniel',
    aliases: [],
    abbreviations: ['Dan', 'Dn'],
    ko: '다니엘',
    koAbbr: '단',
    koAliases: [],
    chapters: 12,
    maxVerse: 50,
    testament: 'ot',
  },
  {
    id: 'Hosea',
    ordinal: null,
    baseName: 'Hosea',
    aliases: [],
    abbreviations: ['Hos'],
    ko: '호세아',
    koAbbr: '호',
    koAliases: [],
    chapters: 14,
    maxVerse: 25,
    testament: 'ot',
  },
  {
    id: 'Joel',
    ordinal: null,
    baseName: 'Joel',
    aliases: [],
    abbreviations: ['Joe'],
    ko: '요엘',
    koAbbr: '욜',
    koAliases: [],
    chapters: 3,
    maxVerse: 35,
    testament: 'ot',
  },
  {
    id: 'Amos',
    ordinal: null,
    baseName: 'Amos',
    aliases: [],
    abbreviations: ['Amo'],
    ko: '아모스',
    koAbbr: '암',
    koAliases: [],
    chapters: 9,
    maxVerse: 30,
    testament: 'ot',
  },
  {
    id: 'Obadiah',
    ordinal: null,
    baseName: 'Obadiah',
    aliases: [],
    abbreviations: ['Obad', 'Oba'],
    ko: '오바댜',
    koAbbr: '옵',
    koAliases: [],
    chapters: 1,
    maxVerse: 25,
    testament: 'ot',
  },
  {
    id: 'Jonah',
    ordinal: null,
    baseName: 'Jonah',
    aliases: [],
    abbreviations: ['Jnh'],
    ko: '요나',
    koAbbr: '욘',
    koAliases: [],
    chapters: 4,
    maxVerse: 20,
    testament: 'ot',
  },
  {
    id: 'Micah',
    ordinal: null,
    baseName: 'Micah',
    aliases: [],
    abbreviations: ['Mic'],
    ko: '미가',
    koAbbr: '미',
    koAliases: [],
    chapters: 7,
    maxVerse: 25,
    testament: 'ot',
  },
  {
    id: 'Nahum',
    ordinal: null,
    baseName: 'Nahum',
    aliases: [],
    abbreviations: ['Nah'],
    ko: '나훔',
    koAbbr: '나',
    koAliases: [],
    chapters: 3,
    maxVerse: 25,
    testament: 'ot',
  },
  {
    id: 'Habakkuk',
    ordinal: null,
    baseName: 'Habakkuk',
    aliases: [],
    abbreviations: ['Hab'],
    ko: '하박국',
    koAbbr: '합',
    koAliases: [],
    chapters: 3,
    maxVerse: 25,
    testament: 'ot',
  },
  {
    id: 'Zephaniah',
    ordinal: null,
    baseName: 'Zephaniah',
    aliases: [],
    abbreviations: ['Zeph', 'Zep'],
    ko: '스바냐',
    koAbbr: '습',
    koAliases: [],
    chapters: 3,
    maxVerse: 25,
    testament: 'ot',
  },
  {
    id: 'Haggai',
    ordinal: null,
    baseName: 'Haggai',
    aliases: [],
    abbreviations: ['Hag'],
    ko: '학개',
    koAbbr: '학',
    koAliases: [],
    chapters: 2,
    maxVerse: 25,
    testament: 'ot',
  },
  {
    id: 'Zechariah',
    ordinal: null,
    baseName: 'Zechariah',
    aliases: [],
    abbreviations: ['Zech', 'Zec'],
    ko: '스가랴',
    koAbbr: '슥',
    koAliases: [],
    chapters: 14,
    maxVerse: 25,
    testament: 'ot',
  },
  {
    id: 'Malachi',
    ordinal: null,
    baseName: 'Malachi',
    aliases: [],
    abbreviations: ['Mal'],
    ko: '말라기',
    koAbbr: '말',
    koAliases: [],
    chapters: 4,
    maxVerse: 25,
    testament: 'ot',
  },

  // ── New Testament ────────────────────────────────────────────────────────────────────────
  {
    id: 'Matthew',
    ordinal: null,
    baseName: 'Matthew',
    aliases: [],
    abbreviations: ['Matt', 'Mat', 'Mt'],
    ko: '마태복음',
    koAbbr: '마',
    koAliases: ['마태'],
    chapters: 28,
    maxVerse: 80,
    testament: 'nt',
  },
  {
    id: 'Mark',
    ordinal: null,
    baseName: 'Mark',
    aliases: [],
    abbreviations: ['Mrk', 'Mk'],
    ko: '마가복음',
    koAbbr: '막',
    koAliases: ['마가'],
    chapters: 16,
    maxVerse: 75,
    testament: 'nt',
  },
  {
    id: 'Luke',
    ordinal: null,
    baseName: 'Luke',
    aliases: [],
    abbreviations: ['Luk', 'Lk'],
    ko: '누가복음',
    koAbbr: '눅',
    koAliases: ['누가'],
    chapters: 24,
    maxVerse: 85,
    testament: 'nt',
  },
  {
    id: 'John',
    ordinal: null,
    baseName: 'John',
    aliases: [],
    abbreviations: ['Jhn', 'Joh', 'Jn'],
    ko: '요한복음',
    koAbbr: '요',
    koAliases: ['요한'],
    chapters: 21,
    maxVerse: 75,
    testament: 'nt',
  },
  {
    id: 'Acts',
    ordinal: null,
    baseName: 'Acts',
    aliases: ['Acts of the Apostles'],
    abbreviations: ['Ac'],
    ko: '사도행전',
    koAbbr: '행',
    koAliases: [],
    chapters: 28,
    maxVerse: 65,
    testament: 'nt',
  },
  {
    id: 'Romans',
    ordinal: null,
    baseName: 'Romans',
    aliases: [],
    abbreviations: ['Rom', 'Ro'],
    ko: '로마서',
    koAbbr: '롬',
    koAliases: [],
    chapters: 16,
    maxVerse: 35,
    testament: 'nt',
  },
  {
    id: '1 Corinthians',
    ordinal: 1,
    baseName: 'Corinthians',
    aliases: [],
    abbreviations: ['Cor', 'Co'],
    ko: '고린도전서',
    koAbbr: '고전',
    koAliases: ['고린도 전서'],
    chapters: 16,
    maxVerse: 60,
    testament: 'nt',
  },
  {
    id: '2 Corinthians',
    ordinal: 2,
    baseName: 'Corinthians',
    aliases: [],
    abbreviations: ['Cor', 'Co'],
    ko: '고린도후서',
    koAbbr: '고후',
    koAliases: ['고린도 후서'],
    chapters: 13,
    maxVerse: 35,
    testament: 'nt',
  },
  {
    id: 'Galatians',
    ordinal: null,
    baseName: 'Galatians',
    aliases: [],
    abbreviations: ['Gal'],
    ko: '갈라디아서',
    koAbbr: '갈',
    koAliases: [],
    chapters: 6,
    maxVerse: 35,
    testament: 'nt',
  },
  {
    id: 'Ephesians',
    ordinal: null,
    baseName: 'Ephesians',
    aliases: [],
    abbreviations: ['Eph', 'Ephes'],
    ko: '에베소서',
    koAbbr: '엡',
    koAliases: [],
    chapters: 6,
    maxVerse: 35,
    testament: 'nt',
  },
  {
    id: 'Philippians',
    ordinal: null,
    baseName: 'Philippians',
    aliases: [],
    abbreviations: ['Phil', 'Php'],
    ko: '빌립보서',
    koAbbr: '빌',
    koAliases: [],
    chapters: 4,
    maxVerse: 35,
    testament: 'nt',
  },
  {
    id: 'Colossians',
    ordinal: null,
    baseName: 'Colossians',
    aliases: [],
    abbreviations: ['Col'],
    ko: '골로새서',
    koAbbr: '골',
    koAliases: [],
    chapters: 4,
    maxVerse: 35,
    testament: 'nt',
  },
  {
    id: '1 Thessalonians',
    ordinal: 1,
    baseName: 'Thessalonians',
    aliases: [],
    abbreviations: ['Thess', 'Thes', 'Th'],
    ko: '데살로니가전서',
    koAbbr: '살전',
    koAliases: ['데살로니가 전서'],
    chapters: 5,
    maxVerse: 30,
    testament: 'nt',
  },
  {
    id: '2 Thessalonians',
    ordinal: 2,
    baseName: 'Thessalonians',
    aliases: [],
    abbreviations: ['Thess', 'Thes', 'Th'],
    ko: '데살로니가후서',
    koAbbr: '살후',
    koAliases: ['데살로니가 후서'],
    chapters: 3,
    maxVerse: 20,
    testament: 'nt',
  },
  {
    id: '1 Timothy',
    ordinal: 1,
    baseName: 'Timothy',
    aliases: [],
    abbreviations: ['Tim'],
    ko: '디모데전서',
    koAbbr: '딤전',
    koAliases: ['디모데 전서'],
    chapters: 6,
    maxVerse: 30,
    testament: 'nt',
  },
  {
    id: '2 Timothy',
    ordinal: 2,
    baseName: 'Timothy',
    aliases: [],
    abbreviations: ['Tim'],
    ko: '디모데후서',
    koAbbr: '딤후',
    koAliases: ['디모데 후서'],
    chapters: 4,
    maxVerse: 30,
    testament: 'nt',
  },
  {
    id: 'Titus',
    ordinal: null,
    baseName: 'Titus',
    aliases: [],
    abbreviations: ['Tit'],
    ko: '디도서',
    koAbbr: '딛',
    koAliases: [],
    chapters: 3,
    maxVerse: 20,
    testament: 'nt',
  },
  {
    id: 'Philemon',
    ordinal: null,
    baseName: 'Philemon',
    aliases: [],
    abbreviations: ['Phlm', 'Phm', 'Philem'],
    ko: '빌레몬서',
    koAbbr: '몬',
    koAliases: [],
    chapters: 1,
    maxVerse: 30,
    testament: 'nt',
  },
  {
    id: 'Hebrews',
    ordinal: null,
    baseName: 'Hebrews',
    aliases: [],
    abbreviations: ['Heb'],
    ko: '히브리서',
    koAbbr: '히',
    koAliases: [],
    chapters: 13,
    maxVerse: 45,
    testament: 'nt',
  },
  {
    id: 'James',
    ordinal: null,
    baseName: 'James',
    aliases: [],
    abbreviations: ['Jas'],
    ko: '야고보서',
    koAbbr: '약',
    koAliases: [],
    chapters: 5,
    maxVerse: 30,
    testament: 'nt',
  },
  {
    id: '1 Peter',
    ordinal: 1,
    baseName: 'Peter',
    aliases: [],
    abbreviations: ['Pet', 'Pt'],
    ko: '베드로전서',
    koAbbr: '벧전',
    koAliases: ['베드로 전서'],
    chapters: 5,
    maxVerse: 30,
    testament: 'nt',
  },
  {
    id: '2 Peter',
    ordinal: 2,
    baseName: 'Peter',
    aliases: [],
    abbreviations: ['Pet', 'Pt'],
    ko: '베드로후서',
    koAbbr: '벧후',
    koAliases: ['베드로 후서'],
    chapters: 3,
    maxVerse: 25,
    testament: 'nt',
  },
  {
    id: '1 John',
    ordinal: 1,
    baseName: 'John',
    aliases: [],
    abbreviations: ['Jhn', 'Jn'],
    ko: '요한일서',
    koAbbr: '요일',
    koAliases: ['요한1서'],
    chapters: 5,
    maxVerse: 30,
    testament: 'nt',
  },
  {
    id: '2 John',
    ordinal: 2,
    baseName: 'John',
    aliases: [],
    abbreviations: ['Jhn', 'Jn'],
    ko: '요한이서',
    koAbbr: '요이',
    koAliases: ['요한2서'],
    chapters: 1,
    maxVerse: 15,
    testament: 'nt',
  },
  {
    id: '3 John',
    ordinal: 3,
    baseName: 'John',
    aliases: [],
    abbreviations: ['Jhn', 'Jn'],
    ko: '요한삼서',
    koAbbr: '요삼',
    koAliases: ['요한3서'],
    chapters: 1,
    maxVerse: 20,
    testament: 'nt',
  },
  {
    id: 'Jude',
    ordinal: null,
    baseName: 'Jude',
    aliases: [],
    abbreviations: ['Jde'],
    ko: '유다서',
    koAbbr: '유',
    koAliases: [],
    chapters: 1,
    maxVerse: 30,
    testament: 'nt',
  },
  {
    id: 'Revelation',
    ordinal: null,
    baseName: 'Revelation',
    aliases: ['Revelations', 'The Revelation', 'Apocalypse'],
    abbreviations: ['Rev'],
    ko: '요한계시록',
    koAbbr: '계',
    koAliases: ['계시록'],
    chapters: 22,
    maxVerse: 30,
    testament: 'nt',
  },
]

/** Exactly 66 books — asserted by the test suite, so a bad edit fails loudly rather than quietly. */
export const BOOK_COUNT = 66

const BY_ID: ReadonlyMap<string, BibleBook> = new Map(BOOKS.map((book) => [book.id, book]))

/** Look a book up by its canonical id, or `null` when it is not a canonical book. */
export function findBookById(id: string): BibleBook | null {
  return BY_ID.get(id) ?? null
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/**
 * Normalise an English book form to its index key.
 *
 * Lower-cases, folds `.` to a space, collapses whitespace, maps a *leading* ordinal token to its
 * digit, then removes the remaining spaces. The ordinal fold is applied only when another token
 * follows, so `Isaiah` is never mangled into `1saiah` by the roman-numeral `i`.
 */
export function normalizeEnglishName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) return ''
  const parts = cleaned.split(' ')
  const head = parts[0]
  if (parts.length > 1 && head !== undefined) {
    const digit = ORDINAL_WORD_TO_DIGIT[head]
    if (digit !== undefined) parts[0] = digit
  }
  return parts.join('')
}

/** Normalise a Korean book form to its index key — Korean has no case, so only spacing folds. */
export function normalizeKoreanName(raw: string): string {
  return raw.replace(/\s+/g, '')
}

/**
 * Every written/spoken English form of a book, including abbreviations.
 *
 * For a numbered book this is the cross-product of {@link ORDINAL_PREFIXES} with the base name,
 * its aliases and its abbreviations. The bare base name of a numbered book (`Corinthians` with no
 * numeral) is deliberately excluded: it is genuinely ambiguous between two books, and guessing
 * would put the wrong epistle on the congregation screen at `exact` confidence.
 */
export function englishVariants(book: BibleBook): readonly string[] {
  const bases = [book.baseName, ...book.aliases, ...book.abbreviations]
  if (book.ordinal === null) return dedupe(bases)
  const out: string[] = []
  for (const prefix of ORDINAL_PREFIXES[book.ordinal]) {
    for (const base of bases) out.push(`${prefix} ${base}`)
  }
  return dedupe(out)
}

/**
 * Full English *names* only — no abbreviations.
 *
 * This is the set the fuzzy (Levenshtein) matcher searches. Fuzzy-matching an abbreviation is a
 * guess layered on a guess: `room` is one edit from `Rom`, and "meet in room 3:16" would become
 * Romans at `fuzzy` confidence. Against full names only, `room` → `Romans` is three edits and
 * falls below the discard floor, while the case the bands were designed for — `Jon` → `John` —
 * still lands at one edit.
 */
export function englishFullNames(book: BibleBook): readonly string[] {
  const bases = [book.baseName, ...book.aliases]
  if (book.ordinal === null) return dedupe(bases)
  const out: string[] = []
  for (const prefix of ORDINAL_PREFIXES[book.ordinal]) {
    for (const base of bases) out.push(`${prefix} ${base}`)
  }
  return dedupe(out)
}

/** Every Korean form of a book, including its abbreviation. */
export function koreanVariants(book: BibleBook): readonly string[] {
  return dedupe([book.ko, ...book.koAliases, book.koAbbr])
}

/** Full Korean names only — the fuzzy matcher's set, for the same reason as {@link englishFullNames}. */
export function koreanFullNames(book: BibleBook): readonly string[] {
  return dedupe([book.ko, ...book.koAliases])
}

/** Whether `chapter` can exist in `book`. */
export function isValidChapter(book: BibleBook, chapter: number): boolean {
  return Number.isInteger(chapter) && chapter >= 1 && chapter <= book.chapters
}

/** Whether `verse` can exist anywhere in `book`, using the conservative {@link BibleBook.maxVerse}. */
export function isValidVerse(book: BibleBook, verse: number): boolean {
  return Number.isInteger(verse) && verse >= 1 && verse <= book.maxVerse
}
