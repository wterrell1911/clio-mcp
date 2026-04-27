import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clioGet } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

/**
 * Field list for the /relationships.json endpoint.
 * This endpoint does NOT support nested field selection on the contact
 * sub-object — Clio rejects requests that try to specify which contact
 * subfields to return. So we just request "contact" flat and accept
 * whatever default contact representation Clio returns (id, name, type).
 *
 * For full contact detail (email, phone, address) we have to make a
 * follow-up call to /contacts/{id}.json — see CONTACT_DETAIL_FIELDS below.
 */
const RELATIONSHIP_FIELDS = "id,description,contact";

/**
 * Field list for the /contacts/{id}.json endpoint.
 * This endpoint DOES support nested selection. Mirrors the field list
 * used by the existing get_contact tool in tools/contacts.ts so that
 * downstream skills get a consistent contact shape regardless of how
 * they obtained it.
 */
const CONTACT_DETAIL_FIELDS =
  "id,name,first_name,last_name,title,email_addresses{address,name}," +
  "phone_numbers{number,name},company{id,name},type,created_at,updated_at," +
  "addresses{name,street,city,province,postal_code,country}";

/**
 * Internal helper: fetch all relationships on a matter in one call.
 * Returns the raw relationship records (id, description, shallow contact).
 * Both list_matter_relationships and list_matter_contacts share this so
 * we only have one place that talks to /relationships.json.
 */
async function fetchMatterRelationships(matter_id: number) {
  const data = await clioGet("/relationships.json", {
    matter_id: String(matter_id),
    fields: RELATIONSHIP_FIELDS,
    limit: "200",
  });
  return (data.data as any[]) ?? [];
}

/**
 * Internal helper: fetch full contact detail for a single contact.
 * Used by get_full_relationships to enrich the shallow contact records
 * returned by /relationships.json with email, phone, and address.
 */
async function fetchContactDetail(contact_id: number) {
  const data = await clioGet(`/contacts/${contact_id}.json`, {
    fields: CONTACT_DETAIL_FIELDS,
  });
  return data.data;
}

