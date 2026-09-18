import type {
  Analysis,
  ArticleEdge,
  ClauseDocument,
  ClauseNode,
  Issue,
  NodePlacement,
  RefArticleMember,
  RefOccurrence,
  RefResolution,
  RefSpan,
  RefTargetEntry,
  RefMissingEntry,
} from '../../shared/model';
import { scanReferences } from './scanner';
import { formatOrdinal } from './numeral';

interface FlatNode {
  node: ClauseNode;
  placement: NodePlacement;
}

/** 扁平索引 + 位置表 */
function flatten(doc: ClauseDocument): {
  byId: Map<string, FlatNode>;
  articles: ClauseNode[];
} {
  const byId = new Map<string, FlatNode>();
  doc.root.forEach((article, ai) => {
    byId.set(article.id, {
      node: article,
      placement: { article, articleIndex: ai, paragraphIndex: 0, itemIndex: 0 },
    });
    article.children.forEach((paragraph, pi) => {
      byId.set(paragraph.id, {
        node: paragraph,
        placement: { article, articleIndex: ai, paragraph, paragraphIndex: pi + 1, itemIndex: 0 },
      });
      paragraph.children.forEach((item, ii) => {
        byId.set(item.id, {
          node: item,
          placement: {
            article,
            articleIndex: ai,
            paragraph,
            paragraphIndex: pi + 1,
            item,
            itemIndex: ii + 1,
          },
        });
      });
    });
  });
  return { byId, articles: doc.root };
}

/** 构造确认签名：同节点内、同原文、第 N 次出现（不依赖字符偏移） */
function signatureFor(nodeId: string, span: RefSpan, occurrenceIndex: number): string {
  return `${nodeId}::${span.raw}::${occurrenceIndex}`;
}

export interface AnalyzeOptions {
  /** 歧义引用确认：signature -> targetId */
  confirmed: Record<string, string>;
}

