import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowUpRight,
  CalendarCheck2,
  CalendarClock,
  CalendarX2,
  CircleCheckBig,
  Scissors,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

import type { Service } from '@queueless/shared-types'

import { apiFetch, ApiRequestError } from '@/lib/api'
import { useAuth } from '@/lib/use-auth'
import { PageHeader } from '@/components/layout/page-header'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'

interface BookingListItem {
  id: string
  status: 'confirmed' | 'cancelled' | 'completed' | 'no-show'
  slotId: string
}

interface SlotListItem {
  id: string
  datetime: string
  status: 'available' | 'held' | 'confirmed' | 'cancelled' | 'blocked'
}

interface ProviderListItem {
  status: 'active' | 'removed'
}

/** Today's slot-utilisation breakdown, derived from GET /slots. */
interface TodayUtilization {
  booked: number
  held: number
  open: number
  unavailable: number
  total: number
}

interface Stats {
  todayCount: number
  upcomingCount: number
  completedCount: number
  /** completed + no-show — the denominator for the no-show rate. */
  attendedCount: number
  noShowCount: number
  activeServices: number
  teamSize: number
  today: TodayUtilization
}

/**
 * Today's schedule utilisation, straight off the slot statuses.
 * completed / no-show aren't slot states (a fulfilled appointment's slot
 * stays 'confirmed', per the schema), so 'confirmed' is the right
 * "carrying an appointment" bucket here.
 */
function computeTodayUtilization(
  slots: SlotListItem[],
  startOfDay: number,
  endOfDay: number,
): TodayUtilization {
  const today: TodayUtilization = {
    booked: 0,
    held: 0,
    open: 0,
    unavailable: 0,
    total: 0,
  }
  for (const s of slots) {
    const t = new Date(s.datetime).getTime()
    if (t < startOfDay || t >= endOfDay) continue
    today.total += 1
    if (s.status === 'confirmed') today.booked += 1
    else if (s.status === 'held') today.held += 1
    else if (s.status === 'available') today.open += 1
    else today.unavailable += 1 // blocked | cancelled
  }
  return today
}

/**
 * Business settings — GET/PATCH /api/tenants. Viewable by owner or
 * staff, editable by owner only (enforced server-side; staff just don't
 * see the edit form here). Also the dashboard landing page, so it opens
 * with an at-a-glance summary — plus a small analytics layer (Phase 6) —
 * all built from the same read endpoints the other tabs already use. No
 * new API surface, so RBAC / businessId scoping / projections all carry
 * over unchanged.
 */
