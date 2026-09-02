// Thin BigQuery client over the REST API.
//
// Uses the token from `gcloud auth print-access-token` rather than a service
// account, so there is no key file to leak. Every query is dry-run first: the
// sandbox allows 1TB a month and the OpenStreetMap tables are large enough to
// spend all of it in a single careless SELECT.

import { execFileSync } from "node:child_process";

const API = "https://bigquery.googleapis.com/bigquery/v2";

const token = () => {
  try {
    return execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "Not signed in. Run:\n" +
      "  gcloud auth login\n" +
      "  gcloud config set project museum-that-remembers-e0bd0",
    );
  }
};

export const projectId = () => {
  try {
    return execFileSync("gcloud", ["config", "get-value", "project"], { encoding: "utf8" }).trim();
  } catch {
    return process.env.GOOGLE_CLOUD_PROJECT ?? "";
  }
};

const call = async (project, body) => {
  const response = await fetch(`${API}/projects/${project}/queries`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message ?? `BigQuery ${response.status}`);
  }
  return data;
};

const gb = (bytes) => (Number(bytes || 0) / 1e9).toFixed(2);

/**
 * Run a query, refusing anything that would scan more than `maxGb`.
 * Returns rows as plain objects.
 */
export const query = async (sql, { params = {}, maxGb = 40, label = "query" } = {}) => {
  const project = projectId();
  if (!project) throw new Error("No project set. Run: gcloud config set project <id>");

  const queryParameters = Object.entries(params).map(([name, value]) => ({
    name,
    parameterType: Array.isArray(value)
      ? { type: "ARRAY", arrayType: { type: "STRING" } }
      : { type: typeof value === "number" ? "FLOAT64" : "STRING" },
    parameterValue: Array.isArray(value)
      ? { arrayValues: value.map((v) => ({ value: String(v) })) }
      : { value: String(value) },
  }));

  const base = {
    query: sql,
    useLegacySql: false,
    parameterMode: Object.keys(params).length ? "NAMED" : undefined,
    queryParameters: queryParameters.length ? queryParameters : undefined,
  };

  // 1. price it
  const dry = await call(project, { ...base, dryRun: true });
  const bytes = Number(dry.totalBytesProcessed ?? 0);
  console.log(`   ${label}: would scan ${gb(bytes)} GB`);
  if (bytes / 1e9 > maxGb) {
    throw new Error(
      `Refusing to run: ${gb(bytes)} GB exceeds the ${maxGb} GB cap for this query.\n` +
      `Narrow the bounding box or the columns, or raise maxGb deliberately.`,
    );
  }

  // 2. run it
  const result = await call(project, { ...base, timeoutMs: 120_000, maxResults: 2000 });
  const fields = (result.schema?.fields ?? []).map((f) => f.name);
  return (result.rows ?? []).map((row) =>
    Object.fromEntries(fields.map((name, i) => [name, row.f[i]?.v])),
  );
};
