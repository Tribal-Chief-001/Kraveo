import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GitMerge, Loader2 } from 'lucide-react';
import { apiService } from '../services/api';
import { Category, MergePreview, mergeSummary } from '../lib/categoryParse';
import { errorText } from '../lib/errors';
import { Drawer } from './ui/Drawer';
import { Field } from './ui/Field';
import { useConfirm } from './ui/ConfirmDialog';

interface Props {
  source: Category;
  all: Category[];
  onClose: () => void;
  onMerged: (result: MergePreview) => void;
  onAuthError: (error: unknown) => void;
}

/** Why a category cannot receive the source's dishes / restaurants, or '' when it can. Mirrors the server's CATEGORY_INACTIVE / CATEGORY_INCOMPATIBLE. */
const cannotReceive = (source: Category, target: Category): string => {
  if (!target.isActive) return 'hidden';
  if (source.usage.dishes > 0 && !target.forDishes) return 'not a dish category';
  if (source.usage.restaurants > 0 && !target.forRestaurants) return 'not a restaurant category';
  return '';
};

/** Merge A into B: pick B, see what would move (a dry run, nothing changes), then confirm. */
export const CategoryMergeDrawer: React.FC<Props> = ({ source, all, onClose, onMerged, onAuthError }) => {
  const { confirm, dialog } = useConfirm();
  const [intoId, setIntoId] = useState('');
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState('');
  const [merging, setMerging] = useState(false);
  const seq = useRef(0);
  const busy = useRef(false);

  const targets = useMemo(() => all.filter((c) => c.id !== source.id), [all, source.id]);
  const target = targets.find((c) => c.id === intoId) ?? null;

  useEffect(() => {
    seq.current++;
    setPreview(null); setProblem('');
    if (!intoId) { setChecking(false); return undefined; }
    const mine = seq.current;
    setChecking(true);
    apiService.mergeCategory(source.id, intoId, true)
      .then((result) => { if (mine === seq.current) setPreview(result); })
      .catch((failure) => { if (mine === seq.current) { onAuthError(failure); setProblem(errorText(failure, 'Could not check what the merge would move.')); } })
      .finally(() => { if (mine === seq.current) setChecking(false); });
    return () => { seq.current++; };
  }, [intoId, source.id, onAuthError]);

  const doMerge = async () => {
    if (!target || !preview || busy.current) return;
    const moves = mergeSummary(preview);
    const ok = await confirm({
      title: `Merge “${source.name}” into “${target.name}”?`,
      message: `${moves} “${source.name}” is then deleted for good. This cannot be undone.`,
      confirmLabel: 'Merge and delete',
      danger: true,
    });
    if (!ok || busy.current) return;
    busy.current = true;
    setMerging(true); setProblem('');
    try {
      const result = await apiService.mergeCategory(source.id, target.id, false);
      onMerged(result);
    } catch (failure) {
      onAuthError(failure);
      setProblem(errorText(failure));
    } finally {
      busy.current = false;
      setMerging(false);
    }
  };

  return (
    <>
      <Drawer
        open
        onClose={() => { if (!merging) onClose(); }}
        title={`Merge “${source.name}”`}
        subtitle="Move everything to another category"
        icon={GitMerge}
        footer={(
          <div className="flex gap-3 pb-4">
            <button type="button" className="k-btn-ghost flex-1" onClick={onClose} disabled={merging}>Cancel</button>
            <button type="button" className="k-btn-danger flex-1" onClick={() => void doMerge()} disabled={!preview || checking || merging} aria-busy={merging}>
              {merging ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Merging…</> : 'Merge…'}
            </button>
          </div>
        )}
      >
        <div className="space-y-4">
          <p className="text-sm text-kraveo-ink2">Every restaurant and dish in <b>{source.name}</b> moves to the category you pick, and <b>{source.name}</b> is deleted. Check what would move first; nothing changes until you confirm.</p>
          <Field label="Merge into" htmlFor="merge-into" required>
            <select id="merge-into" className="k-select" value={intoId} onChange={(e) => setIntoId(e.target.value)} disabled={merging}>
              <option value="">Choose a category…</option>
              {targets.map((c) => {
                const why = cannotReceive(source, c);
                return <option key={c.id} value={c.id} disabled={why !== ''}>{c.name}{why ? ` (${why})` : ''}</option>;
              })}
            </select>
          </Field>
          <div className="k-inset p-4" aria-live="polite" data-testid="merge-preview">
            {!intoId && <p className="text-sm text-kraveo-ink3">Choose where it should go to see what would move.</p>}
            {intoId && checking && <p className="flex items-center gap-2 text-sm text-kraveo-ink3"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Checking what would move…</p>}
            {intoId && !checking && preview && <p className="text-sm font-semibold text-kraveo-ink">{mergeSummary(preview)} <span className="font-normal text-kraveo-ink3">Nothing has been changed yet.</span></p>}
            {problem && <p role="alert" className="break-words text-sm font-semibold text-kraveo-danger">{problem}</p>}
          </div>
        </div>
      </Drawer>
      {dialog}
    </>
  );
};
