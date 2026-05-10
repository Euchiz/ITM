# Lightweight Trip Tool — Project Guideline

## 1. Product Definition

This project is a lightweight user-facing trip management tool. It helps travelers organize their own trips, prepare before departure, and follow simple todos during travel.

It is **not** a full travel-agency CRM, booking platform, AI itinerary generator, payment system, or file/document manager.

### Core Positioning

> A lightweight shared trip board for planning itineraries, preparing checklists, and managing daily travel todos.

### Product Slogan

> Plan the days. Prepare the details. Follow today’s checklist.

### Core User Problem

Travelers often have plans scattered across notes, messages, booking emails, map links, and screenshots. This app turns those scattered pieces into one clean, editable, shareable trip object.

The app should help the user answer:

- What is my trip plan?
- What do I need to prepare before leaving?
- What do I need to do today while traveling?
- What is fixed and what is flexible?
- Where are my important booking/file notes?
- How can I share and collaboratively edit the trip with others?

---

## 2. Core Concept: The Trip Object

Everything in the app belongs to a single high-level `Trip` object.

A user can create, organize, share, edit, export, and import multiple trips.

```text
Trip
├── Metadata
├── Members / sharing
├── Days
│   ├── Itinerary items
│   └── Daily travel todos
├── Preparation checklist
├── Notes
└── Import / export schema version
```

The `Trip` object is the main unit of organization, sharing, import, and export.

---

## 3. Product Modes

The app should be organized around three simple modes.

```text
1. Plan Mode      → build the itinerary
2. Prepare Mode   → checklist before the trip
3. Travel Mode    → daily todo/reminder during the trip
```

### 3.1 Plan Mode

Plan Mode is where the user builds the day-by-day itinerary.

Each trip contains days. Each day contains itinerary items.

Example:

```text
Day 1 · Arrival
15:30 Flight arrives
17:00 Hotel check-in
19:00 Dinner near hotel

Day 2 · City walk
09:00 Breakfast
10:30 Museum
13:00 Lunch
15:00 Shopping / café
```

Each itinerary item should support:

- Title
- Type
- Start time
- End time
- Location name
- Map URL
- Notes
- Fixed or flexible marker
- Highlight marker
- Status
- Sort order

### 3.2 Prepare Mode

Prepare Mode is a trip-level checklist for things that must be done before departure.

Examples:

```text
□ Check passport
□ Book hotel
□ Buy train ticket
□ Exchange cash
□ Pack charger
□ Download offline map
□ Save visa screenshot
□ Confirm restaurant reservation
```

Each preparation checklist item should support:

- Text
- Category
- Due date
- Done / not done
- Notes
- Sort order

Since the backend does not support file upload, file-related needs should be represented as text notes.

Example:

```text
File/note needed:
- Passport photo saved in phone album
- Hotel confirmation is in Gmail
- Train ticket PDF is in Downloads
- Visa screenshot is in WeChat
```

### 3.3 Travel Mode

Travel Mode is the simplified daily view used during the trip.

It should answer:

- What is next?
- What is later today?
- What do I need to do today?
- What should I not forget?
- Where do I go?

Example:

```text
Today · Day 3 · Kyoto

Next:
10:30 Fushimi Inari Shrine
Open in Maps

Later:
13:00 Lunch
15:00 Train to Osaka
16:00 Hotel check-in
19:30 Dinner

Today’s Todo:
□ Pick up train ticket
□ Bring umbrella
□ Check out before 11:00
□ Message Airbnb host
□ Save restaurant address

Important Notes:
- Hotel confirmation is in Gmail
- Train QR code is in Photos
- Dinner reservation is under Zac
```

Travel Mode should be especially mobile-friendly.

---

## 4. Main Navigation

### Desktop Navigation

```text
Overview | Itinerary | Prepare | Today | Notes | Import/Export
```

### Mobile Navigation

```text
Today | Plan | Checklist | Notes
```