export function DashboardOverviewPage() {
  const { business, user, refreshBusiness } = useAuth()
  const isOwner = user?.role === 'owner'

  const [stats, setStats] = useState<Stats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)

  useEffect(() => {
    async function loadStats() {
      try {
        const [bookings, slots, services, providers] = await Promise.all([
          apiFetch<BookingListItem[]>('/bookings'),
          apiFetch<SlotListItem[]>('/slots'),
          apiFetch<Service[]>('/services'),
          apiFetch<ProviderListItem[]>('/providers'),
        ])
        const slotTimeById = new Map(slots.map((s) => [s.id, s.datetime]))
        const now = Date.now()
        const startOfDay = new Date()
        startOfDay.setHours(0, 0, 0, 0)
        const endOfDay = new Date(startOfDay)
        endOfDay.setDate(endOfDay.getDate() + 1)

        let todayCount = 0
        let upcomingCount = 0
        let completedCount = 0
        let noShowCount = 0
        for (const b of bookings) {
          if (b.status === 'completed') completedCount += 1
          if (b.status === 'no-show') noShowCount += 1
          if (b.status !== 'confirmed') continue
          const iso = slotTimeById.get(b.slotId)
          if (!iso) continue
          const t = new Date(iso).getTime()
          if (t < now) continue
          upcomingCount += 1
          if (t < endOfDay.getTime()) todayCount += 1
        }

        const today = computeTodayUtilization(
          slots,
          startOfDay.getTime(),
          endOfDay.getTime(),
        )

        setStats({
          todayCount,
          upcomingCount,
          completedCount,
          attendedCount: completedCount + noShowCount,
          noShowCount,
          activeServices: services.filter((s) => s.isActive).length,
          teamSize: providers.filter((p) => p.status === 'active').length,
          today,
        })
        setStatsError(null)
      } catch (err) {
        setStatsError(
          err instanceof ApiRequestError
            ? err.message
            : 'Could not load your business summary.',
        )
      }
    }
    void loadStats()
  }, [])

  const noShowRate =
    stats && stats.attendedCount > 0
      ? `${Math.round((stats.noShowCount / stats.attendedCount) * 100)}%`
      : stats
        ? '—'
        : undefined

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Welcome back${user ? `, ${user.name.split(' ')[0]}` : ''}`}
        description={
          business
            ? `Here's what's happening at ${business.name}.`
            : 'Loading your business…'
        }
        actions={
          business ? (
            <Button asChild variant="outline" size="sm">
              <Link to={`/b/${business.slug}`} target="_blank" rel="noreferrer">
                View public page
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          ) : undefined
        }
      />

      {statsError && <Alert variant="destructive">{statsError}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          icon={CalendarCheck2}
          label="Booked today"
          value={stats?.todayCount}
        />
        <StatCard
          icon={CalendarClock}
          label="Upcoming"
          value={stats?.upcomingCount}
        />
        <StatCard
          icon={CircleCheckBig}
          label="Completed"
          value={stats?.completedCount}
        />
        <StatCard
          icon={CalendarX2}
          label="No-show rate"
          value={noShowRate}
          hint={
            stats
              ? stats.attendedCount > 0
                ? `${stats.noShowCount} of ${stats.attendedCount} past appointments`
                : 'No completed appointments yet'
              : undefined
          }
        />
        <StatCard
          icon={Scissors}
          label="Active services"
          value={stats?.activeServices}
        />
        <StatCard icon={Users} label="Team" value={stats?.teamSize} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <BookingOverviewCard stats={stats} />
        <TodayUtilizationCard today={stats?.today} />
      </div>

      <BusinessSettingsCard
        business={business}
        isOwner={isOwner}
        onSaved={refreshBusiness}
      />
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon
  label: string
  value: number | string | undefined
  hint?: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          {value === undefined ? (
            <Skeleton className="h-7 w-10" />
          ) : (
            <p className="text-2xl font-semibold leading-tight tabular-nums">
              {value}
            </p>
          )}
          <p className="text-sm text-muted-foreground">{label}</p>
          {hint && (
            <p className="mt-0.5 text-xs text-muted-foreground/80">{hint}</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function BookingOverviewCard({ stats }: { stats: Stats | null }) {
  const data = stats
    ? [
        { name: 'Completed', count: stats.completedCount },
        { name: 'Today', count: stats.todayCount },
        { name: 'Upcoming', count: stats.upcomingCount },
      ]
    : []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pipeline Overview</CardTitle>
      </CardHeader>
      <CardContent>
        {stats === null ? (
          <Skeleton className="h-[200px] w-full" />
        ) : (
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="hsl(var(--border))"
                />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                  dy={10}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted)/0.3)' }}
                  contentStyle={{
                    borderRadius: '8px',
                    border: '1px solid hsl(var(--border))',
                    backgroundColor: 'hsl(var(--card))',
                    color: 'hsl(var(--card-foreground))',
                    fontSize: '12px',
                    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)'
                  }}
                  itemStyle={{ color: 'hsl(var(--foreground))' }}
                />
                <Bar
                  dataKey="count"
                  fill="hsl(var(--primary))"
                  radius={[4, 4, 0, 0]}
                  barSize={40}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const UTILIZATION_SEGMENTS = [
  { key: 'booked', label: 'Booked', bar: 'bg-primary', dot: 'bg-primary' },
  {
    key: 'held',
    label: 'In checkout',
    bar: 'bg-primary/45',
    dot: 'bg-primary/45',
  },
  {
    key: 'open',
    label: 'Open',
    bar: 'bg-muted-foreground/25',
    dot: 'bg-muted-foreground/25',
  },
  {
    key: 'unavailable',
    label: 'Blocked',
    bar: 'bg-muted-foreground/10',
    dot: 'bg-muted-foreground/10',
  },
] as const

/**
 * One simple, native-feeling visualisation: how much of today's
 * generated schedule is actually carrying appointments. A stacked
 * proportion bar plus a labelled legend — color is never the only
 * signal (every segment is named with its count), and the bar itself is
 * `aria-hidden` since the headline sentence + legend already say
 * everything in text.
 */
function TodayUtilizationCard({ today }: { today: TodayUtilization | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Today's utilization</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {today === undefined ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-3 w-full rounded-full" />
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {UTILIZATION_SEGMENTS.map((s) => (
                <Skeleton key={s.key} className="h-4 w-24" />
              ))}
            </div>
          </div>
        ) : today.total === 0 ? (
          <p className="text-sm text-muted-foreground">
            No slots scheduled for today. Generate availability from the{' '}
            <Link to="/dashboard/schedule" className="font-medium underline">
              Schedule
            </Link>{' '}
            tab to see utilization here.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3">
              <p className="text-2xl font-semibold leading-none tabular-nums">
                {Math.round((today.booked / today.total) * 100)}%
              </p>
              <p className="text-sm text-muted-foreground">
                {today.booked} of {today.total}{' '}
                {today.total === 1 ? 'slot' : 'slots'} booked
              </p>
            </div>

            <div
              className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
              aria-hidden="true"
            >
              {UTILIZATION_SEGMENTS.map((seg) => {
                const count = today[seg.key]
                if (count === 0) return null
                return (
                  <div
                    key={seg.key}
                    className={seg.bar}
                    style={{ width: `${(count / today.total) * 100}%` }}
                  />
                )
              })}
            </div>

            <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
              {UTILIZATION_SEGMENTS.map((seg) => (
                <li key={seg.key} className="flex items-center gap-2">
                  <span
                    className={`size-2.5 shrink-0 rounded-full ${seg.dot}`}
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground">{seg.label}</span>
                  <span className="font-medium tabular-nums">
                    {today[seg.key]}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function BusinessSettingsCard({
  business,
  isOwner,
  onSaved,
}: {
  business: ReturnType<typeof useAuth>['business']
  isOwner: boolean
  onSaved: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(business?.name ?? '')
  const [timezone, setTimezone] = useState(business?.timezone ?? '')
  const [cutoff, setCutoff] = useState(
    business?.cancellationCutoffMinutes ?? 60,
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function startEditing() {
    setName(business?.name ?? '')
    setTimezone(business?.timezone ?? '')
    setCutoff(business?.cancellationCutoffMinutes ?? 60)
    setError(null)
    setEditing(true)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      await apiFetch('/tenants', {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          timezone,
          cancellationCutoffMinutes: Number(cutoff),
        }),
      })
      await onSaved()
      setEditing(false)
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Business settings</CardTitle>
        {isOwner && business && !editing && (
          <Button variant="outline" size="sm" onClick={startEditing}>
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {!business ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : !editing ? (
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <Item label="Name" value={business.name} />
            <Item label="Public link" value={`/b/${business.slug}`} mono />
            <Item label="Timezone" value={business.timezone} />
            <Item
              label="Cancellation cutoff"
              value={`${business.cancellationCutoffMinutes} minutes before start`}
            />
          </dl>
        ) : (
          <form className="max-w-md space-y-4" onSubmit={handleSubmit}>
            {error && <Alert variant="destructive">{error}</Alert>}

            <div className="space-y-2">
              <Label htmlFor="biz-name">Name</Label>
              <Input
                id="biz-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="biz-timezone">Timezone (IANA)</Label>
              <Input
                id="biz-timezone"
                required
                placeholder="Asia/Kolkata"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="biz-cutoff">Cancellation cutoff (minutes)</Label>
              <Input
                id="biz-cutoff"
                type="number"
                min={0}
                required
                value={cutoff}
                onChange={(e) => setCutoff(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                How close to the start time a customer can still reschedule or
                cancel their own booking.
              </p>
            </div>

            <div className="flex gap-2">
              <Button type="submit" disabled={submitting}>
                {submitting && <Spinner />}
                Save changes
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

function Item({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-[0.8125rem]' : 'font-medium'}>
        {value}
      </dd>
    </div>
  )
}
