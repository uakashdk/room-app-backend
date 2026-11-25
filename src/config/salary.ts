/**
 * Host salary and withdrawal settings.
 * Everything here is only the DEFAULT. The admin changes the real values in the admin panel (Host policy page), which saves them in
 *   app_settings/host_policy      (the salary levels)
 *   app_settings/withdrawal       (withdrawal rules)
 * so nothing about salary or commission is hard-coded. All money is kept in CENTS (whole numbers), never as decimals.
 */
export const SALARY_POLICY_DOC = 'app_settings/host_policy';
export const WITHDRAWAL_DOC = 'app_settings/withdrawal';
export const SALARY_STATE_DOC = 'app_settings/salary_state';

/** One row of the host policy: reach `targetDiamonds` in a week -> the host earns hostSalaryCents and the agency owner agentSalaryCents. */
export type SalaryLevel = { level: number; targetDiamonds: number; hostSalaryCents: number; agentSalaryCents: number };

/** weekly = the targets restart every Monday (India time); monthly = they restart on the 1st of every month. */
export type SalaryPeriod = 'weekly' | 'monthly';

export type SalaryPolicy = {
  levels: SalaryLevel[];
  period: SalaryPeriod; // how long one target period is
  autoCredit: boolean; // true = the salary goes to the host's balance by itself when the period ends (no admin click)
  minActiveDays: number; // the host must have been live on at least this many days of the period (0 = no rule)
  minLiveMinutes: number; // and at least this many live minutes in the period (0 = no rule)
};

// The client's "HOST & AGENCY Salary CHART": 10,000 coins = 1 USD. Total = target / 10,000 USD, the host gets 50% of it.
// (The agency owner does NOT get a second salary: the agency commission is taken from the host's withdrawal, see withdrawalService.)
// The admin can change every number (Host policy page, or per agency: Agencies -> Targets).
const CHART_TARGETS = [30_000, 60_000, 100_000, 150_000, 200_000, 300_000, 450_000, 600_000, 800_000, 1_000_000, 1_300_000, 1_500_000, 1_750_000, 2_000_000, 2_400_000, 2_700_000, 3_100_000, 3_500_000, 4_000_000];
export const DEFAULT_SALARY_POLICY: SalaryPolicy = {
  period: 'weekly',
  autoCredit: false,
  minActiveDays: 0,
  minLiveMinutes: 0,
  levels: CHART_TARGETS.map((targetDiamonds, i) => ({
    level: i + 1,
    targetDiamonds,
    hostSalaryCents: Math.round((targetDiamonds / 10_000) * 100 * 0.5), // 50% of the total, in cents
    agentSalaryCents: 0,
  })),
};

export type WithdrawalSettings = {
  enabled: boolean;
  minCents: number; // smallest request
  maxCents: number; // largest single request
  dailyLimitCents: number; // most one person can request in 24 hours
  methods: ('upi' | 'bank' | 'paypal')[];
};

export const DEFAULT_WITHDRAWAL: WithdrawalSettings = {
  enabled: true,
  minCents: 1_000, // $10
  maxCents: 500_000, // $5,000
  dailyLimitCents: 500_000,
  methods: ['upi', 'bank', 'paypal'],
};

const int = (v: unknown, fallback: number, min = 0, max = 10_000_000_000) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/** Takes the policy from the database; anything broken falls back to the default so a bad edit can never stop salaries. */
export function normalizePolicy(raw: any): SalaryPolicy {
  const rows = Array.isArray(raw?.levels) ? raw.levels : [];
  const levels = rows
    .map((r: any, i: number) => ({
      level: int(r?.level, i + 1, 1, 1000),
      targetDiamonds: int(r?.targetDiamonds, -1, 1),
      hostSalaryCents: int(r?.hostSalaryCents, -1, 0),
      agentSalaryCents: int(r?.agentSalaryCents, 0, 0),
    }))
    .filter((l: SalaryLevel) => l.targetDiamonds > 0 && l.hostSalaryCents >= 0)
    .sort((a: SalaryLevel, b: SalaryLevel) => a.targetDiamonds - b.targetDiamonds)
    .map((l: SalaryLevel, i: number) => ({ ...l, level: i + 1 })); // levels are always 1, 2, 3 ... in order of the target
  return {
    levels: levels.length ? levels : DEFAULT_SALARY_POLICY.levels,
    period: raw?.period === 'monthly' ? 'monthly' : 'weekly',
    autoCredit: raw?.autoCredit === true,
    minActiveDays: int(raw?.minActiveDays, 0, 0, 31),
    minLiveMinutes: int(raw?.minLiveMinutes, 0, 0, 44_640),
  };
}

export function normalizeWithdrawal(raw: any): WithdrawalSettings {
  const methods = (Array.isArray(raw?.methods) ? raw.methods : DEFAULT_WITHDRAWAL.methods).filter((m: any) => ['upi', 'bank', 'paypal'].includes(m));
  return {
    enabled: raw?.enabled !== false,
    minCents: int(raw?.minCents, DEFAULT_WITHDRAWAL.minCents, 1),
    maxCents: int(raw?.maxCents, DEFAULT_WITHDRAWAL.maxCents, 1),
    dailyLimitCents: int(raw?.dailyLimitCents, DEFAULT_WITHDRAWAL.dailyLimitCents, 1),
    methods: methods.length ? methods : DEFAULT_WITHDRAWAL.methods,
  };
}

/** The highest level whose target is reached (null = below level 1). */
export const levelFor = (diamonds: number, levels: SalaryLevel[]): SalaryLevel | null =>
  [...levels].reverse().find((l) => diamonds >= l.targetDiamonds) ?? null;

/**
 * The plan that counts for an agency: its own plan (agencies/<id>.plan, set by the Super admin in Agencies -> Targets),
 * or the default host policy when the agency has none.
 */
export function planOf(agency: FirebaseFirestore.DocumentData | undefined, fallback: SalaryPolicy): { plan: SalaryPolicy; custom: boolean } {
  if (agency?.plan && Array.isArray(agency.plan.levels) && agency.plan.levels.length) return { plan: normalizePolicy(agency.plan), custom: true };
  return { plan: fallback, custom: false };
}
