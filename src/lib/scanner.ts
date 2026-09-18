import type { RefSpan, RefArticleMember, NumStyle } from '../../shared/model';
import { parseOrdinal } from './numeral';

const NUM = '0-9０-９零一二三四五六七八九十百千万两〇'; // 〇(U+3007) 放在末尾，避免被当作字符范围端点
const N = `[${NUM}]`;
const G = '[\\s　]*';

/** 项的两种写法拆成两个独立可选组：第M项 / （M），避免二选一组导致回溯失效 */
function itemAbs(p: string): string {
  return (
    `(?:${G}第(?<${p}Item>${N}+)${G}项)?` +
    `(?:${G}(?<${p}ItemP>第?（(?<${p}ItemPn>${N}+)）项?))?`
  );
}

/**
 * 总正则按优先级排列：
 * 绝对引用 → 本条链 → 前/后条链 → 前款 → 前项/本项/本款 → 裸（X）
 * 条级组合引用（第三条、第五条及第七条 / 第三条至第五条）由 scanArticleCombos 先行识别，
 * 命中区间内的单条引用不再重复产出。
 */
const REF_SOURCE =
  // 1) 第X条[之Y][【条名】][第N款][第M项/（M）]
  `第(?<aNum>${N}+)${G}条` +
  `(?:${G}之${G}(?<aSuf>${N}+))?` +
  `(?:${G}[【\\[](?<aName>[^】\\]]+)[】\\]])?` +
  `(?:${G}第(?<aPar>${N}+)${G}款)?` +
  itemAbs('a') +
  `|` +
  // 2) 本条[第N款][第M项/（M）]
  `本条(?:${G}第(?<tPar>${N}+)${G}款)?` +
  itemAbs('t') +
  `|` +
  // 3) 前条/上条/后条/下条（可叠用，如“后后条”）
  `(?<chain>(?:前|上|后|下)条|(?:[前上后下]){2,}?条)` +
  `(?:${G}第(?<cPar>${N}+)${G}款)?` +
  itemAbs('c') +
  `|` +
  // 4) 前款[第M项/（M）]
  `前款` +
  itemAbs('pp') +
  `|` +
  // 5) 前项 / 本项 / 本款[第M项]
  `前项|本项|本款(?:${G}第(?<tpItem>${N}+)${G}项)?` +
  `|` +
  // 6) 裸（X）
  `（(?<bItem>${N}+)）`;

interface Pn {
  value: number;
  style: NumStyle;
}

function pickNum(g: RegExpNamedGroups, ...keys: string[]): Pn | null {
  for (const k of keys) {
    const raw = g[k];
    if (raw !== undefined) {
      const parsed = parseOrdinal(raw);
      if (parsed) return parsed;
    }
  }
  return null;
}

type RegExpNamedGroups = Record<string, string | undefined>;

const SUFFIX_WORDS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function suffixWord(value: number): string {
  return SUFFIX_WORDS[value - 1] ?? String(value);
}

// ---------- 条级组合引用（顿号列举 / 至·到闭区间），暂不解析组合中的款、项 ----------

/** 单个“第X条[之Y]”成员，不消费款、项与条名 */
const ART_MEMBER_SOURCE = `第(${N}+)${G}条(?:${G}之${G}(${N}+))?`;
const ART_MEMBER_RE = new RegExp(ART_MEMBER_SOURCE, 'gu');

/** 成员后若直接跟随款 / 项 / 括号项 / 条名，则该表达式不是条级组合（交给单引用扫描） */
const MEMBER_TAIL_BLOCK_RE = new RegExp(
  `^${G}(?:第${N}+${G}[款项]|第?[（(]${N}+[）)]项?|[【\\[])`
);

interface RawMember {
  start: number;
  end: number;
  num: number;
  style: NumStyle;
  suffix?: string;
}

/** 列举连接成分：顿号，或 及/和/与（仅作为成员间间隙时） */
const LIST_GAP_RE = /^[\s　]*(?:、|及|和|与)[\s　]*$/;
const DUNHAO_GAP_RE = /^[\s　]*、[\s　]*$/;
/** 闭区间连接成分：至 / 到 */
const RANGE_GAP_RE = /^[\s　]*(?:至|到)[\s　]*$/;
/** 数字字符判定（用于排除嵌套在更大编号串中的匹配） */
const NUM_CHAR_RE = new RegExp(N, 'u');

/**
 * 扫描条级组合引用：
 * - 列举：第X条[、第Y条]…（及|和|与）第Z条 —— 两成员时必须含顿号，避免“甲和乙”普通并列误判；
 * - 闭区间：第X条 至|到 第Y条（恰好两个端点）。
 * 成员直接带款 / 项 / 条名时不组合（如“第三条第二款、第五条”）。
 */