/** 完整分析文档：解析引用、计算问题与边 */
export function analyze(doc: ClauseDocument, opts: AnalyzeOptions = { confirmed: {} }): Analysis {
  const { byId, articles } = flatten(doc);
  const placement: Record<string, NodePlacement> = {};
  const nodes: Record<string, ClauseNode> = {};
  byId.forEach((v, id) => {
    placement[id] = v.placement;
    nodes[id] = v.node;
  });

  // 第一遍：扫描所有节点文本
  const raw: { nodeId: string; span: RefSpan; occurrenceIndex: number }[] = [];
  byId.forEach(({ node }, nodeId) => {
    if (!node.text) return;
    const spans = scanReferences(node.text);
    const seen = new Map<string, number>();
    for (const span of spans) {
      const k = `${span.raw}`;
      const idx = (seen.get(k) ?? 0) + 1;
      seen.set(k, idx);
      raw.push({ nodeId, span, occurrenceIndex: idx });
    }
  });

  const findArticle = (ordinal: number, suffix?: string): ClauseNode | undefined =>
    articles.find((a) => a.ordinal === ordinal && (a.suffix ?? '') === (suffix ?? ''));

  /** 条级组合引用（列举 / 闭区间）：解析为按文档顺序、去重的稳定条 ID 集合 */
  const resolveCombo = (span: RefSpan): RefResolution => {
    const written = span.members ?? [];
    let wanted: RefArticleMember[];

    if (span.kind === 'articleRange' && written.length === 2) {
      // 闭区间：两个端点都存在时展开为按 ordinal 连续的全部条；任一端点缺失即整段失败
      const [loMember, hiMember] = written;
      const lo = findArticle(loMember.articleNum, loMember.articleSuffix);
      const hi = findArticle(hiMember.articleNum, hiMember.articleSuffix);
      const endpoints: { member: RefArticleMember; article?: ClauseNode }[] = [
        { member: loMember, article: lo },
        { member: hiMember, article: hi },
      ];
      if (!lo || !hi) {
        const missing: RefMissingEntry[] = endpoints
          .filter((e) => !e.article)
          .map((e) => ({
            raw: e.member.raw,
            articleNum: e.member.articleNum,
            ...(e.member.articleSuffix ? { articleSuffix: e.member.articleSuffix } : {}),
            status: 'broken',
            reason: `找不到“${e.member.raw}”，闭区间端点不完整`,
          }));
        const resolved: RefTargetEntry[] = endpoints
          .filter((e) => e.article)
          .map((e) => ({
            nodeId: e.article!.id,
            articleStyle: e.member.articleStyle ?? 'chinese',
          }));
        return {
          status: 'broken',
          reason: `闭区间“${span.raw}”端点不完整，无法确定全部目标`,
          targetIds: resolved.map((r) => r.nodeId),
          targetRefs: resolved,
          missing,
        };
      }
      const loIdx = articles.indexOf(lo);
      const hiIdx = articles.indexOf(hi);
      if (loIdx > hiIdx) {
        return {
          status: 'broken',
          reason: `闭区间“${span.raw}”起端位于止端之后（第${formatOrdinal(
            lo.ordinal,
          )}条在第${formatOrdinal(hi.ordinal)}条之后）`,
          targetIds: [lo.id, hi.id],
          targetRefs: [
            { nodeId: lo.id, articleStyle: loMember.articleStyle ?? 'chinese' },
            { nodeId: hi.id, articleStyle: hiMember.articleStyle ?? 'chinese' },
          ],
          missing: [],
        };
      }
      wanted = articles
        .slice(loIdx, hiIdx + 1)
        .map((a) => ({
          start: 0,
          end: 0,
          raw: articleLabel(a),
          articleNum: a.ordinal,
          ...(a.suffix ? { articleSuffix: a.suffix } : {}),
          articleStyle: loMember.articleStyle ?? 'chinese',
        }));
    } else {
      wanted = written;
    }

    const resolved: RefTargetEntry[] = [];
    const missing: RefMissingEntry[] = [];
    let ambiguous = false;
    const seen = new Set<string>();

    for (const member of wanted) {
      // 无后缀且文档中存在多个同序号条（含“之一/之二”后缀条）：端点歧义
      if (!member.articleSuffix) {
        const sameOrdinal = articles.filter((a) => a.ordinal === member.articleNum);
        if (sameOrdinal.length > 1) {
          ambiguous = true;
          missing.push({
            raw: member.raw,
            articleNum: member.articleNum,
            status: 'ambiguous',
            reason: `存在 ${sameOrdinal.length} 个“第${formatOrdinal(
              member.articleNum,
              member.articleStyle,
            )}条”（含“之一/之二”后缀条）`,
            candidates: sameOrdinal.map((a) => a.id),
          });
          continue;
        }
      }
      const article = findArticle(member.articleNum, member.articleSuffix);
      if (!article) {
        missing.push({
          raw: member.raw,
          articleNum: member.articleNum,
          ...(member.articleSuffix ? { articleSuffix: member.articleSuffix } : {}),
          status: 'broken',
          reason: `找不到“${member.raw}”`,
        });
        continue;
      }
      if (!seen.has(article.id)) {
        seen.add(article.id);
        resolved.push({ nodeId: article.id, articleStyle: member.articleStyle ?? 'chinese' });
      }
    }

    // 已解析目标按文档顺序排列（区间展开时本就有序，列举引用在此统一排序）
    resolved.sort(
      (a, b) => articles.findIndex((x) => x.id === a.nodeId) - articles.findIndex((x) => x.id === b.nodeId),
    );
    const targetIds = resolved.map((r) => r.nodeId);

    if (ambiguous) {
      return {
        status: 'ambiguous',
        reason: `组合引用“${span.raw}”中存在同序号条，端点有歧义`,
        targetIds: targetIds.length ? targetIds : undefined,
        targetRefs: resolved.length ? resolved : undefined,
        missing,
      };
    }
    if (missing.length > 0) {
      return {
        status: 'broken',
        reason: `组合引用“${span.raw}”有 ${missing.length} 个目标不存在`,
        targetIds,
        targetRefs: resolved,
        missing,
      };
    }
    if (targetIds.length < 2) {
      // 全部成员解析到同一条（如“第三条、第三条”）：不构成多目标组合
      return {
        status: 'broken',
        reason: `组合引用“${span.raw}”的成员未指向不同的条`,
        targetIds,
        targetRefs: resolved,
        missing: [],
      };
    }
    return {
      status: 'ok',
      targetId: targetIds[0],
      targetIds,
      targetRefs: resolved,
      canonical: comboCanonical(resolved, articles, span.kind === 'articleRange'),
    };
  };

  const resolve = (
    nodeId: string,
    span: RefSpan,
  ): { resolution: RefResolution; target?: ClauseNode } => {
    const here = byId.get(nodeId);
    if (!here) return { resolution: { status: 'broken', reason: '源节点不存在' } };
    const { placement: hp } = here;

    if (span.kind === 'articleList' || span.kind === 'articleRange') {
      return { resolution: resolveCombo(span) };
    }

    let article: ClauseNode | undefined;
    let paragraphNum: number | undefined;
    let itemNum: number | undefined;
    let reason = '';

    switch (span.kind) {
      case 'absolute': {
        article = findArticle(span.articleNum!, span.articleSuffix);
        if (!article) {
          reason = span.articleSuffix
            ? `找不到“第${formatOrdinal(span.articleNum!, span.articleStyle)}条之${span.articleSuffix}”`
            : `找不到“第${formatOrdinal(span.articleNum!, span.articleStyle)}条”`;
          break;
        }
        paragraphNum = span.paragraphNum;
        itemNum = span.itemNum;
        break;
      }
      case 'this':
        article = hp.article;
        paragraphNum = span.paragraphNum;
        itemNum = span.itemNum;
        break;
      case 'prevArticle':
      case 'nextArticle': {
        const steps = span.articleNum ?? 1;
        const idx = hp.articleIndex + (span.kind === 'prevArticle' ? -steps : steps);
        article = articles[idx];
        if (!article) {
          reason = span.kind === 'prevArticle' ? '引用越过了第一条' : '引用越过了最后一条';
        }
        paragraphNum = span.paragraphNum;
        itemNum = span.itemNum;
        break;
      }
      case 'prevParagraph': {
        article = hp.article;
        if (hp.paragraphIndex <= 1) {
          reason = '本条内不存在前款';
          break;
        }
        paragraphNum = hp.paragraphIndex - 1;
        itemNum = span.itemNum;
        break;
      }
      case 'thisParagraph': {
        article = hp.article;
        if (!hp.paragraph) {
          reason = '“本款”出现在条头，当前没有款';
          break;
        }
        paragraphNum = hp.paragraphIndex;
        itemNum = span.itemNum;
        break;
      }
      case 'prevItem': {
        article = hp.article;
        if (!hp.paragraph || hp.itemIndex <= 1) {
          reason = '当前款内不存在前项';
          break;
        }
        paragraphNum = hp.paragraphIndex;
        itemNum = hp.itemIndex - 1;
        break;
      }
      case 'thisItem': {
        article = hp.article;
        if (!hp.item) {
          reason = '“本项”出现在非项节点中';
          break;
        }
        paragraphNum = hp.paragraphIndex;
        itemNum = hp.itemIndex;
        break;
      }
      case 'bareItem': {
        // （X） 默认指向当前款的第 X 项；在非项/非款语境时歧义
        article = hp.article;
        if (!hp.paragraph) {
          reason = '“（X）”形式出现在没有款结构的条头';
          break;
        }
        paragraphNum = hp.paragraphIndex;
        itemNum = span.itemNum;
        break;
      }
    }

    if (!article) return { resolution: { status: 'broken', reason } };

    let target: ClauseNode = article;

    if (paragraphNum !== undefined) {
      const paragraph = article.children[paragraphNum - 1];
      if (!paragraph) {
        return {
          resolution: {
            status: 'broken',
            reason: `第${articleLabel(article)}只有 ${article.children.length} 款，不存在第${formatOrdinal(
              paragraphNum,
              span.paragraphStyle,
            )}款`,
          },
        };
      }
      target = paragraph;
      if (itemNum !== undefined) {
        const item = paragraph.children[itemNum - 1];
        if (!item) {
          return {
            resolution: {
              status: 'broken',
              reason: `第${articleLabel(article)}第${formatOrdinal(
                paragraphNum,
                span.paragraphStyle,
              )}款只有 ${paragraph.children.length} 项，不存在第${formatOrdinal(
                itemNum,
                span.itemStyle,
              )}项`,
            },
          };
        }
        target = item;
      }
    } else if (itemNum !== undefined) {
      // 直接给项号但没给款号：跨款唯一项才算定位成功
      const matches: ClauseNode[] = [];
      for (const p of article.children) {
        if (p.children[itemNum - 1]) matches.push(p.children[itemNum - 1]);
      }
      if (matches.length === 1) {
        target = matches[0];
      } else if (matches.length === 0) {
        return {
          resolution: {
            status: 'broken',
            reason: `第${articleLabel(article)}不存在第${formatOrdinal(itemNum, span.itemStyle)}项`,
          },
        };
      } else {
        return {
          resolution: {
            status: 'ambiguous',
            candidates: matches.map((n) => n.id),
            reason: `第${formatOrdinal(itemNum, span.itemStyle)}项在 ${matches.length} 款中均存在`,
          },
        };
      }
    }

    // 后缀条引用，且文档中存在多个同序号候选时，标记歧义
    if (span.kind === 'absolute' && !span.articleSuffix) {
      const sameOrdinal = articles.filter((a) => a.ordinal === span.articleNum);
      if (sameOrdinal.length > 1) {
        return {
          resolution: {
            status: 'ambiguous',
            candidates: sameOrdinal.map((n) => n.id),
            reason: `存在 ${sameOrdinal.length} 个“第${formatOrdinal(
              span.articleNum!,
              span.articleStyle,
            )}条”（含“之一/之二”后缀条）`,
          },
        };
      }
    }

    return {
      resolution: {
        status: 'ok',
        targetId: target.id,
        canonical: canonicalText(span, target, placement[target.id]),
      },
      target,
    };
  };

  // 第二遍：解析 + 应用用户确认（确认后解析为 ok，但保留 ambiguity 供复核/撤销）
  const occurrences: RefOccurrence[] = [];
  for (const { nodeId, span, occurrenceIndex } of raw) {
    const signature = signatureFor(nodeId, span, occurrenceIndex);
    const { resolution } = resolve(nodeId, span);
    let finalResolution = resolution;
    if (resolution.status === 'ambiguous') {
      const confirmedId = opts.confirmed[signature];
      if (confirmedId && byId.has(confirmedId)) {
        const targetNode = byId.get(confirmedId)!.node;
        finalResolution = {
          status: 'ok',
          targetId: confirmedId,
          canonical: canonicalText(span, targetNode, placement[confirmedId]),
          ambiguity: {
            candidates: resolution.candidates ?? [],
            reason: resolution.reason,
          },
        };
      }
    }
    occurrences.push({
      key: `${nodeId}:${span.start}:${span.end}`,
      nodeId,
      span,
      resolution: finalResolution,
      occurrenceIndex,
      signature,
    });
  }

  const byNode: Record<string, RefOccurrence[]> = {};
  for (const occ of occurrences) {
    (byNode[occ.nodeId] ??= []).push(occ);
  }

  // 边（条级）：组合引用对每个已解析目标都建立一条边
  const edges: ArticleEdge[] = [];
  for (const occ of occurrences) {
    const src = placement[occ.nodeId];
    if (!src) continue;
    const isCombo = occ.span.kind === 'articleList' || occ.span.kind === 'articleRange';
    const targetIds = isCombo
      ? occ.resolution.targetIds ?? []
      : occ.resolution.status === 'ok' && occ.resolution.targetId
        ? [occ.resolution.targetId]
        : [];
    for (const targetId of targetIds) {
      const dst = placement[targetId];
      if (!dst) continue;
      edges.push({
        sourceArticleId: src.article.id,
        targetArticleId: dst.article.id,
        sourceNodeId: occ.nodeId,
        targetNodeId: targetId,
        kind: occ.span.kind,
        status: occ.resolution.status,
        refKey: occ.key,
      });
    }
  }

  // 问题：断链 / 自引用 / 歧义
  const issues: Issue[] = [];
  for (const occ of occurrences) {
    const text = nodes[occ.nodeId]?.text ?? '';
    const sentence = locateSentence(text, occ.span.start, occ.span.end);
    const base = {
      key: `iss:${occ.key}`,
      sourceNodeId: occ.nodeId,
      sentenceStart: sentence.start,
      sentenceEnd: sentence.end,
      refStart: occ.span.start,
      refEnd: occ.span.end,
      refKey: occ.key,
    };
    if (occ.span.kind === 'articleList' || occ.span.kind === 'articleRange') {
      // 条级组合引用：断链 / 歧义时在问题面板列出已解析与缺失（或歧义）目标
      if (occ.resolution.status === 'broken' || occ.resolution.status === 'ambiguous') {
        const type = occ.resolution.status === 'broken' ? 'broken' : 'ambiguous';
        const resolvedLabels = (occ.resolution.targetIds ?? [])
          .map((id) => '第' + articleLabel(placement[id].article));
        const missingLabels = (occ.resolution.missing ?? []).map(
          (m) => `“${m.raw}”（${m.status === 'ambiguous' ? '歧义' : '缺失'}）`,
        );
        const detail: string[] = [];
        if (resolvedLabels.length) detail.push(`已解析：${resolvedLabels.join('、')}`);
        if (missingLabels.length) detail.push(`未能定位：${missingLabels.join('、')}`);
        issues.push({
          ...base,
          type,
          message: `${type === 'broken' ? '断链' : '歧义引用'}：${occ.span.raw} —— ${
            occ.resolution.reason ?? '部分目标无法定位'
          }${detail.length ? `；${detail.join('；')}` : ''}`,
        });
      } else if (
        // 组合引用中包含源节点所在条：冗余自指
        (occ.resolution.targetIds ?? []).some(
          (id) => placement[id]?.article.id === placement[occ.nodeId]?.article.id,
        )
      ) {
        issues.push({
          ...base,
          type: 'self',
          targetNodeId: placement[occ.nodeId]?.article.id,
          message: `自引用：${occ.span.raw} 中包含本条，建议改为相对引用或从组合中剔除`,
        });
      }
      continue;
    }

    if (occ.resolution.status === 'broken') {
      issues.push({
        ...base,
        type: 'broken',
        targetNodeId: undefined,
        message: `断链：${occ.span.raw} —— ${occ.resolution.reason ?? '目标不存在'}`,
      });
    } else if (occ.resolution.status === 'ambiguous') {
      issues.push({
        ...base,
        type: 'ambiguous',
        message: `歧义引用：${occ.span.raw} —— ${occ.resolution.reason ?? '存在多个候选目标'}`,
      });
    } else if (occ.resolution.ambiguity) {
      // 歧义已由用户确认：保留为“已确认”记录，可查看目标或撤销确认
      issues.push({
        ...base,
        type: 'ambiguous',
        targetNodeId: occ.resolution.targetId,
        confirmedTargetId: occ.resolution.targetId,
        message: `歧义引用（已确认）：${occ.span.raw} → ${occ.resolution.canonical ?? ''}`,
      });
    } else if (occ.resolution.targetId === occ.nodeId) {
      issues.push({
        ...base,
        type: 'self',
        targetNodeId: occ.resolution.targetId,
        message: `自引用：${occ.span.raw} 指向其所在节点自身`,
      });
    } else if (
      // 条内以绝对形式回指本条（如本条正文写“第五条”而第五条正是本条）：冗余自指
      occ.span.kind === 'absolute' &&
      placement[occ.resolution.targetId!]?.article.id ===
        placement[occ.nodeId]?.article.id
    ) {
      issues.push({
        ...base,
        type: 'self',
        targetNodeId: occ.resolution.targetId,
        message: `自引用：${occ.span.raw} 以绝对形式指向本条，建议改为“本条”相对引用`,
      });
    }
  }

  // 循环引用：条级图上的有向环 + 节点级细环
  const cycles = detectCycles(edges);
  for (const cyc of cycles) {
    const firstOcc = occurrences.find((o) => o.key === cyc.edgeKeys[0]);
    if (firstOcc) {
      const text = nodes[firstOcc.nodeId]?.text ?? '';
      const sentence = locateSentence(text, firstOcc.span.start, firstOcc.span.end);
      issues.push({
        key: `cyc:${cyc.edgeKeys.join('>')}`,
        type: 'cycle',
        sourceNodeId: firstOcc.nodeId,
        sentenceStart: sentence.start,
        sentenceEnd: sentence.end,
        refStart: firstOcc.span.start,
        refEnd: firstOcc.span.end,
        refKey: firstOcc.key,
        targetNodeId: placement[firstOcc.resolution.targetId!]?.article.id,
        cycleNodeIds: cyc.articleIds,
        message: `循环引用：${cyc.articleIds
          .map((id) => '第' + articleLabel(placement[id].article))
          .join(' → ')} → 回到 ${'第' + articleLabel(placement[cyc.articleIds[0]].article)}`,
      });
    }
  }

  return { nodes, articles, placement, occurrences, byNode, issues, edges };
}

