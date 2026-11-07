// Wedge agency contacts — REVIEW STATUS: PENDING ATTORNEY REVIEW.
// These are where "unknown" answers send the user. Category-specific contacts
// win over the state default (category null) in the store lookup. Verified
// against the agencies' own pages on 2026-11-07.

import type { AgencyContact } from "../schema";

export const wedgeAgencyContacts: AgencyContact[] = [
  {
    state: "WA",
    category: null,
    agency_name: "Washington State Department of Agriculture — Food Safety Program",
    contact_url: "https://agr.wa.gov/departments/food-safety/food-safety",
    phone: "360-902-1876",
    email: "foodsafety@agr.wa.gov",
  },
  {
    state: "WA",
    category: "cottage_food",
    agency_name: "WSDA Cottage Food Program",
    contact_url: "https://agr.wa.gov/departments/food-safety/food-safety/cottage-food",
    phone: "360-902-1876",
    email: "cottagefoods@agr.wa.gov",
  },
  {
    state: "WA",
    category: "raw_milk",
    agency_name: "WSDA Food Safety Program — Dairy",
    contact_url: "https://agr.wa.gov/departments/food-safety/food-safety/dairy",
    phone: "360-902-1876",
    email: "dairy@agr.wa.gov",
  },
  {
    state: "WA",
    category: "eggs",
    agency_name: "WSDA Food Safety Program — Egg Handler Licensing",
    contact_url: "https://agr.wa.gov/departments/food-safety/food-safety/eggs",
    phone: "360-902-1876",
    email: "foodsafety@agr.wa.gov",
  },
  {
    state: "CO",
    category: null,
    agency_name:
      "Colorado Department of Public Health & Environment — Division of Environmental Health & Sustainability",
    contact_url: "https://cdphe.colorado.gov/dehs",
    phone: null,
    email: "cdphe_mfgfd@state.co.us",
  },
  {
    state: "CO",
    category: "cottage_food",
    agency_name: "CDPHE — Cottage Foods Program",
    contact_url: "https://cdphe.colorado.gov/dehs/cottage-foods",
    phone: null,
    email: "cdphe_mfgfd@state.co.us",
  },
  {
    state: "CO",
    category: "raw_milk",
    agency_name:
      "CDPHE — Division of Environmental Health & Sustainability (herdshare registration per C.R.S. § 25-5.5-117(2))",
    contact_url: "https://cdphe.colorado.gov/dehs",
    phone: null,
    email: null,
  },
  {
    state: "CO",
    category: "eggs",
    agency_name: "Colorado Department of Agriculture — Egg Program",
    contact_url: "https://ag.colorado.gov/markets/marketing/eggs",
    phone: null,
    email: null,
  },
];
