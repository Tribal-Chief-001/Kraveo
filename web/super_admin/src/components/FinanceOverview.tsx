import React, { useMemo, useState } from 'react';
import { Vendor } from '../types';
import { apiService } from '../services/api';
import { DISH_SORTS, DateRange, DishSort, FinanceSummary, dateLabel, presetRange, rupeesSigned } from '../lib/financeParse';
import { rupees } from '../lib/pricing';
import { EmptyState } from './ui/EmptyState';
import { Skeleton } from './ui/Skeleton';
import { BarChart3 } from 'lucide-react';
import { DateRangePicker, ErrorNote, ReloadButton, ScrollTable, SectionCard, Td, Th, useLoad } from './FinanceCommon';

interface Props {
  vendors: Vendor[];
  onAuthError: (error: unknown) => void;
}

const MAX_RANGE_DAYS = 366;

const Stat: React.FC<{ label: string; value: string; note?: string; tone?: 'good' | 'bad' }> = ({ label, value, note, tone }) => (
  <div className="k-inset px-3.5 py-3">
    <p className="k-label">{label}</p>
    <p className={`k-num mt-1 break-words text-2xl ${tone === 'bad' ? 'text-kraveo-danger' : 'text-kraveo-ink'}`}>{value}</p>
    {note && <p className="mt-0.5 text-[11px] text-kraveo-ink3">{note}</p>}
  </div>
);

const SummaryCards: React.FC<{ s: FinanceSummary }> = ({ s }) => (
  <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="finance-cards">
    <Stat label="Orders" value={String(s.orders)} note="Delivered and paid" />
    <Stat label="Food gross" value={rupees(s.foodGross)} note="What customers paid for food" />
    <Stat label="Restaurant amount" value={rupees(s.vendorAmount)} note="What the restaurants earn" />
    <Stat label="Commission" value={rupees(s.commission)} />
    <Stat label="Fees collected" value={rupees(s.feesCollected)} note="Delivery and service fee" />
    <Stat label="Discounts" value={rupees(s.discounts)} note="Coupons paid by Kraveo" />
    <Stat label="Platform revenue" value={rupeesSigned(s.platformRevenue)} note="Commission + fees - discounts" tone={s.platformRevenue < 0 ? 'bad' : 'good'} />
    <Stat label="Refunds" value={rupees(s.refunds.amount)} note={`${s.refunds.count} ${s.refunds.count === 1 ? 'order' : 'orders'}`} />
    <Stat label="Settled" value={rupees(s.settledAmount)} note="In a settlement" />
    <Stat label="Unsettled" value={rupees(s.unsettledAmount)} note="Not in a settlement yet" />
    <Stat label="Paid out" value={rupees(s.paidOutAmount)} note="Settlement marked paid" />
  </div>
);

const Loading: React.FC = () => <div role="status" aria-label="Loading" className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></div>;

const SORT_LABEL: Record<DishSort, string> = { units: 'Units sold', vendorRevenue: 'Restaurant revenue', commission: 'Commission' };
const TOP_CHOICES = [10, 20, 50, 100];

