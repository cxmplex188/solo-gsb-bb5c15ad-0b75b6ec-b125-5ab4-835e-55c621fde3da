import { useApp } from '../lib/context';
import { useHighlighter } from '../lib/highlighter';
import type { Analysis, RefOccurrence } from '../../shared/model';
import { formatOrdinal } from '../lib/numeral';

const STATUS_TITLE: Record<string, string> = {
  ok: '引用有效 → 点击跳转到目标',
  broken: '断链',
  ambiguous: '歧义引用',
};

function articleIdLabel(analysis: Analysis, id: string): string {
  const p = analysis.placement[id];
  if (!p) return '';
  return `第${formatOrdinal(p.article.ordinal)}条${p.article.suffix ? `之${p.article.suffix}` : ''}`;
}

export function RefInline({
  occurrence,
  highlight,
  annotationCovered = false,
  annotationActive = false,
}: {
  occurrence: RefOccurrence;
  highlight?: boolean;
  annotationCovered?: boolean;
  annotationActive?: boolean;
}) {
  const { store, highlighter } = useApp();
  const hl = useHighlighter(highlighter);
  const { resolution, span } = occurrence;
  const { analysis } = store.getSnapshot();

  const isCombo = span.kind === 'articleList' || span.kind === 'articleRange';
  const allTargetIds = isCombo
    ? (resolution.targetIds ?? [])
    : resolution.targetId
      ? [resolution.targetId]
      : [];
  const targetId = allTargetIds[0] ?? null;
  const targetArticle = targetId ? analysis.placement[targetId]?.article.id : null;
  const sourceArticle = analysis.placement[occurrence.nodeId]?.article.id;
  const nodeSelf = !isCombo && resolution.status === 'ok' && targetId === occurrence.nodeId;
  const articleSelf =
    !isCombo &&
    resolution.status === 'ok' &&
    span.kind === 'absolute' &&
    targetArticle !== undefined &&
    targetArticle === sourceArticle;
  const comboSelf =
    isCombo &&
    resolution.status === 'ok' &&
    allTargetIds.some((id) => analysis.placement[id]?.article.id === sourceArticle);
  const selfRef = nodeSelf || articleSelf || comboSelf;

  const statusClass =
    resolution.status === 'broken'
      ? 'ref-broken'
      : resolution.status === 'ambiguous'
        ? 'ref-ambiguous'
        : selfRef
          ? 'ref-self'
          : resolution.ambiguity
            ? 'ref-confirmed'
            : 'ref-ok';

  const active = hl.hoverRefKey === occurrence.key || hl.activeRefKey === occurrence.key;

  const resolvedLabel = allTargetIds.map((id) => articleIdLabel(analysis, id)).filter(Boolean).join('、');
  const missingLabel = (resolution.missing ?? [])
    .map((m) => `“${m.raw}”（${m.status === 'ambiguous' ? '歧义' : '缺失'}）`)
    .join('、');

  const title =
    resolution.status === 'broken'
      ? `断链：${resolution.reason ?? '目标不存在'}${
          resolvedLabel ? `；已解析目标：${resolvedLabel}` : ''
        }${missingLabel ? `；未能定位：${missingLabel}` : ''}`
      : resolution.status === 'ambiguous'
        ? `歧义：${resolution.reason ?? '存在多个候选，需在右侧确认'}${missingLabel ? `；${missingLabel}` : ''}`
        : selfRef
          ? '自引用'
          : resolution.ambiguity
            ? `已确认的歧义引用 → ${resolution.canonical ?? ''}`
            : isCombo
              ? `组合引用 → ${resolution.canonical ?? resolvedLabel}（共 ${allTargetIds.length} 个目标，点击跳转首个）`
              : STATUS_TITLE.ok;

  return (
    <button
      type="button"
      className={`ref-chip ${statusClass} ${active ? 'ref-active' : ''} ${highlight ? 'ref-in-sentence' : ''} ${annotationCovered ? 'ref-has-ann' : ''} ${annotationActive ? 'ref-ann-active' : ''}`}
      title={title}
      onMouseEnter={() => highlighter.hoverRef(occurrence.key, targetId, allTargetIds)}
      onMouseLeave={() => highlighter.hoverRef(null, null)}
      onFocus={() => highlighter.hoverRef(occurrence.key, targetId, allTargetIds)}
      onBlur={() => highlighter.hoverRef(null, null)}
      onClick={(e) => {
        e.stopPropagation();
        if (targetId && resolution.status === 'ok') {
          highlighter.jumpTo(targetId);
        }
      }}
    >
      {span.raw}
    </button>
  );
}