function articleLabel(a: ClauseNode): string {
  return formatOrdinal(a.ordinal) + '条' + (a.suffix ? `之${a.suffix}` : '');
}

/** 生成规范引用文本：绝对形式、中文数字 */
function canonicalText(_span: RefSpan, target: ClauseNode, p: NodePlacement): string {
  let s = `第${formatOrdinal(p.article.ordinal)}条`;
  if (p.article.suffix) s += `之${p.article.suffix}`;
  if (target.kind === 'paragraph' || target.kind === 'item') {
    s += `第${formatOrdinal(p.paragraphIndex)}款`;
  }
  if (target.kind === 'item') {
    s += `第${formatOrdinal(p.itemIndex)}项`;
  }
  return s;
}

/**
 * 条级组合引用的规范文本：目标在文档中连续时输出闭区间“第X条至第Y条”，
 * 不连续时展开为顿号列表“第X条、第Y条、第Z条”；各目标沿用其原文数字风格。
 */
export function renderArticleCombo(
  targets: { nodeId: string; articleStyle?: 'arabic' | 'chinese' }[],
  articles: ClauseNode[],
  preferRange: boolean,
): string {
  const located = targets
    .map((t) => ({ article: articles.find((a) => a.id === t.nodeId), style: t.articleStyle ?? 'chinese' }))
    .filter((x): x is { article: ClauseNode; style: 'arabic' | 'chinese' } => Boolean(x.article));
  const label = (article: ClauseNode, style: 'arabic' | 'chinese') =>
    `第${formatOrdinal(article.ordinal, style)}条${article.suffix ? `之${article.suffix}` : ''}`;
  const contiguous =
    located.length >= 2 &&
    located.every(
      (x, i) =>
        i === 0 ||
        (x.article.ordinal === located[i - 1].article.ordinal + 1 &&
          !x.article.suffix &&
          !located[i - 1].article.suffix),
    );
  if (contiguous && preferRange) {
    return `${label(located[0].article, located[0].style)}至${label(
      located[located.length - 1].article,
      located[located.length - 1].style,
    )}`;
  }
  return located.map((x) => label(x.article, x.style)).join('、');
}