export const FinanceOverview: React.FC<Props> = ({ vendors, onAuthError }) => {
  const [range, setRange] = useState<DateRange>(() => presetRange('7d'));
  const [sort, setSort] = useState<DishSort>('units');
  const [top, setTop] = useState(20);
  const [vendorId, setVendorId] = useState('');
  const sortedVendors = useMemo(() => [...vendors].sort((a, b) => a.name.localeCompare(b.name)), [vendors]);

  const summary = useLoad(() => apiService.fetchFinanceSummary(range), [range], onAuthError);
  const byDay = useLoad(() => apiService.fetchFinanceByDay(range), [range], onAuthError);
  const byRestaurant = useLoad(() => apiService.fetchFinanceByRestaurant(range), [range], onAuthError);
  const byDish = useLoad(() => apiService.fetchFinanceByDish(range, { sort, top, vendorId: vendorId || undefined }), [range, sort, top, vendorId], onAuthError);

  const reloadAll = () => { summary.reload(); byDay.reload(); byRestaurant.reload(); byDish.reload(); };
  const anyLoading = summary.loading || byDay.loading || byRestaurant.loading || byDish.loading;
  const maxDay = Math.max(1, ...(byDay.data?.rows ?? []).map((r) => Math.abs(r.platformRevenue)));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <DateRangePicker value={range} onChange={(next) => next && setRange(next)} maxDays={MAX_RANGE_DAYS} label="Date range" />
        <ReloadButton onClick={reloadAll} loading={anyLoading} label="Reload finance numbers" />
      </div>

      <SectionCard title="Summary" description="Delivered and paid orders in the range, on India days. Refunds are counted separately.">
        {summary.loading && !summary.data && <Loading />}
        {summary.error && <ErrorNote message={summary.error} onRetry={summary.reload} />}
        {summary.data && <div className={summary.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={summary.loading}><SummaryCards s={summary.data} /></div>}
        {summary.data && summary.data.orders === 0 && !summary.loading && <p className="text-sm text-kraveo-ink2">No delivered, paid orders in this range yet.</p>}
      </SectionCard>

      <SectionCard title="By day" description="One row for every day in the range. The bar shows platform revenue.">
        {byDay.loading && !byDay.data && <Loading />}
        {byDay.error && <ErrorNote message={byDay.error} onRetry={byDay.reload} />}
        {byDay.data && byDay.data.rows.length === 0 && !byDay.error && <EmptyState icon={BarChart3} title="No days to show" description="The server returned no days for this range." />}
        {byDay.data && byDay.data.rows.length > 0 && (
          <ScrollTable caption="Finance by day" minWidth="min-w-[820px]">
            <thead><tr><Th>Date</Th><Th right>Orders</Th><Th right>Food gross</Th><Th right>Commission</Th><Th right>Fees</Th><Th right>Discounts</Th><Th right>Platform revenue</Th><Th right>Refunds</Th></tr></thead>
            <tbody>
              {byDay.data.rows.map((row) => (
                <tr key={row.date}>
                  <Td className="whitespace-nowrap font-bold text-kraveo-ink">{dateLabel(row.date)}</Td>
                  <Td right>{row.orders}</Td>
                  <Td right>{rupees(row.foodGross)}</Td>
                  <Td right>{rupees(row.commission)}</Td>
                  <Td right>{rupees(row.feesCollected)}</Td>
                  <Td right>{rupees(row.discounts)}</Td>
                  <Td right>
                    <span className="flex items-center justify-end gap-2">
                      <span className="hidden h-2 w-20 overflow-hidden rounded-full bg-kraveo-surface2 sm:block" aria-hidden="true">
                        <span className={`block h-full rounded-full ${row.platformRevenue < 0 ? 'bg-kraveo-danger' : 'bg-kraveo-g400'}`} style={{ width: `${Math.round((Math.abs(row.platformRevenue) / maxDay) * 100)}%` }} />
                      </span>
                      <span className="font-bold text-kraveo-ink">{rupeesSigned(row.platformRevenue)}</span>
                    </span>
                  </Td>
                  <Td right>{row.refunds.count > 0 ? `${rupees(row.refunds.amount)} (${row.refunds.count})` : rupees(0)}</Td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </SectionCard>

      <SectionCard title="By restaurant" description="Highest restaurant earnings first.">
        {byRestaurant.loading && !byRestaurant.data && <Loading />}
        {byRestaurant.error && <ErrorNote message={byRestaurant.error} onRetry={byRestaurant.reload} />}
        {byRestaurant.data && byRestaurant.data.rows.length === 0 && !byRestaurant.error && <p className="text-sm text-kraveo-ink2">No restaurant had a delivered, paid order in this range.</p>}
        {byRestaurant.data && byRestaurant.data.rows.length > 0 && (
          <ScrollTable caption="Finance by restaurant" minWidth="min-w-[860px]">
            <thead><tr><Th>Restaurant</Th><Th right>Orders</Th><Th right>Food gross</Th><Th right>Restaurant amount</Th><Th right>Commission</Th><Th right>Platform revenue</Th><Th right>Unsettled</Th><Th right>Refunds</Th></tr></thead>
            <tbody>
              {byRestaurant.data.rows.map((row) => (
                <tr key={row.vendorId}>
                  <Td className="max-w-[14rem] break-words font-bold text-kraveo-ink">{row.vendorName}</Td>
                  <Td right>{row.orders}</Td>
                  <Td right>{rupees(row.foodGross)}</Td>
                  <Td right>{rupees(row.vendorAmount)}</Td>
                  <Td right>{rupees(row.commission)}</Td>
                  <Td right>{rupeesSigned(row.platformRevenue)}</Td>
                  <Td right>{rupees(row.unsettledAmount)}</Td>
                  <Td right>{row.refunds.count > 0 ? `${rupees(row.refunds.amount)} (${row.refunds.count})` : rupees(0)}</Td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </SectionCard>

      <SectionCard
        title="By dish"
        description="The best sellers in the range."
        actions={(
          <>
            <label className="sr-only" htmlFor="finance-dish-vendor">Restaurant</label>
            <select id="finance-dish-vendor" className="k-select !min-h-[40px] w-full sm:w-48" value={vendorId} onChange={(event) => setVendorId(event.target.value)}>
              <option value="">All restaurants</option>
              {sortedVendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <label className="sr-only" htmlFor="finance-dish-top">Show top</label>
            <select id="finance-dish-top" className="k-select !min-h-[40px] w-28" value={top} onChange={(event) => setTop(Number(event.target.value))}>
              {TOP_CHOICES.map((n) => <option key={n} value={n}>Top {n}</option>)}
            </select>
          </>
        )}
      >
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 scrollbar-none" role="group" aria-label="Sort dishes by">
          {DISH_SORTS.map((id) => <button key={id} type="button" className="k-chip" aria-pressed={sort === id} onClick={() => setSort(id)}>{SORT_LABEL[id]}</button>)}
        </div>
        {byDish.loading && !byDish.data && <Loading />}
        {byDish.error && <ErrorNote message={byDish.error} onRetry={byDish.reload} />}
        {byDish.data && byDish.data.rows.length === 0 && !byDish.error && <p className="text-sm text-kraveo-ink2">No dishes were sold in this range.</p>}
        {byDish.data && byDish.data.rows.length > 0 && (
          <div className={byDish.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={byDish.loading}>
            <ScrollTable caption="Finance by dish" minWidth="min-w-[760px]">
              <thead><tr><Th>Dish</Th><Th>Restaurant</Th><Th right>Units</Th><Th right>Customers paid</Th><Th right>Restaurant revenue</Th><Th right>Commission</Th></tr></thead>
              <tbody>
                {byDish.data.rows.map((row, index) => (
                  <tr key={`${row.vendorId}-${row.menuItemId ?? row.name}-${index}`}>
                    <Td className="max-w-[14rem] break-words font-bold text-kraveo-ink">{row.name}</Td>
                    <Td className="max-w-[12rem] break-words">{row.vendorName}</Td>
                    <Td right>{row.units}</Td>
                    <Td right>{rupees(row.customerRevenue)}</Td>
                    <Td right>{rupees(row.vendorRevenue)}</Td>
                    <Td right>{rupees(row.commission)}</Td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          </div>
        )}
      </SectionCard>
    </div>
  );
};