On mobile, the app should prioritize the active travel experience. The `Today` page should be the first or most prominent tab.

---

## 5. Core Pages

### 5.1 Trips Dashboard

The user should be able to manage multiple trips.

Features:

- Create new trip
- View existing trips
- See trip date range and destination
- Open a trip
- Duplicate trip later if needed
- Delete/archive trip later if needed
- Share trip with others

Example trip card:

```text
Japan Family Trip
May 12–21, 2026
Tokyo → Kyoto → Osaka
Preparation: 12 / 18 done
```

### 5.2 Trip Overview Page

The overview page gives a summary of the trip.

Recommended sections:

- Trip title
- Destination / route
- Date range
- Travelers
- Summary
- Preparation progress
- Current or upcoming day
- Highlights
- Important notes
- Next fixed item

Example:

```text
Japan Family Trip
May 12–21, 2026
Tokyo → Kyoto → Osaka

Progress:
Preparation: 12 / 18 done
Itinerary: 8 days planned
Today: Day 3 · Kyoto

Highlights:
- Fushimi Inari
- Kyoto tea house
- Osaka street food

Needs Attention:
□ Buy train ticket
□ Confirm hotel check-in time
□ Save passport photo
```

### 5.3 Itinerary Page

The itinerary page is the main Plan Mode interface.

Recommended features:

- Day-by-day display
- Add/edit/delete days
- Add/edit/delete itinerary items
- Reorder items within a day
- Mark items as fixed/flexible
- Mark items as highlights
- Add map URL
- Add notes
- Add status

Example itinerary item card:

```text
10:00 AM
Fushimi Inari Shrine
📍 Kyoto · Flexible · Highlight
```

Expanded:

```text
Fushimi Inari Shrine

Time: 10:00 AM – 12:00 PM
Location: Kyoto
Map: Open in Google Maps
Notes: Go early to avoid crowds.
Status: Planned
Fixed: No
Highlight: Yes
```

### 5.4 Prepare Page

The Prepare page contains the before-trip checklist.

Recommended grouping:

- Booking
- Document
- Packing
- Payment
- Transportation
- Health
- Other

Example:

```text
Before You Go

Documents
□ Passport
□ Visa screenshot
□ Hotel confirmation note

Booking
□ Book train ticket
□ Reserve dinner

Packing
□ Charger
□ Medicine
□ Umbrella
```

### 5.5 Today Page

The Today page is the central Travel Mode view.

Recommended sections:

- Today title
- Current city
- Next item
- Full schedule for today
- Daily todo list
- Important notes
- Map links for today’s items

Example:

```text
Today · Day 3 · Kyoto

Next:
10:00 Train to Kyoto Station

Todo:
□ Check out before 11
□ Bring passport
□ Buy water
□ Save hotel address

Schedule:
10:00 Train
13:00 Lunch
15:00 Temple visit
19:00 Dinner
```

### 5.6 Notes Page

The Notes page can remain simple.

Use cases:

- General trip notes
- Food preferences
- Emergency notes
- File location notes
- Budget reminders
- Group preferences
- Travel warnings

Example:

```text
Food preferences:
Eva's parents prefer not too spicy food. Add rest breaks after lunch.

File notes:
Hotel confirmation is in Gmail.
Train QR code is saved in Photos.
```

---

## 6. Item Types and Statuses

### 6.1 Itinerary Item Types

Use a small fixed enum for V1:

```text
activity
food
transport
lodging
shopping
rest
note
```

### 6.2 Itinerary Item Statuses

Use a small fixed enum for V1:

```text
idea
planned
needs_booking
booked
done
cancelled
```

### 6.3 Checklist Categories

Use a small fixed enum for V1:

```text
booking
document
packing
payment
transportation
health
other
```

---

## 7. Important UX Principles

### 7.1 Fixed vs Flexible

The app should clearly distinguish fixed items from flexible items.

Fixed items include:

- Flights
- Train departures
- Hotel check-in/check-out
- Restaurant reservations
- Tickets
- Pre-booked tours

