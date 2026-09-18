import type {
  Analysis,
  ClauseDocument,
  ClauseNode,
  RefOccurrence,
} from '../../shared/model';
import { cloneTree, findNode, renumberAll, touch } from './tree';
import { formatOrdinal } from './numeral';
import { renderArticleCombo } from './analyzer';

/** 节点在树中的绝对结构坐标（id → 坐标） */
export interface Locator {
  nodeId: string;
  articleOrdinal: number;
  suffix: string;
  paragraphIndex: number; // 0 表示条头
  itemIndex: number; // 0 表示非项
}

export function buildLocators(root: ClauseNode[]): Map<string, Locator> {
  const map = new Map<string, Locator>();
  for (const article of root) {
    const base: Locator = {
      nodeId: article.id,
      articleOrdinal: article.ordinal,
      suffix: article.suffix ?? '',
      paragraphIndex: 0,
      itemIndex: 0,
    };
    map.set(article.id, base);
    article.children.forEach((paragraph, pi) => {
      map.set(paragraph.id, { ...base, nodeId: paragraph.id, paragraphIndex: pi + 1 });
      paragraph.children.forEach((item, ii) => {
        map.set(item.id, {
          ...base,
          nodeId: item.id,
          paragraphIndex: pi + 1,
          itemIndex: ii + 1,
        });
      });
    });
  }
  return map;
}

/** 按被引用节点的新坐标生成规范数字（保留原文数字风格与括号写法），不含条名 */
function renderAbsolute(
  loc: Locator,
  occ: RefOccurrence,
  nameSegment: string,
): string {
  const span = occ.span;
  let s = `第${formatOrdinal(loc.articleOrdinal, span.articleStyle)}条`;
  if (loc.suffix) s += `之${loc.suffix}`;
  if (nameSegment) s += nameSegment;
  if (loc.paragraphIndex > 0) {
    s += `第${formatOrdinal(loc.paragraphIndex, span.paragraphStyle ?? 'chinese')}款`;
  }
  if (loc.itemIndex > 0) {
    if (span.itemParenForm) {
      s += `（${formatOrdinal(loc.itemIndex, span.itemStyle ?? 'chinese')}）`;
    } else {
      s += `第${formatOrdinal(loc.itemIndex, span.itemStyle ?? 'chinese')}项`;
    }
  }
  return s;
}

function extractNameSegment(raw: string): string {
  const m = raw.match(/[【[]([^】\]]+)[】\]]/);
  return m ? m[0] : '';
}

function locatorKey(loc: Locator): string {
  return `${loc.articleOrdinal}/${loc.suffix}/${loc.paragraphIndex}/${loc.itemIndex}`;
}

/** 一组条（按文档顺序）是否在条号上连续且均无后缀 */
function isContiguous(locs: Locator[]): boolean {
  if (locs.length < 2) return false;
  return locs.every(
    (l, i) =>
      i === 0 ||
      (l.suffix === '' &&
        locs[i - 1].suffix === '' &&
        l.articleOrdinal === locs[i - 1].articleOrdinal + 1),
  );
}

export interface RewriteResult {
  doc: ClauseDocument;
  rewritten: number;
  /** 因断链/歧义未自动改写的引用 */
  skipped: { nodeId: string; raw: string; reason: string; targetMissing: boolean }[];
}

/**
 * 在 prevDoc 的克隆上执行结构变更 mutator，随后按 prevAnalysis 的解析结果
 * 原子改写所有可唯一定位的绝对引用。相对引用（本条/前款/前项等）保持原文，
 * 由结构位置自动跟随。
 */
