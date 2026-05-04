/**
 * Mock Repull API — deterministic responses for every agent tool.
 *
 * The eval harness NEVER calls the real Repull API or any live LLM. Every
 * tool result the fixture runner uses comes from this mock, which:
 *   - returns the same shape the real API does (so the data-fidelity check
 *     looks for actual numeric tokens in the response),
 *   - is parameter-aware (different listing IDs / dates → different totals)
 *     so the tool args matter,
 *   - varies BY CATEGORY but stays small enough that all the numbers fit
 *     in a single response without truncation.
 *
 * The data-fidelity check is what makes this matter: if the agent's
 * response says "1881 EUR" then "1881" must appear in one of the
 * `toolCalls[i].result` payloads — otherwise the agent invented the
 * number. The fixture runner copies its numbers directly from the mock
 * results so the assertion holds.
 */
import { FIXTURE_CUSTOMER } from "./customer.js";

export interface MockReservationRow {
  id: number;
  listing_id: number;
  guest_id: number;
  guest_name: string;
  check_in: string;
  check_out: string;
  status: "pending" | "confirmed" | "cancelled" | "completed";
  total: number;
  currency: string;
  channel: "airbnb" | "booking" | "direct";
}

export interface MockRevenueResult {
  from: string;
  to: string;
  currency: string;
  total: number;
  byChannel: Array<{ channel: string; total: number }>;
}

export interface MockOccupancyResult {
  from: string;
  to: string;
  occupancyPct: number;
  bookedNights: number;
  availableNights: number;
  byListing: Array<{ listing_id: number; occupancy_pct: number }>;
}

export interface MockPricingResult {
  listing_id: number;
  date: string;
  price: number;
  currency: string;
  min_stay: number;
  available: boolean;
}

export interface MockMarketContextResult {
  city: string;
  country: string;
  comp_avg: number;
  top_quartile: number;
  occupancy_band: string;
  sample_size: number;
  currency: string;
}

export interface MockGuestRow {
  id: number;
  name: string;
  email: string;
  phone: string;
  reservation_count: number;
}

export interface MockCleaningTask {
  listing_id: number;
  cleaner: string;
  status: "scheduled" | "in-progress" | "done";
  notes: string | null;
}

export interface MockReservationsResponse {
  data: MockReservationRow[];
  count: number;
}

export interface MockGuestsResponse {
  data: MockGuestRow[];
  count: number;
}

export interface MockCleaningResponse {
  date: string;
  data: MockCleaningTask[];
}

/**
 * The dispatcher: every fixture-runner tool-call funnels through this.
 * It branches on tool name and returns deterministic JSON-shaped data.
 *
 * Pure: no network, no fs, no clock. Same args ⇒ same output.
 */
export function callMockTool(
  tool: string,
  args: Record<string, unknown>,
): unknown {
  switch (tool) {
    case "getReservations":
      return mockReservations(args);
    case "getCurrentPricing":
      return mockPricing(args);
    case "getMarketContext":
      return mockMarketContext(args);
    case "getRevenue":
      return mockRevenue(args);
    case "getOccupancyRate":
      return mockOccupancy(args);
    case "searchGuests":
      return mockGuests(args);
    case "getCleaningRota":
      return mockCleaning(args);
    default:
      return { error: { code: "UNKNOWN_TOOL", message: `unknown tool: ${tool}` } };
  }
}

function mockReservations(args: Record<string, unknown>): MockReservationsResponse {
  const status = typeof args["status"] === "string" ? args["status"] : undefined;
  const listingId = args["listing_id"];
  let rows: MockReservationRow[] = FIXTURE_CUSTOMER.reservations.map((r, i) => ({
    id: r.id,
    listing_id: r.listingId,
    guest_id: r.guestId,
    guest_name: r.guestName,
    check_in: r.checkIn,
    check_out: r.checkOut,
    status: r.status,
    total: r.total,
    currency: r.currency,
    channel: (["airbnb", "booking", "direct"] as const)[i % 3]!,
  }));
  if (status) rows = rows.filter((r) => r.status === status);
  if (listingId !== undefined) {
    const lid = Number(listingId);
    rows = rows.filter((r) => r.listing_id === lid);
  }
  return { data: rows, count: rows.length };
}

