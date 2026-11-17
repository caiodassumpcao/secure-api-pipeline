import { metrics, type Meter } from '@opentelemetry/api';

/** Every value is a fixed label: never ids, emails or raw paths (cardinality, privacy). */
export type LoginFailureReason = 'wrong_password' | 'unknown_account' | 'locked' | 'rate_limited';

/** Business counters of DESIGN §6. Without a meter provider they record nothing. */
export interface AppMetrics {
  loginFailed(reason: LoginFailureReason): void;
  refreshTokenReuseDetected(): void;
  taskCreated(): void;
}

/**
 * OTel names, exported to Prometheus as `auth_login_failures_total`,
 * `auth_token_reuse_detected_total` and `tasks_created_total`.
 */
export function createAppMetrics(meter: Meter = metrics.getMeter('secure-api')): AppMetrics {
  const loginFailures = meter.createCounter('auth.login.failures', {
    description: 'Failed login attempts, by reason',
  });
  const tokenReuse = meter.createCounter('auth.token.reuse_detected', {
    description: 'Refresh tokens presented again after rotation (session revoked)',
  });
  const tasksCreated = meter.createCounter('tasks.created', { description: 'Tasks created' });

  return {
    loginFailed(reason) {
      loginFailures.add(1, { reason });
    },
    refreshTokenReuseDetected() {
      tokenReuse.add(1);
    },
    taskCreated() {
      tasksCreated.add(1);
    },
  };
}