Flexible items include:

- Cafés
- Shopping
- Optional museums
- Viewpoints
- Free exploration
- Backup activities

Example visual language:

```text
🔒 Fixed
☆ Flexible
⭐ Highlight
⚠ Needs action
🎟 Booked
```

### 7.2 Today First During Travel

Before the trip, users may focus on the full itinerary and preparation checklist.

During the trip, users mainly need the Today page.

The Today page should be fast, clean, and mobile-friendly.

### 7.3 Text-Based File Notes Instead of Uploads

Because the backend does not support file uploads, the product should not pretend to be a document manager.

Instead, support text notes such as:

```text
Hotel confirmation: Gmail search “Kyoto Hotel May 12”
Visa screenshot: saved in Photos
Train QR: PDF in Downloads
Passport copy: iCloud Drive folder
```

### 7.4 Lightweight First

Avoid features that require heavy infrastructure.

Do not build in V1:

- AI itinerary generation
- File uploads
- Booking integrations
- Payment tracking
- Complex maps
- Route optimization
- Weather API
- Calendar sync
- Real-time multiplayer editing
- PDF export

---

## 8. Sharing and Collaboration

The app already supports creating trips and sharing/editing with others.

Recommended sharing roles:

```text
owner
editor
viewer
```

### Owner

Can:

- Edit trip
- Delete trip
- Manage members
- Import/replace trip data

### Editor

Can:

- Edit itinerary
- Edit checklists
- Edit notes

### Viewer

Can:

- View trip
- Check todos only if allowed later

For V1, a simple owner/editor/viewer model is enough.

---

## 9. Suggested Database Schema

A normalized schema is recommended if the backend already supports basic tables.

### 9.1 `users`

```text
id
name
email
created_at
updated_at
```

### 9.2 `trips`

```text
id
owner_id
title
destination
start_date
end_date
summary
general_notes
created_at
updated_at
```

### 9.3 `trip_members`

```text
id
trip_id
user_id
role
created_at
updated_at
```

Role enum:

```text
owner
editor
viewer
```

### 9.4 `days`

```text
id
trip_id
date
title
city
notes
sort_order
created_at
updated_at
```

### 9.5 `itinerary_items`

```text
id
trip_id
day_id
title
type
start_time
end_time
location_name
map_url
notes
is_fixed
is_highlight
status
sort_order
created_at
updated_at
```

### 9.6 `checklist_items`

```text
id
trip_id
day_id nullable
text
category
due_date nullable
is_done
notes
sort_order
created_at
updated_at
```

Important design:

- If `day_id` is `null`, the item is a before-trip preparation checklist item.
- If `day_id` is set, the item is a daily travel todo.

### 9.7 `notes` Optional

```text
id
trip_id
day_id nullable
title
body
sort_order
created_at
updated_at
```

The `notes` table can be skipped in early V1 if notes are stored directly in trip/day/item/checklist fields.

---

## 10. Import / Export Philosophy

The app will not include built-in AI features in V1.

Instead, it should support a fixed import/export format so users can:

1. Export a trip.
2. Paste it into an external AI assistant, friend, or planning tool.
3. Ask for changes.
4. Import the result back into the app.
5. Visualize and edit it normally.

This allows the app to be AI-compatible without building AI infrastructure.

### Product Framing

Possible feature names:

```text
AI-Compatible Trip Format
External AI Import/Export
Bring Your Own AI
Trip JSON Import/Export
```

Recommended description:

> Export your trip, edit it with any AI assistant, then import it back into your visual itinerary.

---

## 11. Canonical JSON Export Format

The canonical format should be JSON. JSON is the reliable app import/export format.

### 11.1 Example Trip JSON

