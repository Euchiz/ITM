// Checklist templates (guideline §19). Pure data — pages render the
// "Add X items" buttons from this list.

export const TEMPLATES = [
  {
    name: "Basic travel",
    items: [
      ["Passport / ID", "document"],
      ["Wallet", "packing"],
      ["Phone charger", "packing"],
      ["Power bank", "packing"],
      ["Medicine", "health"],
      ["Umbrella", "packing"],
      ["Comfortable shoes", "packing"],
      ["Hotel address saved", "document"],
      ["Emergency contact saved", "document"],
    ],
  },
  {
    name: "International",
    items: [
      ["Passport", "document"],
      ["Visa / entry permit", "document"],
      ["Travel insurance", "document"],
      ["SIM card / roaming", "transportation"],
      ["Currency exchange", "payment"],
      ["Power adapter", "packing"],
      ["Customs declaration", "document"],
      ["Flight check-in", "booking"],
      ["Hotel confirmation note", "document"],
    ],
  },
  {
    name: "Road trip",
    items: [
      ["Driver's license", "document"],
      ["Car rental confirmation", "booking"],
      ["Gas plan", "transportation"],
      ["Parking notes", "transportation"],
      ["Snacks", "packing"],
      ["Water", "packing"],
      ["Offline map", "transportation"],
      ["Emergency kit", "health"],
    ],
  },
  {
    name: "Family",
    items: [
      ["Passports / IDs for everyone", "document"],
      ["Medicine", "health"],
      ["Snacks", "packing"],
      ["Comfortable shoes", "packing"],
      ["Rest breaks planned", "other"],
      ["Hotel check-in note", "document"],
      ["Emergency contacts", "document"],
      ["Shared itinerary link", "other"],
    ],
  },
];
