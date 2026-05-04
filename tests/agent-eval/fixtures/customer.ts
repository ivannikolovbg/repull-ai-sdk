/**
 * Fixture customer data — used by the deterministic fixture runner to
 * synthesize plausible agent outputs for CI eval runs.
 *
 * IMPORTANT: this is the ONLY customer the fixture runner knows about.
 * No real PII. Anything that looks like a phone number or email is
 * synthesised. Per CLAUDE.md the demo customer ID is 1, NEVER 10 (which
 * is a real paying customer in the production Vanio system).
 */

export interface FixtureGuest {
  id: number;
  name: string;
  email: string;
  phone: string;
  reservationCount: number;
}

export interface FixtureReservation {
  id: number;
  listingId: number;
  guestId: number;
  guestName: string;
  checkIn: string;
  checkOut: string;
  status: "pending" | "confirmed" | "cancelled" | "completed";
  total: number;
  currency: string;
}

export interface FixtureListing {
  id: number;
  name: string;
  city: string;
  country: string;
}

export interface FixtureCustomer {
  id: number;
  name: string;
  guests: FixtureGuest[];
  reservations: FixtureReservation[];
  listings: FixtureListing[];
}

export const FIXTURE_CUSTOMER: FixtureCustomer = {
  id: 1,
  name: "Demo Vacation Rentals",
  guests: [
    {
      id: 100,
      name: "Alice Johnson",
      email: "alice.demo@example.com",
      phone: "+1-555-0100",
      reservationCount: 3,
    },
    {
      id: 101,
      name: "Bob Martinez",
      email: "bob.demo@example.com",
      phone: "+1-555-0101",
      reservationCount: 1,
    },
    {
      id: 102,
      name: "Carmen Diaz",
      email: "carmen.demo@example.com",
      phone: "+34-555-0102",
      reservationCount: 2,
    },
  ],
  reservations: [
    {
      id: 9001,
      listingId: 4118,
      guestId: 100,
      guestName: "Alice Johnson",
      checkIn: "2026-05-04",
      checkOut: "2026-05-07",
      status: "confirmed",
      total: 612,
      currency: "EUR",
    },
    {
      id: 9002,
      listingId: 4118,
      guestId: 101,
      guestName: "Bob Martinez",
      checkIn: "2026-05-08",
      checkOut: "2026-05-11",
      status: "confirmed",
      total: 549,
      currency: "EUR",
    },
    {
      id: 9003,
      listingId: 4119,
      guestId: 102,
      guestName: "Carmen Diaz",
      checkIn: "2026-05-15",
      checkOut: "2026-05-18",
      status: "pending",
      total: 720,
      currency: "EUR",
    },
  ],
  listings: [
    { id: 4118, name: "Lisbon Riverside Loft", city: "Lisbon", country: "Portugal" },
    { id: 4119, name: "Lisbon Old Town Studio", city: "Lisbon", country: "Portugal" },
  ],
};
