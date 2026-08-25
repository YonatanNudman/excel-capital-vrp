/** Row types mirroring the D1 schema (migrations/0001_init.sql). */

export type Role = "admin" | "operator" | "viewer";

export type BorrowerStatus =
  | "onboarding"
  | "active"
  | "paused"
  | "revoked"
  | "expired";

export type ConsentStatus =
  | "pending"
  | "authorized"
  | "revoked"
  | "expired"
  | "rejected";

/**
 * Frequencies the DATABASE can hold. "daily" is deliberately absent: the
 * frequency CHECK constraint cannot be widened safely (see migrations/0004), so
 * a daily schedule is stored as 'custom' with interval_days = 1 plus an explicit
 * days_of_week list. Use ScheduleFrequency from lib/schedule for the domain
 * value, which does include "daily".
 */
export type Frequency = "weekly" | "fortnightly" | "monthly" | "custom";
export type EndMode = "date" | "count" | "total";

export type PaymentStatus =
  | "pending"
  | "unknown"
  | "submitted"
  | "initiated"
  | "executed"
  | "settled"
  | "failed"
  | "rejected"
  | "cancelled";

export interface StaffUser {
  id: string;
  email: string;
  role: Role;
  created_at: string;
  last_login_at: string | null;
}

export interface Borrower {
  id: string;
  legal_name: string;
  company_number: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  /** Registered office from Companies House, formatted for display. */
  registered_address: string | null;
  registered_postcode: string | null;
  status: BorrowerStatus;
  deleted_at: string | null;
  created_at: string;
  created_by: string | null;
}

export interface Recipient {
  id: string;
  borrower_id: string;
  plaid_recipient_id: string | null;
  name: string;
  account_number: string | null;
  sort_code: string | null;
  /** Staff-facing name for this destination; falls back to `name` when unset. */
  label: string | null;
  /** Exactly one per borrower, enforced by a partial unique index. */
  is_default: number;
  /** Retired from the picker but kept readable, since payment history points here. */
  archived_at: string | null;
  created_at: string;
}

export interface Consent {
  id: string;
  borrower_id: string;
  plaid_consent_id: string | null;
  plaid_consent_id_hash: string | null;
  plaid_recipient_id: string | null;
  /** The account this mandate pays into. Fixed once the borrower approves it. */
  recipient_id: string | null;
  status: ConsentStatus;
  currency: string;
  max_payment_amount_minor: number | null;
  period: string | null;
  periodic_alignment: string | null;
  periodic_max_amount_minor: number | null;
  valid_from: string | null;
  valid_to: string | null;
  authorized_at: string | null;
  raw_constraints: string | null;
  created_at: string;
}

export interface RepaymentSchedule {
  id: string;
  borrower_id: string;
  amount_minor: number;
  currency: string;
  frequency: Frequency;
  interval_days: number | null;
  /** Comma-separated ISO weekdays for 'daily'; null/empty means every day. */
  days_of_week: string | null;
  start_date: string;
  end_mode: EndMode;
  end_date: string | null;
  end_count: number | null;
  end_total_minor: number | null;
  next_run_date: string | null;
  /** Which mandate scheduled runs collect against. Null means the default one. */
  consent_id: string | null;
  active: number;
  created_at: string;
}

export interface Payment {
  id: string;
  borrower_id: string;
  consent_id: string | null;
  schedule_id: string | null;
  idempotency_key: string;
  plaid_payment_id: string | null;
  provider_request_id: string | null;
  amount_minor: number;
  currency: string;
  reference: string | null;
  status: PaymentStatus;
  status_version: number;
  scheduled_for: string | null;
  submitted_at: string | null;
  last_status_at: string | null;
  last_provider_check_at: string | null;
  reconcile_after: string | null;
  reconciliation_attempts: number;
  failure_reason: string | null;
  retry_of: string | null;
  created_at: string;
}

export type PaymentIntentKind = "manual" | "scheduled" | "retry";
export type PaymentIntentStatus = "prepared" | "executing" | "completed" | "cancelled";

export interface PaymentIntent {
  id: string;
  borrower_id: string;
  schedule_id: string | null;
  kind: PaymentIntentKind;
  amount_minor: number;
  currency: string;
  reference: string;
  idempotency_key: string;
  status: PaymentIntentStatus;
  payment_id: string | null;
  created_by: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface SetupLink {
  id: string;
  borrower_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Settings {
  id: string;
  default_retry_max: number;
  default_retry_spacing_hours: number;
  default_reference_format: string;
  sending_domain: string | null;
  retention_days: number;
  updated_at: string;
  updated_by: string | null;
}

export interface AuditEntry {
  id: string;
  actor_staff_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: string | null;
  created_at: string;
}