export function applyStructuralChange(
  prevDoc: ClauseDocument,
  prevAnalysis: Analysis,
  mutator: (root: ClauseNode[]) => void,
): RewriteResult {
  const root = cloneTree(prevDoc.root);
  mutator(root);
  renumberAll(root);

  const oldLoc = buildLocators(prevDoc.root);
  const newLoc = buildLocators(root);

  // 每个节点收集替换区间
  type Repl = { start: number; end: number; text: string };
  const replsByNode = new Map<string, Repl[]>();
  const skipped: RewriteResult['skipped'] = [];
  let rewritten = 0;

  for (const occ of prevAnalysis.occurrences) {
    const isCombo = occ.span.kind === 'articleList' || occ.span.kind === 'articleRange';

    if (isCombo) {
      // 条级组合引用：整段改写或整段保留
      const res = occ.resolution;
      if (res.status !== 'ok' || !res.targetRefs || res.targetRefs.length < 2) {
        skipped.push({
          nodeId: occ.nodeId,
          raw: occ.span.raw,
          reason: res.reason ?? '组合引用含缺失或歧义目标',
          targetMissing: false,
        });
        continue;
      }

      const targets = res.targetRefs;
      const beforeLocs = targets.map((t) => oldLoc.get(t.nodeId));
      const afterLocs = targets.map((t) => newLoc.get(t.nodeId));

      if (beforeLocs.some((l) => !l)) continue; // 理论上不会发生
      const deleted = targets.filter((_, i) => !afterLocs[i]);
      if (deleted.length > 0) {
        // 任一目标被删除：整段不改写
        skipped.push({
          nodeId: occ.nodeId,
          raw: occ.span.raw,
          reason: `组合引用的 ${deleted.length} 个目标在本次调整中被删除`,
          targetMissing: true,
        });
        continue;
      }

      // 组合中包含“之一/之二”后缀条：闭区间无法表达后缀端点，列举形式在后缀条与同序号条
      // 相邻重排时端点也可能产生歧义，按规格保守处理——整段不改写
      if (afterLocs.some((l) => l!.suffix !== '')) {
        skipped.push({
          nodeId: occ.nodeId,
          raw: occ.span.raw,
          reason:
            occ.span.kind === 'articleRange'
              ? '闭区间包含“之一/之二”后缀条，端点重排后可能有歧义，未自动改写'
              : '组合引用包含“之一/之二”后缀条，端点重排后可能有歧义，未自动改写',
          targetMissing: false,
        });
        continue;
      }

      // 源节点本身被删除则其文本随之消失
      if (!findNode(root, occ.nodeId)) continue;

      const after = afterLocs as NonNullable<(typeof afterLocs)[number]>[];
      const before = beforeLocs as NonNullable<(typeof beforeLocs)[number]>[];
      const beforeContiguous = isContiguous(before);
      const afterContiguous = isContiguous(after);

      // 结构调整后目标一律按文档顺序排列；比较调整前后“文档顺序的身份序列”，
      // 任一目标条号变化或排列被置换（如原 3,4,5 换位为 3,5,4）都需要改写
      const orderOf = (locsRoot: ClauseNode[], id: string) =>
        locsRoot.findIndex((x) => x.id === id);
      const beforeByOrder = [...before].sort(
        (a, b) => orderOf(prevDoc.root, a.nodeId) - orderOf(prevDoc.root, b.nodeId),
      );
      const afterByOrder = [...after].sort(
        (a, b) => orderOf(root, a.nodeId) - orderOf(root, b.nodeId),
      );
      const sequenceChanged = beforeByOrder.some((l, i) => l.nodeId !== afterByOrder[i].nodeId);
      const ordinalChanged = before.some((l, i) => l.articleOrdinal !== after[i].articleOrdinal);

      // 仅当目标条号变化、排列置换，或目标集合的连续性变化（连续↔不连续）时改写
      if (!ordinalChanged && !sequenceChanged && beforeContiguous === afterContiguous) continue;

      // 目标按新文档顺序排列；保留区间表达偏好（原表达式为闭区间且仍连续时输出区间）
      const sortedTargets = afterByOrder.map((l) => ({
        nodeId: l.nodeId,
        articleStyle: targets.find((t) => t.nodeId === l.nodeId)!.articleStyle,
      }));

      const preferRange = occ.span.kind === 'articleRange';
      const text = renderArticleCombo(sortedTargets, root, preferRange);
      const list = replsByNode.get(occ.nodeId) ?? [];
      list.push({ start: occ.span.start, end: occ.span.end, text });
      replsByNode.set(occ.nodeId, list);
      rewritten += 1;
      continue;
    }

    if (occ.span.kind !== 'absolute') continue; // 相对引用位置跟随，不改写

    const targetId = occ.resolution.targetId;
    if (occ.resolution.status === 'broken' || !targetId) {
      skipped.push({
        nodeId: occ.nodeId,
        raw: occ.span.raw,
        reason: occ.resolution.reason ?? '目标无法定位',
        targetMissing: false,
      });
      continue;
    }

    const before = oldLoc.get(targetId);
    const after = newLoc.get(targetId);
    if (!before) continue; // 理论上不会发生

    if (!after) {
      // 目标节点被删除
      skipped.push({
        nodeId: occ.nodeId,
        raw: occ.span.raw,
        reason: '引用目标在本次调整中被删除',
        targetMissing: true,
      });
      continue;
    }

    if (occ.resolution.status === 'ambiguous') {
      // 有歧义且未经用户确认：不得自动改写
      skipped.push({
        nodeId: occ.nodeId,
        raw: occ.span.raw,
        reason: occ.resolution.reason ?? '存在多个候选目标，等待用户确认',
        targetMissing: false,
      });
      continue;
    }

    // 仅当坐标的可见部分（条号/后缀/款号/项号）发生变化时改写
    if (locatorKey(before) === locatorKey(after)) continue;

    // 源节点本身被删除则其文本随之消失
    if (!findNode(root, occ.nodeId)) continue;

    const nameSegment = extractNameSegment(occ.span.raw);
    const text = renderAbsolute(after, occ, nameSegment);
    const list = replsByNode.get(occ.nodeId) ?? [];
    list.push({ start: occ.span.start, end: occ.span.end, text });
    replsByNode.set(occ.nodeId, list);
    rewritten += 1;
  }

  // 按节点应用替换，偏移量累计
  for (const [nodeId, repls] of replsByNode) {
    const found = findNode(root, nodeId);
    if (!found) continue;
    const sorted = [...repls].sort((a, b) => a.start - b.start);
    let text = found.node.text;
    let delta = 0;
    for (const r of sorted) {
      const s = r.start + delta;
      const e = r.end + delta;
      text = text.slice(0, s) + r.text + text.slice(e);
      delta += r.text.length - (r.end - r.start);
    }
    found.node.text = text;
  }

  const doc: ClauseDocument = touch({ ...prevDoc, root });
  return { doc, rewritten, skipped };
}