function mockPricing(args: Record<string, unknown>): MockPricingResult {
  // Deterministic seeding: hash(listing_id, date) → price between 150 and 280.
  const listingId = Number(args["listing_id"] ?? 0);
  const date = String(args["date"] ?? "1970-01-01");
  const price = 150 + ((listingId + datehash(date)) % 130);
  return {
    listing_id: listingId,
    date,
    price,
    currency: "EUR",
    min_stay: 2,
    available: true,
  };
}

function mockMarketContext(args: Record<string, unknown>): MockMarketContextResult {
  const city = String(args["city"] ?? "Lisbon");
  const country = String(args["country"] ?? "Portugal");
  // Deterministic per-(city,country) but distinct from listing pricing.
  const seed = datehash(`${city.toLowerCase()}|${country.toLowerCase()}`);
  const comp = 180 + (seed % 60);
  return {
    city,
    country,
    comp_avg: comp,
    top_quartile: comp + 47,
    occupancy_band: "0.55-0.70",
    sample_size: 87,
    currency: "EUR",
  };
}

function mockRevenue(args: Record<string, unknown>): MockRevenueResult {
  const from = String(args["from"] ?? "1970-01-01");
  const to = String(args["to"] ?? "1970-01-01");
  // Sum confirmed reservation totals — deterministic + non-trivial.
  const confirmed = FIXTURE_CUSTOMER.reservations.filter((r) => r.status === "confirmed");
  const total = confirmed.reduce((acc, r) => acc + r.total, 0);
  return {
    from,
    to,
    currency: "EUR",
    total,
    byChannel: [
      { channel: "airbnb", total: Math.round(total * 0.55) },
      { channel: "booking", total: Math.round(total * 0.3) },
      { channel: "direct", total: total - Math.round(total * 0.55) - Math.round(total * 0.3) },
    ],
  };
}

function mockOccupancy(args: Record<string, unknown>): MockOccupancyResult {
  const from = String(args["from"] ?? "1970-01-01");
  const to = String(args["to"] ?? "1970-01-01");
  return {
    from,
    to,
    occupancyPct: 67,
    bookedNights: 14,
    availableNights: 21,
    byListing: FIXTURE_CUSTOMER.listings.map((l, i) => ({
      listing_id: l.id,
      occupancy_pct: 60 + i * 8,
    })),
  };
}

function mockGuests(args: Record<string, unknown>): MockGuestsResponse {
  const q = String(args["query"] ?? "").toLowerCase();
  const all = FIXTURE_CUSTOMER.guests.map((g) => ({
    id: g.id,
    name: g.name,
    email: g.email,
    phone: g.phone,
    reservation_count: g.reservationCount,
  }));
  const data = q
    ? all.filter(
        (g) =>
          g.name.toLowerCase().includes(q) ||
          g.email.toLowerCase().includes(q) ||
          g.phone.toLowerCase().includes(q),
      )
    : all;
  return { data, count: data.length };
}

function mockCleaning(args: Record<string, unknown>): MockCleaningResponse {
  const date = String(args["date"] ?? "1970-01-01");
  return {
    date,
    data: [
      {
        listing_id: FIXTURE_CUSTOMER.listings[0]!.id,
        cleaner: "Maria Sousa",
        status: "scheduled",
        notes: null,
      },
      {
        listing_id: FIXTURE_CUSTOMER.listings[1]!.id,
        cleaner: "João Pereira",
        status: "in-progress",
        notes: "guest leaving late",
      },
    ],
  };
}

/**
 * Tiny string hash (FNV-1a 32-bit). Used purely to seed deterministic
 * mock numbers — the harness only needs reproducibility, not crypto.
 */
function datehash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}
