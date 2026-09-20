/**
 * Mechanically derive a human-labeling evidence card from a frozen Clay trace.
 * No gold labels. No V1/V2 output.
 */

import type { TraceEntry } from "../../src/types.ts";

export interface EvidenceCompanyFields {
  mapKey: string | null;
  name: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  description: string | null;
  size: string | null;
  type: string | null;
  locality: string | null;
  country: string | null;
  employee_count: number | string | null;
  annual_revenue: string | null;
  enrichments: unknown;
}

export interface EvidenceCard {
  caseId: string;
  requestedDomain: string;
  frozenTraceSha256: string;
  toolSequence: string[];
  /** Company fields taken from find-and-enrich-company when present. */
  company: EvidenceCompanyFields | null;
  /**
   * Whether get-task-context company fields differ from find-and-enrich
   * on the labeling-relevant subset (name/domain/website/industry/description).
   */
  taskContextCompanyDiffers: boolean;
  identity: {
    returnedName: string | null;
    returnedDomain: string | null;
    returnedWebsite: string | null;
    /** Heuristic: returned domain/website appears related to requested domain. */
    appearsToMatchRequestedDomain: boolean | null;
    notes: string[];
  };
  sufficiency: {
    hasName: boolean;
    hasIndustry: boolean;
    hasDescription: boolean;
    descriptionLength: number;
    hasEnrichments: boolean;
    missingOrAmbiguousFields: string[];
    /** Operator hint only — not a gold label. */
    appearsSufficientForRubric: boolean | null;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeHost(value: string | null): string | null {
  if (!value) return null;
  let s = value.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0] ?? s;
  s = s.split("?")[0] ?? s;
  return s || null;
}

function hostsRelated(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function extractCompaniesMap(response: unknown): Record<string, unknown> | null {
  const root = asRecord(response);
  if (!root) return null;
  const companies = asRecord(root.companies);
  return companies;
}

function pickCompany(
  companies: Record<string, unknown> | null,
  requestedDomain: string,
): { mapKey: string; value: Record<string, unknown> } | null {
  if (!companies) return null;
  const keys = Object.keys(companies);
  if (keys.length === 0) return null;

  const requested = normalizeHost(requestedDomain);
  const exact = keys.find((k) => normalizeHost(k) === requested);
  if (exact) {
    const value = asRecord(companies[exact]);
    return value ? { mapKey: exact, value } : null;
  }

  // Single entity: use it and let identity heuristics flag mismatches.
  if (keys.length === 1) {
    const value = asRecord(companies[keys[0]]);
    return value ? { mapKey: keys[0], value } : null;
  }

  // Prefer a key related to the requested domain.
  const related = keys.find((k) => hostsRelated(normalizeHost(k), requested));
  if (related) {
    const value = asRecord(companies[related]);
    return value ? { mapKey: related, value } : null;
  }

  const value = asRecord(companies[keys[0]]);
  return value ? { mapKey: keys[0], value } : null;
}

function toCompanyFields(
  mapKey: string,
  company: Record<string, unknown>,
): EvidenceCompanyFields {
  const enrichments = company.enrichments;
  const employeeCount = company.employee_count;
  return {
    mapKey,
    name: asString(company.name),
    domain: asString(company.domain),
    website: asString(company.website),
    industry: asString(company.industry),
    description: asString(company.description),
    size: asString(company.size),
    type: asString(company.type),
    locality: asString(company.locality),
    country: asString(company.country),
    employee_count:
      typeof employeeCount === "number" || typeof employeeCount === "string"
        ? employeeCount
        : null,
    annual_revenue: asString(company.annual_revenue),
    enrichments: enrichments === undefined ? null : enrichments,
  };
}

function labelingSubset(fields: EvidenceCompanyFields | null): {
  name: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  description: string | null;
} {
  return {
    name: fields?.name ?? null,
    domain: fields?.domain ?? null,
    website: fields?.website ?? null,
    industry: fields?.industry ?? null,
    description: fields?.description ?? null,
  };
}

function enrichmentsPresent(enrichments: unknown): boolean {
  if (enrichments == null) return false;
  if (Array.isArray(enrichments)) return enrichments.length > 0;
  if (typeof enrichments === "object") {
    return Object.keys(enrichments as Record<string, unknown>).length > 0;
  }
  return true;
}

/**
 * Build an evidence card from ordered trace entries for one case.
 */
export function deriveEvidenceCard(options: {
  caseId: string;
  requestedDomain: string;
  frozenTraceSha256: string;
  entries: TraceEntry[];
}): EvidenceCard {
  const { caseId, requestedDomain, frozenTraceSha256, entries } = options;
  const toolSequence = entries.map((e) => e.toolName);

  const findEntry = entries.find((e) => e.toolName === "find-and-enrich-company");
  const contextEntry = entries.find((e) => e.toolName === "get-task-context");

  const findPick = pickCompany(
    extractCompaniesMap(findEntry?.response),
    requestedDomain,
  );
  const contextPick = pickCompany(
    extractCompaniesMap(contextEntry?.response),
    requestedDomain,
  );

  const company = findPick
    ? toCompanyFields(findPick.mapKey, findPick.value)
    : contextPick
      ? toCompanyFields(contextPick.mapKey, contextPick.value)
      : null;

  const findFields = findPick
    ? toCompanyFields(findPick.mapKey, findPick.value)
    : null;
  const contextFields = contextPick
    ? toCompanyFields(contextPick.mapKey, contextPick.value)
    : null;

  const taskContextCompanyDiffers =
    findFields !== null &&
    contextFields !== null &&
    JSON.stringify(labelingSubset(findFields)) !==
      JSON.stringify(labelingSubset(contextFields));

  const returnedDomain = company?.domain ?? null;
  const returnedWebsite = company?.website ?? null;
  const returnedName = company?.name ?? null;
  const requestedHost = normalizeHost(requestedDomain);
  const returnedHost = normalizeHost(returnedDomain);
  const websiteHost = normalizeHost(returnedWebsite);

  const identityNotes: string[] = [];
  let appearsToMatchRequestedDomain: boolean | null = null;

  if (!company) {
    identityNotes.push("No company entity found in trace responses.");
    appearsToMatchRequestedDomain = false;
  } else {
    const related =
      hostsRelated(returnedHost, requestedHost) ||
      hostsRelated(websiteHost, requestedHost) ||
      hostsRelated(normalizeHost(company.mapKey), requestedHost);
    appearsToMatchRequestedDomain = related;
    if (!related) {
      identityNotes.push(
        `Returned identity may not match requested domain ${requestedDomain} (domain=${returnedDomain ?? "null"}, website=${returnedWebsite ?? "null"}, mapKey=${company.mapKey}).`,
      );
    }
    if (returnedHost && requestedHost && returnedHost !== requestedHost) {
      identityNotes.push(
        `Returned company.domain (${returnedHost}) differs from requested (${requestedHost}).`,
      );
    }
  }

  const description = company?.description ?? null;
  const descriptionLength = description?.trim().length ?? 0;
  const hasName = Boolean(company?.name?.trim());
  const hasIndustry = Boolean(company?.industry?.trim());
  const hasDescription = descriptionLength > 0;
  const hasEnrichments = enrichmentsPresent(company?.enrichments);

  const missingOrAmbiguousFields: string[] = [];
  if (!hasName) missingOrAmbiguousFields.push("name");
  if (!hasIndustry) missingOrAmbiguousFields.push("industry");
  if (!hasDescription) missingOrAmbiguousFields.push("description");
  if (hasDescription && descriptionLength < 40) {
    missingOrAmbiguousFields.push("description_short");
  }
  if (!hasEnrichments) {
    missingOrAmbiguousFields.push("enrichments_empty");
  }
  if (appearsToMatchRequestedDomain === false) {
    missingOrAmbiguousFields.push("identity_mismatch");
  }

  // Rubric needs enough product signal: name + (industry or non-trivial description).
  const appearsSufficientForRubric =
    company !== null &&
    appearsToMatchRequestedDomain !== false &&
    hasName &&
    (hasIndustry || descriptionLength >= 40);

  return {
    caseId,
    requestedDomain,
    frozenTraceSha256,
    toolSequence,
    company,
    taskContextCompanyDiffers,
    identity: {
      returnedName,
      returnedDomain,
      returnedWebsite,
      appearsToMatchRequestedDomain,
      notes: identityNotes,
    },
    sufficiency: {
      hasName,
      hasIndustry,
      hasDescription,
      descriptionLength,
      hasEnrichments,
      missingOrAmbiguousFields,
      appearsSufficientForRubric,
    },
  };
}