```json
{
  "schema_version": "trip_v1",
  "trip": {
    "title": "Japan Family Trip",
    "destination": "Tokyo → Kyoto → Osaka",
    "start_date": "2026-05-12",
    "end_date": "2026-05-21",
    "summary": "A family trip focused on food, temples, city walks, and relaxed exploration.",
    "travelers": ["Zac", "Eva", "Eva's parents"],
    "general_notes": "Keep the pace relaxed. Avoid too many early mornings."
  },
  "days": [
    {
      "date": "2026-05-12",
      "title": "Arrival in Tokyo",
      "city": "Tokyo",
      "notes": "First day should be light because of jet lag.",
      "items": [
        {
          "title": "Arrive at Haneda Airport",
          "type": "transport",
          "start_time": "15:30",
          "end_time": "16:30",
          "location_name": "Haneda Airport",
          "map_url": "",
          "notes": "Pick up luggage and exchange some cash.",
          "is_fixed": true,
          "is_highlight": false,
          "status": "booked"
        },
        {
          "title": "Hotel check-in",
          "type": "lodging",
          "start_time": "18:00",
          "end_time": "",
          "location_name": "Hotel in Shinjuku",
          "map_url": "",
          "notes": "Confirmation is in Gmail. Booking under Zac.",
          "is_fixed": true,
          "is_highlight": false,
          "status": "booked"
        }
      ],
      "todos": [
        {
          "text": "Buy Suica/PASMO card",
          "category": "transportation",
          "is_done": false,
          "notes": ""
        },
        {
          "text": "Save hotel address offline",
          "category": "document",
          "is_done": false,
          "notes": ""
        }
      ]
    }
  ],
  "preparation_checklist": [
    {
      "text": "Check passport validity",
      "category": "document",
      "due_date": "2026-05-01",
      "is_done": false,
      "notes": "Passport photo should also be saved on phone."
    },
    {
      "text": "Book airport transfer",
      "category": "transportation",
      "due_date": "",
      "is_done": false,
      "notes": ""
    }
  ],
  "notes": [
    {
      "title": "Food preferences",
      "body": "Eva's parents prefer not too spicy food. Add rest breaks after lunch."
    }
  ]
}
```

### 11.2 JSON Rules

External editors or AI tools should follow these rules:

- Keep `schema_version` as `trip_v1`.
- Use dates in `YYYY-MM-DD` format.
- Use times in `HH:MM` 24-hour format.
- Use only allowed item types.
- Use only allowed item statuses.
- Use only allowed checklist categories.
- Do not include file uploads.
- Represent file/document needs as text notes.
- Return valid JSON only.

---

## 12. AI-Friendly Markdown Export

The app can also export a readable Markdown version for humans and external AI.

Markdown can be export-only in early V1.

Recommended approach:

- Show a readable trip summary in Markdown.
- Include a machine-readable JSON block at the bottom.
- The app importer only parses the JSON block, not the full Markdown.

### 12.1 Markdown with Embedded JSON

````markdown
# Japan Family Trip

This file is readable by humans and external AI.

You can edit the JSON block below and import it back into the itinerary app.

## Trip Summary

Destination: Tokyo → Kyoto → Osaka  
Dates: 2026-05-12 to 2026-05-21  
Travelers: Zac, Eva, Eva's parents

## Human Notes

Keep the pace relaxed. Avoid too many early mornings.

```trip-json
{
  "schema_version": "trip_v1",
  "trip": {
    "title": "Japan Family Trip",
    "destination": "Tokyo → Kyoto → Osaka",
    "start_date": "2026-05-12",
    "end_date": "2026-05-21"
  },
  "days": [],
  "preparation_checklist": [],
  "notes": []
}
```
````

Importer behavior:

```text
User pastes text
↓
Try JSON.parse directly
↓
If failed, search for ```trip-json block
↓
Extract JSON inside
↓
Parse
↓
Validate schema
↓
Preview
↓
Save to backend
```

---

## 13. External AI Editing Prompt Template

The app should provide a button:

```text
Copy AI Editing Prompt
```

Prompt template:

```text
You are helping me edit a travel itinerary.

Please modify the trip JSON below while preserving the schema exactly.

