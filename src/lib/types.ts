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

export type Frequency = "weekly" | "fortnightly" | "monthly" | "custom";
export type EndMode = "date" | "count" | "total";

export type PaymentStatus =
  | "pending"
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
  created_at: string;
}

export interface Consent {
  id: string;
  borrower_id: string;
  plaid_consent_id: string | null;
  plaid_recipient_id: string | null;
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
  start_date: string;
  end_mode: EndMode;
  end_date: string | null;
  end_count: number | null;
  end_total_minor: number | null;
  next_run_date: string | null;
  active: number;
  created_at: string;
}

export interface Payment {
  id: string;
  borrower_id: string;
  consent_id: string | null;
  idempotency_key: string;
  plaid_payment_id: string | null;
  amount_minor: number;
  currency: string;
  reference: string | null;
  status: PaymentStatus;
  scheduled_for: string | null;
  submitted_at: string | null;
  last_status_at: string | null;
  failure_reason: string | null;
  retry_of: string | null;
  created_at: string;
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
