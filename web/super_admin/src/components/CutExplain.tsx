import React from 'react';
import { CUT_EXPLANATION, MAX_CUT_PERCENT, cutExampleText, parseCommissionValue } from '../lib/pricing';

/** Docs/26: the plain explanation of "Cut from sale" and a worked example that follows the percent being typed (30% until it is a valid number). */
export const CutExplain: React.FC<{ percentText: string; id?: string }> = ({ percentText, id }) => {
  const parsed = parseCommissionValue('CUT', percentText);
  const percent = parsed.ok ? parsed.value : 30;
  return (
    <div id={id} className="space-y-1 rounded-k-sm border border-kraveo-line bg-kraveo-surface2/60 px-3 py-2 text-xs text-kraveo-ink2" data-testid="cut-explain">
      <p>{CUT_EXPLANATION} The percent can be 0 to {MAX_CUT_PERCENT}, with up to 2 decimals.</p>
      <p className="font-semibold text-kraveo-ink" data-testid="cut-example">Example: {cutExampleText(percent)}</p>
    </div>
  );
};