function comboCanonical(
  targets: RefTargetEntry[],
  articles: ClauseNode[],
  preferRange: boolean,
): string {
  return renderArticleCombo(targets, articles, preferRange);
}

function locateSentence(text: string, start: number, end: number): { start: number; end: number } {
  const boundaries = new Set(['。', '！', '？', '；', ';', '…', '\n']);
  let s = start;
  while (s > 0 && !boundaries.has(text[s - 1])) s -= 1;
  let e = end;
  while (e < text.length && !boundaries.has(text[e - 1])) e += 1;
  if (e < text.length) e += 1; // 包含句末标点
  return { start: s, end: e };
}

interface Cycle {
  articleIds: string[];
  edgeKeys: string[];
}

/** 深度优先枚举有向环（条级图通常很小），每个节点集合只报一次 */
function detectCycles(edges: ArticleEdge[]): Cycle[] {
  const adj = new Map<string, { to: string; key: string }[]>();
  const vertices = new Set<string>();
  for (const e of edges) {
    vertices.add(e.sourceArticleId);
    vertices.add(e.targetArticleId);
    if (e.sourceArticleId === e.targetArticleId) continue; // 自引用单独报告
    const list = adj.get(e.sourceArticleId) ?? [];
    list.push({ to: e.targetArticleId, key: e.refKey });
    adj.set(e.sourceArticleId, list);
  }

  const cycles: Cycle[] = [];
  const seenSignatures = new Set<string>();
  const nodeStack: string[] = [];
  const edgeStack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();

  const visit = (v: string) => {
    visited.add(v);
    nodeStack.push(v);
    onStack.add(v);
    for (const { to, key } of adj.get(v) ?? []) {
      if (!visited.has(to)) {
        edgeStack.push(key);
        visit(to);
        edgeStack.pop();
      } else if (onStack.has(to)) {
        const idx = nodeStack.indexOf(to);
        if (idx >= 0) {
          const ringNodes = nodeStack.slice(idx);
          const ringEdges = [...edgeStack.slice(idx), key];
          const sig = [...ringNodes].sort().join('|');
          if (!seenSignatures.has(sig)) {
            seenSignatures.add(sig);
            cycles.push({ articleIds: ringNodes, edgeKeys: ringEdges });
          }
        }
      }
    }
    nodeStack.pop();
    onStack.delete(v);
  };

  for (const id of vertices) {
    if (!visited.has(id)) visit(id);
  }
  return cycles;
}

export { canonicalText };
