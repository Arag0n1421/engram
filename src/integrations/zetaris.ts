import { randomUUID } from "node:crypto";
import { isSafeQualifiedSqlIdentifier, validateZetarisConfig, type RecallOpsView, type ZetarisConfig } from "./config.ts";
import { fetchJson, IntegrationError, isRecord, type FetchLike, type ResponseEvidence } from "./http.ts";

export interface ZetarisQueryResult {
  columns: string[];
  rows: unknown[][];
  evidence: ResponseEvidence & { queryId: string; limit: number };
  /** A full limit means truncation is possible; do not claim exhaustive exposure from these rows. */
  possiblyTruncated: boolean;
}

export type RecallOpsFilter = Partial<Record<"site_id" | "internal_sku" | "manufacturer_ref" | "lot" | "destination_site_id", string>>;

export const RECALL_OPS_COLUMNS: Record<RecallOpsView, readonly string[]> = {
  inventory: ["id", "site_id", "internal_sku", "manufacturer_ref", "lot", "packaging_level", "unit", "quantity", "reserved_quantity", "expires_at", "qa_status", "qa_evidence_ref", "expiry_evidence_ref", "allocation_hold", "physical_quarantine_status", "source_version", "is_fictional"],
  shipments: ["id", "destination_site_id", "internal_sku", "manufacturer_ref", "lot", "packaging_level", "unit", "quantity", "eta", "status", "expires_at", "qa_status", "qa_evidence_ref", "expiry_evidence_ref", "planning_availability_is_conditional_on_receipt_and_acceptance", "source_version"],
  demand: ["id", "site_id", "internal_sku", "demand_quantity", "required_ending_reserve", "source_version"],
  products: ["internal_sku", "manufacturer_ref", "description", "each_udi", "case_udi", "unit", "unit_description", "pack_conversion_enabled", "approved_item_for_demo", "approval_evidence_ref", "product_identifier_source_id", "allowed_substitute_skus"],
  sites: ["id", "name", "is_fictional"],
};

export const FDA_SCOPE_COLUMNS = ["source_url", "retrieved_at", "rawsha256", "recall_id", "record_id", "manufacturer_ref", "product_description", "each_udi", "case_udi", "lot_source_field", "lot_number"] as const;

export class ZetarisClient {
  private readonly config: ZetarisConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: ZetarisConfig, fetchImpl: FetchLike = fetch) {
    this.config = validateZetarisConfig(config);
    this.fetchImpl = fetchImpl;
  }

  async listDatasources(): Promise<{ count: number; evidence: ResponseEvidence }> {
    const { body, evidence } = await fetchJson(this.fetchImpl, "Zetaris", `${this.config.baseUrl}/datasource/datasources`, { headers: this.headers() }, this.config.timeoutMs);
    const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
    if (!rows) throw new IntegrationError("INVALID_RESPONSE", "Zetaris datasource response did not contain a list", evidence.status, evidence);
    return { count: rows.length, evidence };
  }

  async checkConnection(): Promise<{ status: "passed"; evidence: ZetarisQueryResult["evidence"] }> {
    const result = await this.run("SELECT 1 AS one", 2, ["one"]);
    if (result.rows.length !== 1 || result.rows[0]?.length !== 1 || ![1, "1"].includes(result.rows[0][0] as string | number)) {
      throw new IntegrationError("SMOKE_RESULT_MISMATCH", "Zetaris SELECT 1 did not return exactly one expected row", result.evidence.status, result.evidence);
    }
    return { status: "passed", evidence: result.evidence };
  }

  /** Reads only explicitly configured, verified RecallOps views; never accepts free-form SQL. */
  async queryRecallOpsView(view: RecallOpsView, filters: RecallOpsFilter = {}, limit = 1000): Promise<ZetarisQueryResult> {
    const qualifiedName = this.config.views?.[view];
    if (!qualifiedName) throw new IntegrationError("VIEW_NOT_CONFIGURED", "The requested RecallOps view has not been registered and configured");
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*){0,2}$/.test(qualifiedName)) {
      throw new IntegrationError("INVALID_VIEW_IDENTIFIER", "Configured RecallOps view is not a safe qualified SQL identifier");
    }
    validateLimit(limit);
    const predicates = Object.entries(filters).map(([column, value]) => {
      if (!["site_id", "internal_sku", "manufacturer_ref", "lot", "destination_site_id"].includes(column) || !RECALL_OPS_COLUMNS[view].includes(column)) throw new IntegrationError("INVALID_FILTER", "Unsupported filter column for this RecallOps view");
      if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\u0000-\u001f\\]/.test(value)) {
        throw new IntegrationError("INVALID_FILTER", "RecallOps filters must be bounded text identifiers without control characters or backslashes");
      }
      return `${column} = '${value.replace(/'/g, "''")}'`;
    });
    const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
    const columns = [...RECALL_OPS_COLUMNS[view]];
    return this.run(`SELECT ${columns.join(", ")} FROM ${qualifiedName}${where} LIMIT ${limit}`, limit, columns);
  }

  /** Reads the separately configured FDA reviewed-scope view with a fixed column contract. */
  async queryReviewedScope(limit = 1000): Promise<ZetarisQueryResult> {
    const qualifiedName = this.config.reviewedScopeView;
    if (!qualifiedName) throw new IntegrationError("VIEW_NOT_CONFIGURED", "The reviewed FDA scope view has not been registered and configured");
    if (!isSafeQualifiedSqlIdentifier(qualifiedName)) throw new IntegrationError("INVALID_VIEW_IDENTIFIER", "Configured reviewed FDA scope view is not a safe qualified SQL identifier");
    validateLimit(limit);
    const columns = [...FDA_SCOPE_COLUMNS];
    return this.run(`SELECT ${columns.join(", ")} FROM ${qualifiedName} LIMIT ${limit}`, limit, columns);
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}`, "X-Org-ID": this.config.orgId, "X-Request-ID": randomUUID(), "Content-Type": "application/json" };
  }

  private async run(sql: string, limit: number, columns: string[]): Promise<ZetarisQueryResult> {
    validateLimit(limit);
    const queryId = randomUUID();
    const { body, evidence } = await fetchJson(this.fetchImpl, "Zetaris", `${this.config.baseUrl}/sql-editor/sqls/run`, {
      method: "POST", headers: this.headers(), body: JSON.stringify({ queryId, sql, source: "SqlEditor", limit }),
    }, this.config.timeoutMs);
    if (isRecord(body) && (body.error != null || body.success === false || (typeof body.status === "string" && /^(error|failed|failure)$/i.test(body.status)))) {
      throw new IntegrationError("QUERY_REJECTED", "Zetaris reported an unsuccessful SQL query", evidence.status, evidence);
    }
    if (!isRecord(body) || !Array.isArray(body.data) || !body.data.every(Array.isArray)) {
      throw new IntegrationError("INVALID_RESPONSE", "Zetaris query response did not contain row arrays", evidence.status, evidence);
    }
    if (!body.data.every((row) => row.length === columns.length)) throw new IntegrationError("ROW_SHAPE_MISMATCH", "Zetaris returned a different column count than the explicit view query", evidence.status, evidence);
    return { columns, rows: body.data as unknown[][], evidence: { ...evidence, queryId, limit }, possiblyTruncated: body.data.length >= limit };
  }
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new IntegrationError("INVALID_LIMIT", "RecallOps query limit must be an integer between 1 and 1000");
}