Rules:
- Keep schema_version as "trip_v1".
- Use dates in YYYY-MM-DD format.
- Use times in HH:MM 24-hour format.
- Only use these item types: activity, food, transport, lodging, shopping, rest, note.
- Only use these item statuses: idea, planned, needs_booking, booked, done, cancelled.
- Only use these checklist categories: booking, document, packing, payment, transportation, health, other.
- Keep checklist items as text-based reminders only.
- Do not add file uploads.
- Represent file/document needs as text notes.
- Do not add comments outside the JSON.
- Return only valid JSON.

Task:
[User writes request here]

Trip JSON:
[Paste exported JSON here]
```

Example user task:

```text
Make Day 2 lighter, add more rest time, and add a preparation checklist for traveling with parents.
```

---

## 14. Import Flow

The app should not immediately overwrite existing data after import.

Recommended import flow:

```text
Import trip text/file
↓
Validate format
↓
Show preview
↓
Choose import mode
    - Create new trip
    - Replace current trip
↓
Confirm
↓
Visualize as editable itinerary
```

For V1, support only:

```text
Create new trip
Replace current trip
```

Avoid merge import in V1 because merging creates many edge cases.

---

## 15. Import Validation

The app should validate external JSON before saving it.

Recommended validation checks:

```text
schema_version exists and equals trip_v1
trip.title exists
trip.start_date and trip.end_date are valid YYYY-MM-DD dates
days is an array
each day has date/title/items/todos
each day date is valid YYYY-MM-DD
each item has title/type/status
each item type is allowed
each item status is allowed
is_fixed is true/false
is_highlight is true/false
preparation_checklist is an array
checklist category is allowed
notes is an array
```

Example validation error message:

```text
Import failed:
- Day 2 item "Kyoto dinner" has invalid status: "confirmed".
  Allowed values: idea, planned, needs_booking, booked, done, cancelled.

- Day 3 has invalid date: "May 14".
  Please use YYYY-MM-DD.
```

Recommended frontend validation library:

```text
Zod
```

---

## 16. Export Flow

Recommended export options:

```text
Export as JSON
Copy JSON
Copy AI Editing Prompt + JSON
Export as Markdown with embedded trip-json block
```

V1 should prioritize:

```text
1. Export current trip as JSON
2. Copy external-AI editing prompt
3. Import JSON
4. Validate JSON
5. Preview imported trip
6. Save as new trip
```

Later versions can add:

```text
7. Export Markdown + embedded JSON
8. Import Markdown by extracting trip-json block
9. Replace current trip
10. Diff preview before replacing
```

---

## 17. Frontend Implementation Notes

The current framework is a static HTML / Vite frontend with a small database backend.

Recommended implementation approach:

### 17.1 Export Modal

Include:

- Copy JSON
- Download `.trip.json`
- Copy AI prompt + JSON
- Download AI Markdown later

### 17.2 Import Modal

Include:

- Paste text area
- Validate button
- Preview parsed trip
- Create new trip button
- Replace current trip button

### 17.3 Parsing Logic

Pseudo-flow:

```text
function parseImportText(input):
    try direct JSON.parse(input)
    if success, validate and return

    search for ```trip-json block
    if found, extract inner text
    try JSON.parse(inner text)
    if success, validate and return

    otherwise show error
```

### 17.4 Data Saving

If using normalized tables:

```text
Trip JSON
↓
Create/update trip row
↓
Create/update day rows
↓
Create/update itinerary item rows
↓
Create/update checklist item rows
↓
Create/update note rows
```

If using a single JSON column:

```text
trips
- id
- owner_id
- title
- trip_json
- created_at
- updated_at
```

A single JSON column is faster to implement, but normalized tables are cleaner long-term.

Recommended compromise:

> Use normalized tables if already available. Keep import/export as one complete canonical `Trip` JSON object.

---

## 18. MVP Scope

### Must-Have V1