function scanArticleCombos(text: string): RefSpan[] {
  const members: RawMember[] = [];
  let m: RegExpExecArray | null;
  ART_MEMBER_RE.lastIndex = 0;
  while ((m = ART_MEMBER_RE.exec(text)) !== null) {
    if (m[0].length === 0) continue;
    const parsed = parseOrdinal(m[1]);
    if (!parsed) continue;
    // 起点前紧跟“第”或数字时，说明本匹配嵌在更大的编号串中，不作为组合起点成员
    if (m.index > 0) {
      const prev = text[m.index - 1];
      if (prev === '第' || NUM_CHAR_RE.test(prev)) continue;
    }
    const suf = m[2] !== undefined ? parseOrdinal(m[2]) : null;
    members.push({
      start: m.index,
      end: m.index + m[0].length,
      num: parsed.value,
      style: parsed.style,
      ...(suf ? { suffix: suffixWord(suf.value) } : {}),
    });
  }

  const spans: RefSpan[] = [];
  let i = 0;
  while (i < members.length) {
    const first = members[i];
    const chain = [first];
    const gaps: string[] = [];
    let j = i;
    while (j + 1 < members.length) {
      const cur = members[j];
      const next = members[j + 1];
      const gap = text.slice(cur.end, next.start);
      if (!LIST_GAP_RE.test(gap) && !RANGE_GAP_RE.test(gap)) break;
      chain.push(next);
      gaps.push(gap);
      j += 1;
    }

    const last = chain[chain.length - 1];
    const tailBlocked = MEMBER_TAIL_BLOCK_RE.test(text.slice(last.end));

    let kind: RefSpan['kind'] | null = null;
    if (!tailBlocked && chain.length === 2 && RANGE_GAP_RE.test(gaps[0]) && !LIST_GAP_RE.test(gaps[0])) {
      kind = 'articleRange';
    } else if (
      !tailBlocked &&
      chain.length >= 2 &&
      gaps.every((g) => LIST_GAP_RE.test(g)) &&
      (chain.length >= 3 || DUNHAO_GAP_RE.test(gaps[0]))
    ) {
      kind = 'articleList';
    }

    if (kind) {
      const start = first.start;
      const end = last.end;
      const memberSpans: RefArticleMember[] = chain.map((c) => ({
        start: c.start,
        end: c.end,
        raw: text.slice(c.start, c.end),
        articleNum: c.num,
        ...(c.suffix ? { articleSuffix: c.suffix } : {}),
        articleStyle: c.style,
      }));
      spans.push({
        start,
        end,
        raw: text.slice(start, end),
        kind,
        members: memberSpans,
      });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return spans;
}

/** 扫描一段正文中的全部交叉引用 span（按起始位置升序、互不嵌套） */
export function scanReferences(text: string): RefSpan[] {
  // 先识别条级组合引用，组合区间内的单条引用由其统一代表
  const combos = scanArticleCombos(text);
  const re = new RegExp(REF_SOURCE, 'gu');
  const spans: RefSpan[] = [...combos];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const match = m;
    if (match[0].length === 0) continue;
    // 完全落在某个条级组合区间内（典型：组合中的各“第X条”）则跳过
    if (combos.some((c) => match.index >= c.start && match.index + match[0].length <= c.end))
      continue;
    const g: RegExpNamedGroups = match.groups ?? {};
    const head = match[0];
    let span: RefSpan | null = null;

    if (g['aNum'] !== undefined) {
      const a = parseOrdinal(g['aNum']!);
      if (!a) continue;
      const suf = g['aSuf'] !== undefined ? parseOrdinal(g['aSuf']!) : null;
      const p = pickNum(g, 'aPar');
      const it = pickNum(g, 'aItem', 'aItemPn');
      span = {
        start: match.index,
        end: match.index + head.length,
        raw: head,
        kind: 'absolute',
        articleNum: a.value,
        articleStyle: a.style,
        ...(suf ? { articleSuffix: suffixWord(suf.value) } : {}),
        ...(p ? { paragraphNum: p.value, paragraphStyle: p.style } : {}),
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['aItemP'] !== undefined } : {}),
      };
    } else if (head.startsWith('本条')) {
      const p = pickNum(g, 'tPar');
      const it = pickNum(g, 'tItem', 'tItemPn');
      span = {
        start: match.index,
        end: match.index + head.length,
        raw: head,
        kind: 'this',
        ...(p ? { paragraphNum: p.value, paragraphStyle: p.style } : {}),
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['tItemP'] !== undefined } : {}),
      };
    } else if (g['chain'] !== undefined) {
      const chain = g['chain']!;
      const first = chain[0];
      const dir = first === '前' || first === '上' ? -1 : 1;
      const p = pickNum(g, 'cPar');
      const it = pickNum(g, 'cItem', 'cItemPn');
      span = {
        start: match.index,
        end: match.index + head.length,
        raw: head,
        kind: dir === -1 ? 'prevArticle' : 'nextArticle',
        articleNum: chain.length - 1,
        ...(p ? { paragraphNum: p.value, paragraphStyle: p.style } : {}),
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['cItemP'] !== undefined } : {}),
      };
    } else if (head.startsWith('前款')) {
      const it = pickNum(g, 'ppItem', 'ppItemPn');
      span = {
        start: match.index,
        end: match.index + head.length,
        raw: head,
        kind: 'prevParagraph',
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['ppItemP'] !== undefined } : {}),
      };
    } else if (head.startsWith('前项')) {
      span = { start: match.index, end: match.index + head.length, raw: head, kind: 'prevItem' };
    } else if (head.startsWith('本项')) {
      span = { start: match.index, end: match.index + head.length, raw: head, kind: 'thisItem' };
    } else if (head.startsWith('本款')) {
      const it = pickNum(g, 'tpItem');
      span = {
        start: match.index,
        end: match.index + head.length,
        raw: head,
        kind: 'thisParagraph',
        ...(it ? { itemNum: it.value, itemStyle: it.style } : {}),
      };
    } else if (g['bItem'] !== undefined) {
      const it = parseOrdinal(g['bItem']!);
      if (it) {
        span = {
          start: match.index,
          end: match.index + head.length,
          raw: head,
          kind: 'bareItem',
          itemNum: it.value,
          itemStyle: it.style,
          itemParenForm: true,
        };
      }
    }

    if (span) {
      const covered = spans.some((s) => span!.start >= s.start && span!.end <= s.end);
      if (!covered) spans.push(span);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}
