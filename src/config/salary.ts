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

export type SalaryPolicy = {
  levels: SalaryLevel[];
  minActiveDays: number; // the host must have been live on at least this many days of the week (0 = no rule)
  minLiveMinutes: number; // and at least this many live minutes in the week (0 = no rule)
};

// PLACEHOLDER numbers, to be replaced by the client's real policy in the admin panel.
export const DEFAULT_SALARY_POLICY: SalaryPolicy = {
  minActiveDays: 0,
  minLiveMinutes: 0,
  levels: [
    { level: 1, targetDiamonds: 50_000, hostSalaryCents: 1_000, agentSalaryCents: 100 },
    { level: 2, targetDiamonds: 125_000, hostSalaryCents: 2_500, agentSalaryCents: 250 },
    { level: 3, targetDiamonds: 250_000, hostSalaryCents: 5_000, agentSalaryCents: 500 },
    { level: 4, targetDiamonds: 500_000, hostSalaryCents: 10_000, agentSalaryCents: 1_000 },
    { level: 5, targetDiamonds: 1_000_000, hostSalaryCents: 20_000, agentSalaryCents: 2_000 },
    { level: 6, targetDiamonds: 1_500_000, hostSalaryCents: 30_000, agentSalaryCents: 3_000 },
    { level: 7, targetDiamonds: 2_500_000, hostSalaryCents: 50_000, agentSalaryCents: 5_000 },
    { level: 8, targetDiamonds: 4_000_000, hostSalaryCents: 80_000, agentSalaryCents: 8_000 },
    { level: 9, targetDiamonds: 6_000_000, hostSalaryCents: 120_000, agentSalaryCents: 12_000 },
    { level: 10, targetDiamonds: 10_000_000, hostSalaryCents: 200_000, agentSalaryCents: 20_000 },
  ],
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
    minActiveDays: int(raw?.minActiveDays, 0, 0, 7),
    minLiveMinutes: int(raw?.minLiveMinutes, 0, 0, 10_080),
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