```text
Trip dashboard
Create/edit trip
Share/edit trip with others
Day-by-day itinerary
Add/edit/reorder itinerary items
Fixed/flexible marker
Highlight marker
Simple map link field
Preparation checklist
Daily todo checklist
Text notes for needed files/documents
Mobile Today view
Export trip as JSON
Import trip from JSON
Validate import
Preview import before saving
Copy external-AI editing prompt
```

### Nice-to-Have V1.5

```text
Checklist templates
Duplicate trip
Duplicate day
Duplicate itinerary item
Markdown export with embedded trip-json block
Import Markdown by extracting trip-json block
Replace current trip from import
Diff preview before replacing
```

### Avoid in V1

```text
Built-in AI generation
File uploads
Booking API integrations
Payment/invoice system
Complex maps
Route optimization
Weather API
Calendar sync
Real-time multiplayer editing
PDF export
Advanced roles and permissions
```

---

## 19. Checklist Templates

Templates can add immediate value without AI.

### 19.1 Basic Travel Checklist

```text
Passport / ID
Wallet
Phone charger
Power bank
Medicine
Umbrella
Comfortable shoes
Hotel address saved
Emergency contact saved
```

### 19.2 International Trip Checklist

```text
Passport
Visa / entry permit
Travel insurance
SIM card / roaming
Currency exchange
Adapter
Customs declaration
Flight check-in
Hotel confirmation note
```

### 19.3 Road Trip Checklist

```text
Driver's license
Car rental confirmation
Gas plan
Parking notes
Snacks
Water
Offline map
Emergency kit
```

### 19.4 Family Trip Checklist

```text
Passports / IDs for everyone
Medicine
Snacks
Comfortable shoes
Rest breaks planned
Hotel check-in note
Emergency contacts
Shared itinerary link
```

---

## 20. Small Polished Features

These features are lightweight but make the product feel more professional.

### 20.1 Next Item Card

On overview and Today pages:

```text
Next up:
15:00 Hotel check-in
Location: Hilton Kyoto
Note: Reservation under Zac
```

### 20.2 Needs Attention Section

Automatically show incomplete important items:

```text
Needs attention:
□ Buy train ticket
□ Confirm hotel check-in time
□ Save passport photo
```

### 20.3 Day Progress

For each day:

```text
3 / 5 todos done
```

### 20.4 Labels

Recommended labels:

```text
Fixed
Flexible
Booked
Needs action
Important
Optional
Highlight
```

### 20.5 Simple Visual Hierarchy

Use a calm, clean hierarchy:

- Trip title at top
- Days as cards
- Fixed items visually stronger
- Flexible items visually softer
- Todo checkboxes large enough for mobile
- Map links as clear buttons
- Important notes separated from casual notes

---

## 21. Future Direction

Possible future features after the lightweight core works:

```text
Calendar export
PDF export
Weather card
Packing suggestions
Basic map overview
Offline-friendly cached view
Commenting
Activity templates
Public shared trip page
Budget notes
Simple expense split
```

Potential AI-compatible future features without internal AI:

```text
More robust schema migration
Trip JSON diff viewer
Import conflict resolver
External AI prompt library
Schema examples for different trip types
```

Potential internal AI features later, if desired:

```text
Messy notes → trip JSON
Trip conflict detection
Packing suggestions
Checklist expansion
Day plan rebalancing
Itinerary summarization
```

These should not be part of the initial scope.

---

## 22. Final Product Summary

This app should be a lightweight, structured, shareable travel planning companion.

It helps users:

```text
Before trip:
Organize preparation checklist and important notes.

During planning:
Build a clean day-by-day itinerary.

During travel:
Follow today’s schedule and todo list.

With others:
Share and collaboratively edit the same trip.

With external tools:
Export/import a fixed trip format for AI-assisted editing outside the app.
```

The product should stay simple, fast, and useful.

The key principle:

> The app owns the visual trip structure. External AI can help edit the schema, but the app remains the clean dashboard for planning, preparing, and traveling.