export function registerRelationshipTools(server: McpServer) {
  // ── Tool: list_matter_relationships ──────────────────────────────────────
  // Lightweight: returns role + shallow contact (name, id, type) only.
  // Use this when you just need to know who is on the matter and what
  // their role is. For full contact info, use get_full_relationships.
  server.registerTool(
    "list_matter_relationships",
    {
      description:
        "List all party relationships on a matter. Returns each contact " +
        "attached to the matter alongside their role label (\"Plaintiff\", " +
        "\"Opposing Counsel\", \"Plaintiff Counsel\", \"Codefendant\", " +
        "etc.) and basic contact info (name, id, type). Use this for a " +
        "quick parties overview. For full contact details (email, phone, " +
        "address) needed for cc-routing on letters, use " +
        "get_full_relationships instead.",
      inputSchema: {
        matter_id: z.number().int().describe("The Clio matter ID"),
      },
    },
    async ({ matter_id }) => {
      try {
        const relationships = await fetchMatterRelationships(matter_id);

        await appendAuditLog({
          tool: "list_matter_relationships",
          args: { matter_id },
          outcome: "success",
          matter_id,
          result_count: relationships.length,
        });

        if (relationships.length === 0) {
          return {
            content: [
              { type: "text", text: "No relationships found on this matter." },
            ],
          };
        }

        const result = relationships.map((r) => ({
          relationship_id: r.id,
          role: r.description,
          contact: r.contact,
        }));

        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_matter_relationships",
          args: { matter_id },
          outcome: "error",
          error_message: err.message,
        });
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool: list_matter_contacts ───────────────────────────────────────────
  // Convenience wrapper — same shallow contact data as
  // list_matter_relationships, stripped of the role label. Useful when
  // you want a flat list of parties without caring about their role.
  server.registerTool(
    "list_matter_contacts",
    {
      description:
        "List every contact attached to a matter, with basic contact " +
        "info (name, id, type). Does not include the client itself (use " +
        "get_matter for that). For role-aware listing, use " +
        "list_matter_relationships. For full contact details needed for " +
        "cc-routing, use get_full_relationships.",
      inputSchema: {
        matter_id: z.number().int().describe("The Clio matter ID"),
      },
    },
    async ({ matter_id }) => {
      try {
        const relationships = await fetchMatterRelationships(matter_id);
        const contacts = relationships
          .map((r) => r.contact)
          .filter((c) => c != null);

        await appendAuditLog({
          tool: "list_matter_contacts",
          args: { matter_id },
          outcome: "success",
          matter_id,
          result_count: contacts.length,
        });

        return {
          content: [
            { type: "text", text: JSON.stringify(contacts, null, 2) },
          ],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_matter_contacts",
          args: { matter_id },
          outcome: "error",
          error_message: err.message,
        });
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool: get_full_relationships ─────────────────────────────────────────
  // The cc-routing workhorse. Lists all parties on a matter AND fetches
  // full contact details (email, phone, address) for each one in a
  // single call. Implemented as 1 + N API calls under the hood:
  //   1 call to /relationships.json to get the party list
  //   N calls to /contacts/{id}.json (one per party) for full details
  //
  // The N calls run in parallel (Promise.allSettled) so total latency
  // is roughly 2 round trips even for matters with many parties.
  //
  // Returns a single merged object per party — relationship_id, role,
  // and full contact record — that the /draft-letter skill can pass
  // straight into a letterhead template's cc-list rendering.
  server.registerTool(
    "get_full_relationships",
    {
      description:
        "List all party relationships on a matter WITH full contact " +
        "details (email, phone, address) for each party. Use this when " +
        "you need to populate a cc list, generate a certificate of " +
        "service, or otherwise produce a recipient block on outbound " +
        "correspondence. Returns role label plus complete contact " +
        "record per party in one call. Slower than " +
        "list_matter_relationships (1 + N API calls) but eliminates the " +
        "need for follow-up contact lookups in the calling skill.",
      inputSchema: {
        matter_id: z.number().int().describe("The Clio matter ID"),
      },
    },
    async ({ matter_id }) => {
      try {
        const relationships = await fetchMatterRelationships(matter_id);

        if (relationships.length === 0) {
          await appendAuditLog({
            tool: "get_full_relationships",
            args: { matter_id },
            outcome: "success",
            matter_id,
            result_count: 0,
          });
          return {
            content: [
              { type: "text", text: "No relationships found on this matter." },
            ],
          };
        }

        // Fetch full contact detail for each party in parallel.
        // allSettled (not all) so a single failed lookup doesn't poison
        // the whole result — the failed party gets returned with just
        // its shallow contact record and a `contact_detail_error` flag.
        const detailResults = await Promise.allSettled(
          relationships.map((r) =>
            r.contact?.id
              ? fetchContactDetail(r.contact.id)
              : Promise.reject(new Error("relationship has no contact id"))
          )
        );

        const merged = relationships.map((r, i) => {
          const detail = detailResults[i];
          if (detail.status === "fulfilled") {
            return {
              relationship_id: r.id,
              role: r.description,
              contact: detail.value,
            };
          } else {
            return {
              relationship_id: r.id,
              role: r.description,
              contact: r.contact, // shallow fallback
              contact_detail_error: detail.reason?.message ?? "unknown error",
            };
          }
        });

        const error_count = detailResults.filter(
          (d) => d.status === "rejected"
        ).length;

        await appendAuditLog({
          tool: "get_full_relationships",
          args: { matter_id },
          outcome: "success",
          matter_id,
          result_count: merged.length,
          ...(error_count > 0 && { error_count }),
        });

        return {
          content: [
            { type: "text", text: JSON.stringify(merged, null, 2) },
          ],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "get_full_relationships",
          args: { matter_id },
          outcome: "error",
          error_message: err.message,
        });
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
