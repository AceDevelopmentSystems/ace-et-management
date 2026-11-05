// Thin fetch wrapper for the Nest API. The token lives in sessionStorage (cleared when the tab closes).

const TOKEN_KEY = 'ace.token';

export type Role = 'org_admin' | 'asset_manager' | 'assessor' | 'client_viewer' | 'contractor';
export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY));

/** Display-only decode of the JWT payload (the server enforces everything; this just hides buttons). */
export function claimsOf(token: string | null): { role: Role; org: string } | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return { role: payload.role, org: payload.org };
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const UNAUTHORIZED_EVENT = 'ace:unauthorized';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    // A 401 on a protected call means the token is missing/expired. Login failures also return 401 but carry no token.
    if (res.status === 401 && token) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const m = (data as { message?: string | string[] } | undefined)?.message;
    throw new ApiError(res.status, Array.isArray(m) ? m.join('; ') : m ?? `Request failed (${res.status})`);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// ------------------------------------------------------------------ types (as returned by the API)
export interface Client { id: string; name: string; code: string | null; currency: string }
export interface Region { id: string; code: string; name: string; site_count: number }
export type TrashEntity = 'client' | 'region' | 'site' | 'asset-type' | 'asset' | 'scenario' | 'contractor' | 'contract' | 'contract-line' | 'work-order' | 'invoice' | 'tax-code';
export interface TrashItem {
  entity: TrashEntity; id: string; label: string; clientId: string | null; clientName: string | null;
  deletedAt: string; deletedBy: string | null; /** Items that went with it (sites and assets of a deleted client, assets of a site). */ includes: number;
}
export interface Site {
  id: string; code: string; name: string; site_class: string | null; address: string | null;
  region_id: string | null; region_code: string | null; region_name: string | null;
}
export interface AssetType { id: string; parent_id: string | null; name: string; expected_life_years: number | null; unit: string | null; unit_rate: string | null }
export interface Asset {
  id: string; parent_id: string | null; asset_type_id: string | null; name: string; install_date: string | null;
  quantity: string; unit: string | null; unit_rate: string | null; expected_life_years: number | null; criticality: number | null;
}

export const CONDITIONS = ['none', 'excellent', 'good', 'average', 'poor', 'veryPoor', 'urgent'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABEL: Record<Condition, string> = {
  none: 'Not graded', excellent: 'Excellent', good: 'Good', average: 'Average', poor: 'Poor', veryPoor: 'Very poor', urgent: 'Urgent',
};

export interface ScenarioParams {
  startYear: number; horizonYears: number; inflation: number; discountRate: number;
  overdue: 'year1' | 'spread' | 'ignore'; overdueSpreadYears: number; annualCap?: number;
}
export interface SavedScenario { id: string; name: string; params: ScenarioParams; created_at: string }
export interface YearTotal { year: number; real: number; nominal: number; presentValue: number }
export interface LeveledYear { year: number; demand: number; spend: number; carried: number }
export interface ForecastResponse {
  scenario: ScenarioParams;
  assetsAssessed: number;
  skipped: string[];
  byYear: YearTotal[];
  leveled?: LeveledYear[];
  bySite: Record<string, Record<string, number>>;
  totals: { real: number; nominal: number; presentValue: number };
}

// ------------------------------------------------------------------ contractors, contracts, work orders
export interface Contractor {
  id: string; name: string; contact_name: string | null; email: string | null; phone: string | null; notes: string | null; contract_count: number;
}
export type ContractStatus = 'draft' | 'active' | 'closed';
export interface ContractSummary {
  id: string; code: string; name: string; status: ContractStatus; start_date: string; end_date: string;
  contractor_id: string; contractor_name: string | null; line_count: number; open_work_orders: number;
}
export type Frequency = 'day' | 'week' | 'month' | 'year';
export interface ContractLine {
  id: string; description: string; frequency_interval: number; frequency_unit: Frequency; first_due_date: string; cost_per_occurrence: string;
  site_id: string | null; asset_id: string | null; site_code: string | null; site_name: string | null; asset_name: string | null; asset_site_code: string | null;
}
export interface ContractDetail {
  id: string; client_id: string; code: string; name: string; status: ContractStatus; start_date: string; end_date: string; notes: string | null;
  contractor_id: string; contractor_name: string | null; lines: ContractLine[]; workOrderCounts: Record<string, number>;
}
export type WorkOrderStatus = 'new' | 'in_progress' | 'complete' | 'cancelled';
export interface WorkOrder {
  id: string; code: string; title: string; status: WorkOrderStatus; due_date: string; estimated_cost: string | null; actual_cost: string | null;
  completed_on: string | null; notes: string | null; client_id: string; site_id: string; site_code: string; site_name: string;
  asset_id: string | null; asset_name: string | null; contract_id: string | null; contract_code: string | null; contract_line_id: string | null;
  contractor_id: string | null; contractor_name: string | null;
}
export interface GenerateResult {
  dryRun: boolean; from: string | null; through: string; existing: number; deletedSkipped: number; wouldCreate: number; created: number;
  sample: { lineId: string; description: string; dueDate: string }[];
}

// ------------------------------------------------------------------ invoices (recorded, never paid by this system)
export interface TaxCode { id: string; code: string; name: string; rate: string; external_codes: Record<string, string> }
export type InvoiceStatus = 'received' | 'approved' | 'exported' | 'paid' | 'disputed' | 'rejected';
export interface InvoiceSummary {
  id: string; client_id: string; contractor_id: string; contractor_name: string; contract_id: string | null; contract_code: string | null;
  supplier_ref: string; issue_date: string; due_date: string | null; currency: string; net: string; tax: string; gross: string;
  status: InvoiceStatus; source: string; notes: string | null; approved_at: string | null; override_reason: string | null; paid_on: string | null; line_count: number;
}
export interface InvoiceLine {
  id: string; position: number; description: string; quantity: string; unit_price: string; net: string; tax_code_id: string | null; tax_code: string | null;
  tax_amount: string; work_order_id: string | null; work_order_code: string | null; account_code: string | null;
}
export interface InvoiceWarning { code: string; message: string; lineId?: string; workOrderId?: string }
export interface InvoiceDetail extends Omit<InvoiceSummary, 'line_count'> { lines: InvoiceLine[]; warnings: InvoiceWarning[] }
