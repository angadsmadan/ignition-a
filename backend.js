// backend.js — data, state, persistence, auth, and business logic
// No DOM manipulation except in auth-flow functions (showLoginScreen, loginAs, etc.).
// Must be loaded after the Supabase CDN script and before the inline script in index.html.

// ── Supabase init ────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://ywkboxhxxldfwdadcjds.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3a2JveGh4eGxkZndkYWRjamRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NzIwMDgsImV4cCI6MjA5NjE0ODAwOH0.BKDHJuVAll4pTjrHj0LjbCdrdVmi3IHn17JXaD3BT_Y";
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const FUNCTIONS = [
  { id: "commercial", name: "Commercial", weight: 25, color: "bg-blue-500", dot: "bg-blue-400" },
  { id: "realestate", name: "Real Estate", weight: 22, color: "bg-red-500", dot: "bg-red-400" },
  { id: "growth", name: "Growth", weight: 21, color: "bg-pink-500", dot: "bg-pink-400" },
  { id: "onsite", name: "On-site", weight: 18, color: "bg-red-500", dot: "bg-red-400" },
  { id: "instock", name: "Instock", weight: 14, color: "bg-cyan-500", dot: "bg-cyan-400" },
  { id: "procurement", name: "Procurement", weight: 11, color: "bg-teal-500", dot: "bg-teal-400" },
  { id: "fulfilment", name: "Fulfilment", weight: 7, color: "bg-green-500", dot: "bg-green-400" },
  { id: "tech", name: "Tech", weight: 7, color: "bg-fuchsia-500", dot: "bg-fuchsia-400" },
  { id: "logistics", name: "Logistics", weight: 5, color: "bg-emerald-500", dot: "bg-emerald-400" },
  { id: "finance", name: "Finance", weight: 5, color: "bg-indigo-500", dot: "bg-indigo-400" },
  { id: "hr", name: "HR", weight: 4, color: "bg-rose-500", dot: "bg-rose-400" },
  { id: "legal", name: "Legal", weight: 4, color: "bg-yellow-500", dot: "bg-yellow-400" },
  { id: "pricing", name: "Pricing", weight: 4, color: "bg-lime-500", dot: "bg-lime-400" },
  { id: "centrallaunch", name: "Central Launch", weight: 3, color: "bg-violet-500", dot: "bg-violet-400" },
  { id: "it", name: "IT", weight: 3, color: "bg-sky-500", dot: "bg-sky-400" },
  { id: "operations", name: "Operations", weight: 3, color: "bg-amber-500", dot: "bg-amber-400" },
  { id: "design", name: "Design", weight: 2, color: "bg-purple-500", dot: "bg-purple-400" },
  { id: "admin", name: "Admin", weight: 1, color: "bg-stone-500", dot: "bg-stone-400" },
];

// LAUNCH_DATE is set to T+90 once Day 0 is called. Pre-Day-0 it stays at a placeholder
// 90 days out so calculations are bounded, but the UI shows "Gate not called" instead.
let LAUNCH_DATE = new Date(); LAUNCH_DATE.setDate(LAUNCH_DATE.getDate() + 90);

// ===== Critical path =====
// Declarative dependency map keyed by task id. Each entry lists upstream tasks
// that must be Complete (or Pending Validation) before this task can start.
// Curated for the ~25 highest-impact tasks on the launch critical path —
// other tasks float independently.
const TASK_DEPENDENCIES = {
  // 200  Market understanding   (root — no deps)
  1:   [200],                            // AOP locked depends on market understanding
  3:   [1, 2],                           // Market launch kick-off needs AOP + P0 hires
  5:   [3],                              // Scout first 3 dark stores depends on kick-off
  6:   [14],                             // DS lease template needs legal entity
  44:  [3],                              // Meet RE dealers
  9:   [5, 6],                           // Get layouts approved (after scout + lease template)
  8:   [9],                              // Agree fit-out vendor contracts
  11:  [8],                              // Engage fit-out vendors
  23:  [11],                             // DS #1 lease & handover
  24:  [11],                             // DS #2 lease & handover
  29:  [11],                             // DS #3 lease & handover
  31:  [11],                             // DS #4 lease & handover
  25:  [23],                             // First SKU delivery to DS#1 needs DS#1 handover
  27:  [24],                             // First SKU delivery to DS#2
  32:  [29],                             // DS#3
  35:  [31],                             // DS#4
  26:  [25],                             // DS #1 operational (beta) needs first delivery
  28:  [27],                             // DS #2 operational
  33:  [32],                             // DS #3 operational
  36:  [35],                             // DS #4 operational
  // Commercial spine
  83:  [3],                              // Vendor onboarding progress
  91:  [83, 64],                         // First POs need vendor closure + ATS
  // Pricing
  158: [81],                             // SRP engine depends on competitor scrape
  // Growth + onsite
  102: [1],                              // Campaign calendar needs AOP
};
function dependenciesOf(taskId) { return TASK_DEPENDENCIES[taskId] || []; }
function isTaskBlocked(taskId) {
  const deps = dependenciesOf(taskId);
  if (!deps.length) return null;
  const incomplete = deps.filter(d => {
    const t = TASKS.find(x => x.id === d);
    return t && t.status !== "Complete";
  });
  return incomplete.length ? incomplete : null;
}

// ===== Launch state =====
// 'pre_day0' = Day 0 gate not yet called; main app is blocked behind the gate.
// 'active'   = Day 0 was triggered on day0CalledAt; full task manager available.
let LAUNCH_STATE = "pre_day0";
let DAY0_CALLED_AT = null;        // ISO timestamp of when Day 0 was called
let DAY0_VALUES = {};             // user inputs on the gate scorecard (id -> true/false)

// Only the CBO/owner can reset Day 0 back to the gate.
// Super admin: locked to these 4 IDs — role switcher cannot grant this
const SUPER_ADMIN_IDS = ["sid", "asmadan", "ali", "master"];
function isSuperAdmin(userId) { return SUPER_ADMIN_IDS.includes(userId !== undefined ? userId : CURRENT_USER_ID); }
function isOwner() { return isSuperAdmin(CURRENT_USER_ID); }

// Launch Control = Super Admin + Group CBO (can switch roles, see market overview on dashboard, access Manage Access)
const LAUNCH_CONTROL_ROLES_SET = ["Super Admin", "Group CBO", "Master Admin"];
function isLaunchControl(userId) {
  const uid = userId !== undefined ? userId : CURRENT_USER_ID;
  if (isSuperAdmin(uid)) return true;
  const u = USER_REGISTRY ? USER_REGISTRY.find(x => x.id === uid) : null;
  return u && LAUNCH_CONTROL_ROLES_SET.includes(u.role);
}

// ===== Scorecards =====
// A scorecard is a structured form embedded inside a task modal (or rendered
// standalone on the Day-0 gate). Each field contributes equally toward 100%;
// when all fields are filled the task auto-flips to "Pending Validation".
// Field types: text · textarea · number · boolean (yes/no toggle).
const SCORECARDS = {
  "day0_gate": {
    title: "Day 0 Readiness Gate",
    subtitle: "Before the launch task manager opens, confirm every box below. Day 0 is not a date — it is a decision backed by readiness.",
    groups: [
      { title: "Core leadership in place", fields: [
        { id: "gm_joined",          label: "GM joined",                          type: "boolean_email", emailFor: "gm",           emailPlaceholder: "gm@noon.com" },
        { id: "commercial_joined",  label: "Head of Commercial joined",          type: "boolean_email", emailFor: "commercial",   emailPlaceholder: "commercial@noon.com" },
        { id: "realestate_joined",  label: "Head of Real Estate joined",         type: "boolean_email", emailFor: "realestate",   emailPlaceholder: "realestate@noon.com" },
        { id: "fulfilment_joined",  label: "Head of Fulfilment joined",          type: "boolean_email", emailFor: "fulfilment",   emailPlaceholder: "fulfilment@noon.com" },
      ]},
      { title: "Market validated on the ground", fields: [
        { id: "market_visit",       label: "Market visit completed",             type: "boolean" },
        { id: "demand_validated",   label: "Demand clusters validated",          type: "boolean" },
        { id: "supply_mapped",      label: "Supply ecosystem mapped",            type: "boolean" },
        { id: "logistics_confirmed",label: "Logistics feasibility confirmed",    type: "boolean" },
      ]},
      { title: "Plan signed off", fields: [
        { id: "aop_signed",         label: "AOP signed off",                     type: "boolean" },
        { id: "rollout_plan",       label: "Store rollout plan defined",         type: "boolean" },
      ]},
    ],
  },
  "market_understanding": {
    title: "Market understanding",
    subtitle: "Quantified pre-launch view. Source every number — no assumptions.",
    groups: [
      { title: "Competition", fields: [
        { id: "competitors",       label: "Main competitors (in priority order)",    type: "text",     placeholder: "Talabat, Breadfast, Rabbit" },
        { id: "comp1_ops",         label: "Competitor #1 — orders / store / day",    type: "number",   placeholder: "180",        suffix: "orders/day" },
        { id: "comp2_ops",         label: "Competitor #2 — orders / store / day",    type: "number",   placeholder: "120",        suffix: "orders/day" },
        { id: "comp_avg_aov",      label: "Competitor avg AOV",                      type: "number",   placeholder: "220",        prefix: "EGP" },
        { id: "comp_avg_eta",      label: "Competition avg delivery ETA",            type: "number",   placeholder: "22",         suffix: "mins" },
      ]},
      { title: "Our targets", fields: [
        { id: "target_aov",        label: "Target AOV",                              type: "number",   placeholder: "240",        prefix: "EGP" },
        { id: "target_opd_90",     label: "Target OPD at Day 90",                    type: "number",   placeholder: "8000",       suffix: "orders/day" },
        { id: "target_stores",     label: "Number of stores",                        type: "number",   placeholder: "12",         suffix: "stores" },
      ]},
    ],
  },
};

// =============================================================================
// TASK CONSOLIDATION LOG  (2026-04-28)
// Tasks below have been consolidated. Archived rows remain in TASKS for audit
// trail (with `archived: true`) and are filtered out of all UI views via
// `activeTasks()`.
//
//   #81  Scrape all competitors in market           ← absorbs #4, #98, #156
//   #83  Vendor onboarding progress                 ← absorbs #84, #86, #87, #88, #89
//   #117 Tech dashboards live                       ← absorbs #119, #120, #121
//   #63  Coupon offers - construct + setup          ← absorbs #144
//   #146 Delivery fees - construct + setup          ← absorbs #147
//   #68  Internet activated + speed threshold       ← absorbs #69
//   #106 Uniform/Helmets/Boxes - sourced + 1st patch ← absorbs #107
//
// Re-split (2026-04-29): per-store dark-store tasks restored as individual rows
// because operational/handover/delivery for each of the 5 stores happens at
// distinct dates and is tracked separately:
//   Handover taken: #23 #24 #29 #31 #34 (T-18 / T-14 / T-3 / T-1 / T+11) → DS - Real Estate > Closure
//   First SKU delivery: #25 #27 #32 #35 #37 (T-13 / T-10 / T+6 / T+11 / T+16) → Dark Store > Launch readiness checklist
//   Operational: #26 #28 #33 #36 #79 (T-0 beta / T+5 / T+5 / T+15 / T+20) → Dark Store > Launch readiness checklist
//   #71 stays archived (it was a true duplicate of the per-store handovers).
//
// Data fixes:
//   #97  T-46121 typo → T-45 (confirmed)
//   #70  TBD → T-30 (confirmed)
//   #82  T-11 → T-45 (lead-list must precede T-40 vendor reach-out)
// =============================================================================
let TASKS = [
  { id: 200, function: "Growth", workstream: "Market Understanding", task: "Market understanding scorecard", desc: "Before anything else: build a quantified view of the market. Fill in the scorecard with competitor data, demand assumptions and target metrics. 100% complete = ready to brief central strategy and trigger AOP.", owner: "Head of Growth", deadline: "T-90", proof: "Scorecard 100% complete", validation: "All scorecard fields filled with sourced numbers; Head of Growth sign-off captured.", priority: "High", weight: 4, status: "Not Started", parent_id: 1, scorecardId: "market_understanding" },
  { id: 1, function: "Central Launch", workstream: "Central Launch", task: "AOP", desc: "Have an AOP readied for the function", owner: "Central Strategy", deadline: "T-65", proof: "CSV Upload", validation: "CSV must include CAPEX, Count of Stores, GMV, AOV & OPD Projections", priority: "High", weight: 4, status: "Not Started", parent_id: 1 },
  { id: 2, function: "HR", workstream: "HR", task: "P0 Hiring", desc: "Hiring of GM, Commercial, Fulfilment, Real Estate closed", owner: "Talent Acquisition Manager", deadline: "T-65", proof: "CSV upload", validation: "GM, Commercial Head, Real Estate Head and Fulfilment Head are hired with joining dates confirmed", priority: "High", weight: 4, status: "Not Started", parent_id: 2 },
  { id: 3, function: "Central Launch", workstream: "Central Launch", task: "Market launch kick off", desc: "Kick off email with clear launch timelines and AOP shared with the central team", owner: "Central Launch", deadline: "T-65", proof: "AOP CSV/XLSX uploaded", validation: "AOP includes OPD, GMV/NMV, dark stores, CAPEX/OPEX, PC1 and cost assumptions", priority: "High", weight: 4, status: "Not Started", parent_id: 1 },
  { id: 4, function: "Central Launch", workstream: "Central Launch", task: "Competition scraping", desc: "ARCHIVED — consolidated into task #81 'Scrape all competitors in the market'.", owner: "Central pricing team", deadline: "T-60", proof: "CSV Upload", validation: "Superseded by #81", priority: "High", weight: 3, status: "Not Started", parent_id: 7, archived: true },
  { id: 5, function: "Real Estate", workstream: "Dark Store Readiness", task: "Scout first three dark stores", desc: "Scout the market for densely populated areas in priority areas and meet brokers for specs of location required", owner: "Real Estate Manager", deadline: "T-50", proof: "CSV upload", validation: "A CSV containing critical areas and options: must include - lat-long, area name, size of stores, photos of stores", priority: "Low", weight: 1, status: "Not Started", parent_id: 10 },
  { id: 6, function: "Real Estate", workstream: "Dark Store Readiness", task: "Lease agreement template", desc: "Share a template of rent agreements with legal team (from the broker)", owner: "Real Estate Manager", deadline: "T-49", proof: "PDF Upload", validation: "PDF must contain a sample of agreement", priority: "High", weight: 3, status: "Not Started", parent_id: 8 },
  { id: 7, function: "Logistics", workstream: "Logistics Readiness", task: "Create last mile polygons", desc: "Each polygon is to be created factoring in the delivery promise; Share file link", owner: "GM", deadline: "T-48", proof: "KML File link", validation: "KML file with polygons", priority: "High", weight: 4, status: "Not Started", parent_id: 6 },
  { id: 8, function: "Real Estate", workstream: "Dark Store Readiness", task: "Agree contracts with vendors for infrastructure", desc: "Figure out vendors for fit-outs, shelving and cold rooms - put them in touch with procurement", owner: "Real Estate Manager", deadline: "T-45", proof: "CSV sheet upload", validation: "Sheet must include vendors, status of RFQ for procurement - which store is each vendor working at", priority: "High", weight: 3, status: "Not Started", parent_id: 9 },
  { id: 9, function: "Real Estate", workstream: "Dark Store Readiness", task: "Get layouts approved", desc: "Each store layout is to be approved by the Noon team", owner: "Real Estate Manager", deadline: "T-43", proof: "PDF Upload", validation: "PDF includes the approval for the layout", priority: "High", weight: 3, status: "Not Started", parent_id: 9 },
  { id: 10, function: "Real Estate", workstream: "Dark Store Readiness", task: "Rent payments & Store takeover", desc: "Sign the leases and give the first payment - have cheques ready - get the keys", owner: "Real Estate Manager", deadline: "T-40", proof: "PDF upload", validation: "Bank/payment confirmation or finance approval", priority: "High", weight: 3, status: "Not Started", parent_id: 8 },
  { id: 11, function: "Real Estate", workstream: "Dark Store Readiness", task: "Account for fitout completion dates and engage vendors", desc: "Engage the fitout vendors to start the work and target 3 weeks for completion", owner: "Real Estate Manager", deadline: "T-40", proof: "JPG/ JPEG upload", validation: "Upload images of work being done at the stores", priority: "Medium", weight: 2, status: "Not Started", parent_id: 9 },
  { id: 12, function: "HR", workstream: "HR", task: "Hire Logistics & Fulfilment team", desc: "Hire the teams to supervise warehouses and stores along with logistics managers", owner: "HR", deadline: "T-40", proof: "CSV upload", validation: "All detailed roles hired", priority: "Medium", weight: 2, status: "Not Started", parent_id: 40 },
  { id: 13, function: "Logistics", workstream: "Logistics Readiness", task: "Onboard rider supply vendors", desc: "Sign commercial agreements with rider supply vendors covering rate cards, SLAs and onboarding plan", owner: "Logistics Manager", deadline: "T-34", proof: "CSV upload + signed agreements PDF", validation: "CSV lists each vendor with status (onboarded / contracted / signed), rate card and rider commitment; signed agreements attached", priority: "High", weight: 3, status: "Not Started", parent_id: 38 },
  { id: 14, function: "Legal", workstream: "Legal Entity registration", task: "Engage local law firm for entity registration & trade license", desc: "Local law firm appointed with signed engagement letter; scope covers entity registration and trade license filings", owner: "GM", deadline: "T-50", proof: "Signed engagement letter PDF", validation: "Engagement letter is signed by both parties and lists entity registration + trade license in scope", priority: "High", weight: 4, status: "Not Started", parent_id: 3 },
  { id: 15, function: "Finance", workstream: "Legal Entity registration", task: "VAT registration (or formal exemption) completed", desc: "Complete VAT registration with the local tax authority, or obtain formal written confirmation of exemption from finance", owner: "GM", deadline: "T-50", proof: "VAT certificate PDF, or signed exemption memo from finance", validation: "VAT registration certificate is issued and uploaded; or finance has signed off in writing that registration is not required", priority: "High", weight: 4, status: "Not Started", parent_id: 4 },
  { id: 16, function: "Finance", workstream: "Legal Entity registration", task: "Visit a bank (or as suggested by finance ) to open a company bank account", desc: "Complete this task as part of Legal Entity registration.", owner: "GM", deadline: "T-49", proof: "Registration/license PDF or approval email", validation: "Entity/legal approval is complete and launch-critical licenses are available", priority: "High", weight: 4, status: "Not Started", parent_id: 5 },
  { id: 17, function: "On-site", workstream: "Commercial Readiness", task: "Homepage asset inputs", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-14", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "Medium", weight: 2, status: "Not Started", parent_id: 32 },
  { id: 18, function: "On-site", workstream: "On-site Readiness", task: "Brand visibility package", desc: "Complete this task as part of On-site Readiness.", owner: "Onsite", deadline: "T-22", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Low", weight: 1, status: "Not Started", parent_id: 36 },
  { id: 19, function: "Design", workstream: "On-site Readiness", task: "Merchandising assets & creatives - Hero banners, other banners", desc: "Complete this task as part of On-site Readiness.", owner: "Design", deadline: "T-10", proof: "Asset files + live screenshot", validation: "Hero and other banner asset files are delivered and approved; live preview screenshot from on-site team attached", priority: "Medium", weight: 2, status: "Not Started", parent_id: 36 },
  { id: 20, function: "On-site", workstream: "Commercial Readiness", task: "Best items/ SKUs to show on home page", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-10", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 32 },
  { id: 21, function: "On-site", workstream: "Commercial Readiness", task: "Deals input to be pushed in top deals & in deal zone", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-10", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Medium", weight: 2, status: "Not Started", parent_id: 32 },
  { id: 22, function: "Real Estate", workstream: "Dark Store Readiness", task: "Rider, picker and store handover alignment confirmed", desc: "Written alignment from logistics + fulfilment confirming rider/picker readiness against the store handover dates", owner: "GM", deadline: "T-30", proof: "Signed-off alignment doc / mail trail PDF", validation: "Doc lists each store with handover date, confirmed picker count and rider count, and is signed off by logistics + fulfilment heads", priority: "High", weight: 3, status: "Not Started", parent_id: 19 },
  { id: 23, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #1 lease signed & handover taken", desc: "Lease for DS #1 signed and store handed over to fulfilment to begin inbounding.", owner: "Real Estate", deadline: "T-18", proof: "Dark store checklist + audit sign-off + photos", validation: "Critical dark store checklist is 100% complete and audit is passed where required", priority: "High", weight: 3, status: "Not Started", parent_id: 19 },
  { id: 24, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #2 lease signed & handover taken", desc: "Lease for DS #2 signed and store handed over to fulfilment.", owner: "Real Estate", deadline: "T-14", proof: "Dark store checklist + audit sign-off + photos", validation: "Critical dark store checklist is 100% complete and audit is passed where required", priority: "High", weight: 3, status: "Not Started", parent_id: 20 },
  { id: 25, function: "Instock", workstream: "Dark Store Readiness", task: "Ensure first delivery of SKUs to DS #1", desc: "First inbound delivery of SKUs to DS #1.", owner: "In-stock", deadline: "T-13", proof: "CSV upload (availability + SKU count + qty inbounded)", validation: "CSV shows current availability and SKU count and quantity inbounded", priority: "High", weight: 3, status: "Not Started", parent_id: 19 },
  { id: 26, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #1 operational (Beta / employee-only launch)", desc: "DS #1 goes live as a beta / employee-only launch.", owner: "GM", deadline: "T-0", proof: "JPG/MOV upload", validation: "Images and videos show the app live in the market", priority: "High", weight: 3, status: "Not Started", parent_id: 19 },
  { id: 27, function: "Fulfilment", workstream: "Dark Store Readiness", task: "Ensure first delivery of SKUs to DS #2", desc: "First inbound delivery of SKUs to DS #2.", owner: "Fulfilment", deadline: "T-10", proof: "CSV upload", validation: "CSV shows current availability and SKU count and quantity inbounded", priority: "High", weight: 3, status: "Not Started", parent_id: 20 },
  { id: 28, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #2 operational", desc: "DS #2 goes live to customers.", owner: "GM", deadline: "T+5", proof: "JPG/MOV upload", validation: "Images and videos show the app live in the market", priority: "High", weight: 3, status: "Not Started", parent_id: 20 },
  { id: 29, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #3 lease signed & handover taken", desc: "Lease for DS #3 signed and store handed over to fulfilment.", owner: "Real Estate", deadline: "T-3", proof: "Dark store checklist + audit sign-off + photos", validation: "Critical dark store checklist is 100% complete and audit is passed where required", priority: "High", weight: 3, status: "Not Started", parent_id: 21 },
  { id: 30, function: "Real Estate", workstream: "Dark Store Readiness", task: "CCTV installation for Dark Stores", desc: "Complete this task as part of Dark Store Readiness.", owner: "Real Estate", deadline: "T-20", proof: "JPG/MOV upload", validation: "Images should contain installed CCTVs", priority: "Medium", weight: 2, status: "Not Started", parent_id: 10 },
  { id: 31, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #4 lease signed & handover taken", desc: "Lease for DS #4 signed and store handed over to fulfilment.", owner: "Real Estate", deadline: "T-1", proof: "Dark store checklist + audit sign-off + photos", validation: "Critical dark store checklist is 100% complete and audit is passed where required", priority: "High", weight: 3, status: "Not Started", parent_id: 22 },
  { id: 32, function: "Fulfilment", workstream: "Dark Store Readiness", task: "Ensure first delivery of SKUs to DS #3", desc: "First inbound delivery of SKUs to DS #3.", owner: "Fulfilment", deadline: "T+6", proof: "CSV upload", validation: "CSV shows current availability and SKU count and quantity inbounded", priority: "High", weight: 3, status: "Not Started", parent_id: 21 },
  { id: 33, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #3 operational", desc: "DS #3 goes live to customers.", owner: "GM", deadline: "T+5", proof: "JPG/MOV upload", validation: "Images and videos show the app live in the market", priority: "High", weight: 3, status: "Not Started", parent_id: 21 },
  { id: 34, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #5 lease signed & handover taken", desc: "Lease for DS #5 signed and store handed over to fulfilment.", owner: "Real Estate", deadline: "T+11", proof: "Dark store checklist + audit sign-off + photos", validation: "Critical dark store checklist is 100% complete and audit is passed where required", priority: "High", weight: 3, status: "Not Started", parent_id: 19 },
  { id: 35, function: "Fulfilment", workstream: "Dark Store Readiness", task: "Ensure first delivery of SKUs to DS #4", desc: "First inbound delivery of SKUs to DS #4.", owner: "Fulfilment", deadline: "T+11", proof: "CSV upload", validation: "CSV shows current availability and SKU count and quantity inbounded", priority: "High", weight: 3, status: "Not Started", parent_id: 22 },
  { id: 36, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #4 operational", desc: "DS #4 goes live to customers.", owner: "GM", deadline: "T+15", proof: "JPG/MOV upload", validation: "Images and videos show the app live in the market", priority: "High", weight: 3, status: "Not Started", parent_id: 22 },
  { id: 37, function: "Fulfilment", workstream: "Dark Store Readiness", task: "Ensure first delivery of SKUs to DS #5", desc: "First inbound delivery of SKUs to DS #5.", owner: "Fulfilment", deadline: "T+16", proof: "CSV upload", validation: "CSV shows current availability and SKU count and quantity inbounded", priority: "High", weight: 3, status: "Not Started", parent_id: 22 },
  { id: 38, function: "Finance", workstream: "Finance Readiness", task: "Get Bank MID for prepaid settlement", desc: "Complete this task as part of Legal Entity registration.", owner: "Finance", deadline: "T+24", proof: "Bank/payment confirmation or finance approval", validation: "Finance confirms account/payment setup is complete and usable", priority: "Low", weight: 1, status: "Not Started", parent_id: 5 },
  { id: 39, function: "Logistics", workstream: "Logistics Readiness", task: "Get a vendor for COD collection", desc: "Cash on delivery recovery agent needs to be contracted", owner: "Finance", deadline: "T-5", proof: "PDF upload", validation: "Mail trail with confirmation from finance on COD functionality being live", priority: "Medium", weight: 2, status: "Not Started", parent_id: 38 },
  { id: 40, function: "Commercial", workstream: "Commercial Readiness", task: "Market insights (What works well, local nuances, competition data)", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-40", proof: "PDF Upload", validation: "Confirmation from central pricing that Price/mapping data is uploaded and KVIs are competitive within approved PC1 thresholds", priority: "Low", weight: 1, status: "Not Started", parent_id: 23 },
  { id: 41, function: "Commercial", workstream: "Commercial Readiness", task: "Master vendor list", desc: "Have the complete Master Vendor list ready", owner: "Commercial", deadline: "T-40", proof: "CSV upload", validation: "CSV to contain vendors, their SKUs and categories of the SKUs", priority: "Low", weight: 1, status: "Not Started", parent_id: 24 },
  { id: 42, function: "Commercial", workstream: "Commercial Readiness", task: "Category Taxonomy view tile", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-22", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 23 },
  { id: 43, function: "Commercial", workstream: "Commercial Readiness", task: "Taxonomy ZSKU input- Phase 1", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-17", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 23 },
  { id: 44, function: "Real Estate", workstream: "Dark Store Readiness", task: "Meet property/real estate dealers to secure the best sites", desc: "Complete this task as part of Dark Store Readiness.", owner: "Real Estate Manager", deadline: "T-49", proof: "PDF Upload", validation: "PDF must contain photos of the site along with layout", priority: "Low", weight: 1, status: "Not Started", parent_id: 10 },
  { id: 45, function: "On-site", workstream: "Commercial Readiness", task: "Taxonomy ZSKU input- Phase 2", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-15", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 23 },
  { id: 46, function: "Commercial", workstream: "Commercial Readiness", task: "Input for category taxonomy", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-14", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 23 },
  { id: 47, function: "Procurement", workstream: "Dark Store Readiness", task: "Build fit-out / shelving / cold-room vendor pipeline", desc: "Build a sourced pipeline of fit-out, shelving and cold-room vendors with RFQs issued via Procol", owner: "GM", deadline: "T-47", proof: "CSV upload", validation: "CSV contains vendor name, scope, RFQ status, quoted price and shortlist decision per dark store", priority: "Medium", weight: 2, status: "Not Started", parent_id: 9 },
  { id: 48, function: "On-site", workstream: "On-site Readiness", task: "Home page Wireframe", desc: "Complete this task as part of On-site Readiness.", owner: "Onsite", deadline: "T-22", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Medium", weight: 2, status: "Not Started", parent_id: 32 },
  { id: 49, function: "Procurement", workstream: "Dark Store Readiness", task: "Dark stores shown to vendors and they have begun the layout", desc: "Complete this task as part of Dark Store Readiness.", owner: "GM", deadline: "T-41", proof: "PDF Upload", validation: "PDF should contain the dark store images, location + layout of each store", priority: "Medium", weight: 2, status: "Not Started", parent_id: 9 },
  { id: 50, function: "On-site", workstream: "On-site Readiness", task: "Presearch page & Deal zone wireframe", desc: "Complete this task as part of On-site Readiness.", owner: "Onsite", deadline: "T-14", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Medium", weight: 2, status: "Not Started", parent_id: 32 },
  { id: 51, function: "On-site", workstream: "Commercial Readiness", task: "Middle button input and calendar", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-14", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Medium", weight: 2, status: "Not Started", parent_id: 32 },
  { id: 52, function: "On-site", workstream: "Commercial Readiness", task: "Inputs for other pages- Presearch, Deal Zone, middle button", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-14", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Medium", weight: 2, status: "Not Started", parent_id: 32 },
  { id: 53, function: "Commercial", workstream: "Commercial Readiness", task: "Category x Big local Brands input", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-22", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Low", weight: 1, status: "Not Started", parent_id: 23 },
  { id: 54, function: "On-site", workstream: "Commercial Readiness", task: "Brand driven banners & offers", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-14", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "Medium", weight: 2, status: "Not Started", parent_id: 32 },
  { id: 55, function: "On-site", workstream: "On-site Readiness", task: "Noon core Takeover assets inputs", desc: "Complete this task as part of On-site Readiness.", owner: "Onsite", deadline: "T-15", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "Medium", weight: 2, status: "Not Started", parent_id: 36 },
  { id: 56, function: "On-site", workstream: "On-site Readiness", task: "Noon core x other collaboration touchpoints", desc: "Complete this task as part of On-site Readiness.", owner: "Onsite", deadline: "T-14", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Medium", weight: 2, status: "Not Started", parent_id: 36 },
  { id: 57, function: "On-site", workstream: "On-site Readiness", task: "CRM set-up", desc: "Complete this task as part of On-site Readiness.", owner: "Onsite", deadline: "T-14", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Medium", weight: 2, status: "Not Started", parent_id: 32 },
  { id: 58, function: "Design", workstream: "On-site Readiness", task: "Off-app assets- DM, flyers", desc: "Complete this task as part of On-Site Readiness.", owner: "Design", deadline: "T-10", proof: "Asset files + print-ready PDF", validation: "Final DM and flyer files delivered in print-ready format and approved by brand", priority: "Medium", weight: 2, status: "Not Started", parent_id: 36 },
  { id: 59, function: "Real Estate", workstream: "Warehouse Readiness", task: "Warehouse shortlist with specs", desc: "Deliver a shortlist of warehouse options with specs (size, lat-long, rent, condition, photos) for sign-off", owner: "Real Estate", deadline: "T-40", proof: "CSV upload + photos", validation: "CSV lists at least 3 options with lat-long, area, size sqm, rent, photos and recommendation; finance & ops sign off", priority: "Medium", weight: 2, status: "Not Started", parent_id: 16 },
  { id: 60, function: "Procurement", workstream: "Warehouse Readiness", task: "Linehaul, pickers, pallets - requirement email to be sent to fulfilment and procurement", desc: "Complete this task as part of Warehouse Readiness.", owner: "Fulfilment", deadline: "T-11", proof: "Vendor closure, roster, or SLA readiness tracker", validation: "Rider/picker supply is closed, trained, and aligned to store OPD/SLA requirements", priority: "High", weight: 3, status: "Not Started", parent_id: 17 },
  { id: 61, function: "IT", workstream: "Warehouse Readiness", task: "Initiate a mail on IT Assets - these are different for a warehouse and a BOQ vendor needs to be aligned", desc: "Complete this task for Warehouse Readiness", owner: "Fulfilment", deadline: "T-20", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Priority vendors are onboarded, contracted, and commercial terms are captured in system", priority: "Medium", weight: 2, status: "Not Started", parent_id: 11 },
  { id: 62, function: "Fulfilment", workstream: "Warehouse Readiness", task: "Chilled warehouse shortlist with specs", desc: "Deliver a shortlist of chilled warehouse options with specs (size, lat-long, rent, cold-chain capability, photos) for sign-off", owner: "Fulfilment", deadline: "T-10", proof: "CSV upload + photos", validation: "CSV lists at least 2 options with lat-long, area, size sqm, rent, cold-chain spec, photos and recommendation; finance & ops sign off", priority: "Medium", weight: 2, status: "Not Started", parent_id: 16 },
  { id: 63, function: "Growth", workstream: "Growth Readiness", task: "Coupon offers - construct + setup (NU / RU / Dormant)", desc: "Single task covering coupon offer construct (New User, Returning User, Dormant) and system setup. Doc defines the constructs and caps; configuration in the system matches the doc.", owner: "Growth", deadline: "T-16", proof: "Coupon construct doc + setup screenshot", validation: "Doc defines NU/RU/Dormant coupon constructs with caps; setup screenshot shows configuration matches doc", priority: "Medium", weight: 2, status: "Not Started", parent_id: 31 },
  { id: 64, function: "Instock", workstream: "Instock Readiness", task: "In-stock availability dashboard live + ATS configured", desc: "Real-time in-stock availability dashboard is live and the Automated Transfer System (ATS) is configured for prioritised SKUs", owner: "In-stock", deadline: "T-11", proof: "Live dashboard link + ATS config screenshot", validation: "Dashboard link is live and shows availability per SKU per store; ATS rules are configured and screenshot attached", priority: "Medium", weight: 2, status: "Not Started", parent_id: 31 },
  { id: 65, function: "Procurement", workstream: "Warehouse Readiness", task: "Finalizing RFQs for all WH + DS assets", desc: "Complete this task as part of Warehouse Readiness.", owner: "Fulfilment", deadline: "T-13", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "Medium", weight: 2, status: "Not Started", parent_id: 18 },
  { id: 66, function: "Fulfilment", workstream: "Warehouse Readiness", task: "Receiving WH + DS assets", desc: "Complete this task as part of Warehouse Readiness.", owner: "Fulfilment", deadline: "T-8", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "Medium", weight: 2, status: "Not Started", parent_id: 18 },
  { id: 67, function: "Tech", workstream: "Warehouse Readiness", task: "IT assets delivered", desc: "Complete this task as part of Warehouse Readiness.", owner: "GM", deadline: "T-9", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "Medium", weight: 2, status: "Not Started", parent_id: 11 },
  { id: 68, function: "IT", workstream: "Warehouse Readiness", task: "Internet activated + meeting required speed threshold", desc: "Single task covering both initial activation (T-10) and any speed enhancement needed to meet required threshold (T-7).", owner: "IT", deadline: "T-10", proof: "Activation confirmation + on-site speed test screenshot above threshold", validation: "Provider activated and on-site speed test meets threshold; if upgrade required, evidence of post-upgrade test attached", priority: "Medium", weight: 2, status: "Not Started", parent_id: 11 },
  { id: 69, function: "IT", workstream: "Warehouse Readiness", task: "Internet Speed enhanced", desc: "ARCHIVED — merged into task #68 'Internet activated + meeting required speed threshold'.", owner: "IT", deadline: "T-7", proof: "Updated tracker link or evidence screenshot", validation: "Superseded by #68", priority: "Medium", weight: 2, status: "Not Started", parent_id: 11, archived: true },
  { id: 70, function: "Instock", workstream: "Warehouse Readiness", task: "Forecasting on quantities of prioritised SKUs for inbounding based on manpower in warehouse", desc: "Complete this task as part of Warehouse Readiness.", owner: "In-Stock", deadline: "T-30", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 18 },
  { id: 71, function: "Real Estate", workstream: "Dark Store Readiness", task: "Handover the completed store to fulfiment team to start inbounding", desc: "ARCHIVED — duplicate of per-store handovers; rolled into task #23 'Store handovers to fulfilment'.", owner: "Real Estate", deadline: "T-9", proof: "Dark store checklist, photos, or audit proof", validation: "Superseded by #23", priority: "High", weight: 3, status: "Not Started", parent_id: 19, archived: true },
  { id: 72, function: "Fulfilment", workstream: "Warehouse Readiness", task: "Inbounding of SKUs to begin - coordinated with commercial and in-stock on priority SKU and quantities based on manpower", desc: "Complete this task as part of Warehouse Readiness.", owner: "Facility", deadline: "T-7", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 18 },
  { id: 73, function: "Procurement", workstream: "Warehouse Readiness", task: "Hiring pickers, TLs and Sups for WH + DS", desc: "Complete this task as part of Warehouse Readiness.", owner: "Fulfilment", deadline: "T-8", proof: "Vendor closure, roster, or SLA readiness tracker", validation: "Rider/picker supply is closed, trained, and aligned to store OPD/SLA requirements", priority: "High", weight: 3, status: "Not Started", parent_id: 18 },
  { id: 74, function: "Pricing", workstream: "Pricing & Competition", task: "Get dashboard populated for tracking pricing on competition and flagging difference in pricing", desc: "Complete this task as part of Pricing & Competition.", owner: "Pricing", deadline: "T-13", proof: "Live dashboard link + screenshot", validation: "Pricing dashboard link is live and shows competitor pricing with delta flags vs our SRP", priority: "Medium", weight: 2, status: "Not Started", parent_id: 7 },
  { id: 75, function: "Finance", workstream: "Finance Readiness", task: "Get dashboard for overall PnL", desc: "Complete this task as part of Instock Readiness.", owner: "GM", deadline: "T-11", proof: "Live dashboard link + PnL CSV", validation: "PnL dashboard link is live and CSV with line items (Revenue, COGS, OPEX, PC1, PC2) is uploaded", priority: "Medium", weight: 2, status: "Not Started", parent_id: 49 },
  { id: 76, function: "Growth", workstream: "Growth Readiness", task: "Activate coupons on Beta launch for testing", desc: "Complete this task as part of Instock Readiness.", owner: "Growth", deadline: "T-3", proof: "Coupon config screenshot + test order screenshot", validation: "Coupons are configured in the system and a successful test order applying the coupon is captured", priority: "High", weight: 3, status: "Not Started", parent_id: 31 },
  { id: 77, function: "Legal", workstream: "Legal Entity registration", task: "Share a template of rent agreements with legal team (from the broker)", desc: "Complete this task as part of Legal Entity registration.", owner: "GM", deadline: "T-45", proof: "Signed agreement PDF", validation: "Lease agreement is signed by both parties with payment confirmation attached", priority: "Low", weight: 1, status: "Not Started", parent_id: 8 },
  { id: 78, function: "HR", workstream: "HR", task: "Mapping the head count vs open roles", desc: "Ensure we have the desired structure of the team mapped to the current headcount on a sheet", owner: "GM", deadline: "T-11", proof: "CSV Upload", validation: "CSV should contain: Open Roles, Offers rolled out, Hired already", priority: "Medium", weight: 2, status: "Not Started", parent_id: 39 },
  { id: 79, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #5 operational", desc: "DS #5 goes live to customers.", owner: "GM", deadline: "T+20", proof: "JPG/MOV upload", validation: "Images and videos show the app live in the market", priority: "High", weight: 3, status: "Not Started", parent_id: 22 },
  { id: 80, function: "Legal", workstream: "Legal Entity registration", task: "Registered office address secured (if required by legal)", desc: "If legal confirms a registered address is required, secure an office space and obtain trade license-eligible address proof", owner: "GM", deadline: "T-50", proof: "Signed lease + address proof PDF (or legal exemption memo)", validation: "Signed office lease and address proof are uploaded; or legal has confirmed in writing that no registered address is required", priority: "High", weight: 4, status: "Not Started", parent_id: 3 },
  { id: 81, function: "Commercial", workstream: "Commercial Readiness", task: "Scrape all competitors in the market", desc: "Single source of truth for competitor SKUs and live pricing across all relevant players (Talabat, Breadfast, Rabbit, etc). Includes baseline scrape and refresh closer to launch.", owner: "Commercial", deadline: "T-40", proof: "CSV upload (SKUs + pricing)", validation: "CSV contains: (1) all competition SKUs with name/pack size; (2) live pricing for each SKU; refreshed within 14 days of launch", priority: "High", weight: 3, status: "Not Started", parent_id: 7 },
  { id: 82, function: "Commercial", workstream: "Commercial Readiness", task: "Create a leadlist for all vendors in the market and the brands", desc: "Pre-requisite for vendor onboarding (#83) — must be done before T-40 reach-out begins. Date moved from T-11 to T-45.", owner: "Commercial", deadline: "T-45", proof: "CSV upload", validation: "List contains all vendors + brands in market with contact details, ready to feed vendor reach-out", priority: "High", weight: 3, status: "Not Started", parent_id: 24 },
  { id: 83, function: "Commercial", workstream: "Commercial Readiness", task: "Vendor onboarding progress (reach-out → close → agreements → LE codes → MPA → POs)", desc: "Single tracker for vendor onboarding through all milestones. Checkpoints: T-40 100% reach-out · T-35 50% closed / 20% signed · T-33 60% closed / 30% signed / 10% LE / 5% MPA · T-27 70% closed / 50% signed / 40% LE / 30% MPA · T-26 add 10% dummy POs raised · T-24 80% closed / 60% signed / 60% LE / 50% MPA + POs.", owner: "Commercial", deadline: "T-40", proof: "Live vendor tracker (sheet/dashboard) + signed MPA/BDA samples", validation: "Tracker shows status per vendor across all stages; T-24 thresholds met (80% closed, 60% signed, 60% LE, 50% MPA, dummy POs raised)", priority: "High", weight: 4, status: "Not Started", parent_id: 25 },
  { id: 84, function: "Commercial", workstream: "Commercial Readiness", task: "Close commercials with 50% of vendors with 20% vendors with agreements signed", desc: "ARCHIVED — T-35 checkpoint rolled into task #83 'Vendor onboarding progress'.", owner: "Commercial", deadline: "T-35", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Superseded by #83", priority: "Medium", weight: 2, status: "Not Started", parent_id: 26, archived: true },
  { id: 85, function: "HR", workstream: "HR", task: "Hiring of commercial team members", desc: "Hire commercial team members per the AOP headcount plan; offers rolled out and joiners confirmed", owner: "Commercial", deadline: "T-40", proof: "CSV upload", validation: "CSV lists each commercial role with status (open / offered / joined) and joining date; matches AOP headcount", priority: "Medium", weight: 2, status: "Not Started", parent_id: 42 },
  { id: 86, function: "Commercial", workstream: "Commercial Readiness", task: "60% of vendors closed, 30% of agreements signed, 10% LE codes created, 5% MPA done", desc: "ARCHIVED — T-33 checkpoint rolled into task #83 'Vendor onboarding progress'.", owner: "Commercial", deadline: "T-33", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Superseded by #83", priority: "Medium", weight: 2, status: "Not Started", parent_id: 27, archived: true },
  { id: 87, function: "Commercial", workstream: "Commercial Readiness", task: "70% of vendors closed, 50% agreements signed, 40% LE codes created, 30% MPA done", desc: "ARCHIVED — T-27 checkpoint rolled into task #83 'Vendor onboarding progress'.", owner: "Commercial", deadline: "T-27", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Superseded by #83", priority: "Medium", weight: 2, status: "Not Started", parent_id: 28, archived: true },
  { id: 88, function: "Commercial", workstream: "Commercial Readiness", task: "70% of vendors closed, 50% agreements signed, 40% LE codes created, 30% MPA done, 10% dummy POs raised", desc: "ARCHIVED — T-26 checkpoint rolled into task #83 'Vendor onboarding progress'.", owner: "Commercial", deadline: "T-26", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Superseded by #83", priority: "Medium", weight: 2, status: "Not Started", parent_id: 29, archived: true },
  { id: 89, function: "Commercial", workstream: "Commercial Readiness", task: "80% of vendors closed, 60% agreements signed, 60% LE codes created, 50% MPA done and dummy POs raised", desc: "ARCHIVED — T-24 checkpoint rolled into task #83 'Vendor onboarding progress'.", owner: "Commercial", deadline: "T-24", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Superseded by #83", priority: "Medium", weight: 2, status: "Not Started", parent_id: 30, archived: true },
  { id: 90, function: "Commercial", workstream: "Commercial Readiness", task: "Coordinate with in-stock & fulfilment team to forecast and prioritise first set of deliveries based on manpower", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-24", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Medium", weight: 2, status: "Not Started", parent_id: 30 },
  { id: 91, function: "Commercial", workstream: "Commercial Readiness", task: "Raising first set of POs for delivery in 2-3 days to the warehouse/dark stores", desc: "Complete this task as part of Dark Store Readiness.", owner: "Commercial", deadline: "T-22", proof: "CSV upload", validation: "CSV must contain the view of SKUs vendor wise SKU count,  PO raised SKU count", priority: "Medium", weight: 2, status: "Not Started", parent_id: 30 },
  { id: 92, function: "Commercial", workstream: "Commercial Readiness", task: "Get promos activated for pricing SKUs competitively", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-19", proof: "Promo config screenshot + sample SKU live URL", validation: "Promo configuration screenshot shows active promos for the priced SKUs; live SKU page reflects the promo price", priority: "High", weight: 3, status: "Not Started", parent_id: 45 },
  { id: 93, function: "Finance", workstream: "Commercial Readiness", task: "Marketplace & Retail Standard Commission Rate Card Approval", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-11", proof: "Approved rate card PDF + finance approval email", validation: "Rate card PDF is signed off and finance approval email confirms commission rates for marketplace and retail", priority: "Medium", weight: 2, status: "Not Started", parent_id: 24 },
  { id: 94, function: "Commercial", workstream: "Commercial Readiness", task: "Ensuring all stock for core categories is at the central WH", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-22", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Medium", weight: 2, status: "Not Started", parent_id: 30 },
  { id: 95, function: "Commercial", workstream: "Commercial Readiness", task: "Taxonomy & Go-Live uploads for all categories", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-20", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 23 },
  { id: 96, function: "Instock", workstream: "Commercial Readiness", task: "Core SKUs stock transer creation", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-14", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 30 },
  { id: 97, function: "Pricing", workstream: "Pricing & Competition", task: "Availability", desc: "Complete this task as part of Pricing & Competition.", owner: "GM", deadline: "T-45", proof: "Pricing/mapping/promos upload confirmation", validation: "Price/mapping data is uploaded and KVIs are competitive within approved PC1 thresholds", priority: "Low", weight: 1, status: "Not Started", parent_id: 47 },
  { id: 98, function: "Commercial", workstream: "Commercial Readiness", task: "Get a fresh scrape of pricing for competition", desc: "ARCHIVED — refresh cadence rolled into task #81 'Scrape all competitors in the market'.", owner: "Commercial", deadline: "T-15", proof: "CSV", validation: "Superseded by #81", priority: "Medium", weight: 2, status: "Not Started", parent_id: 7, archived: true },
  { id: 99, function: "Commercial", workstream: "Commercial Readiness", task: "Fill rate is on track and all SKUs are available", desc: "Complete this task as part of Commercial Readiness.", owner: "In-Stock", deadline: "T-15", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 30 },
  { id: 100, function: "Logistics", workstream: "Logistics Readiness", task: "Funnel + rider capacity + 15-min delivery feasibility test", desc: "Run an end-to-end test on funnel conversion, rider capacity and 15-minute delivery promise; share results with sign-off", owner: "GM", deadline: "T-11", proof: "Test report PDF + dashboard screenshot", validation: "Test report shows funnel conversion, rider utilisation and on-time % at the 15-min mark; meets pre-launch threshold", priority: "High", weight: 3, status: "Not Started", parent_id: 46 },
  { id: 101, function: "On-site", workstream: "Commercial Readiness", task: "Local events and campaigns list", desc: "Complete this task as part of Commercial Readiness.", owner: "Onsite", deadline: "T-15", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Priority vendors are onboarded, contracted, and commercial terms are captured in system", priority: "Medium", weight: 2, status: "Not Started", parent_id: 32 },
  { id: 102, function: "On-site", workstream: "Commercial Readiness", task: "Campaign calendar", desc: "Complete this task as part of Commercial Readiness.", owner: "Onsite", deadline: "T-15", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Priority vendors are onboarded, contracted, and commercial terms are captured in system", priority: "Medium", weight: 2, status: "Not Started", parent_id: 32 },
  { id: 103, function: "Real Estate", workstream: "Dark Store Readiness", task: "Initiate a mail on IT Assets - PDAs & systems, Pickers (fulfilment) & riders (logisitics) & procurement on fitouts", desc: "Complete this task as part of Dark Store Readiness. Give dates of go live of each store to the central team.", owner: "GM", deadline: "T-40", proof: "PDF upload", validation: "PDF should contain the mail trail with the asks clearly defined.", priority: "High", weight: 3, status: "Not Started", parent_id: 11 },
  { id: 104, function: "Growth", workstream: "Growth Readiness", task: "New user offer input", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T-15", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Medium", weight: 2, status: "Not Started", parent_id: 31 },
  { id: 105, function: "Procurement", workstream: "Logistics Readiness", task: "Closure of rate cards", desc: "Complete this task as part of Logistics Readiness.", owner: "Logistics", deadline: "T-16", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Low", weight: 1, status: "Not Started", parent_id: 38 },
  { id: 106, function: "Procurement", workstream: "Logistics Readiness", task: "Uniform, Helmets & Boxes sourced and first patch delivered (Local)", desc: "Single task covering local sourcing of uniforms/helmets/boxes and delivery of the first patch.", owner: "Logistics", deadline: "T-9", proof: "Vendor PO + photos of first delivered patch", validation: "Local sourcing confirmed; first patch delivered with photo evidence", priority: "Medium", weight: 2, status: "Not Started", parent_id: 38 },
  { id: 107, function: "Procurement", workstream: "Logistics Readiness", task: "Uniform & Helmets & Boxes (Local) - On patches with first patch", desc: "ARCHIVED — merged into task #106 'Uniform, Helmets & Boxes sourced and first patch delivered'.", owner: "Logistics", deadline: "T-9", proof: "Updated tracker link or evidence screenshot", validation: "Superseded by #106", priority: "Medium", weight: 2, status: "Not Started", parent_id: 38, archived: true },
  { id: 108, function: "Procurement", workstream: "Logistics Readiness", task: "Imported boxes - to arrive at destination port", desc: "Complete this task as part of Logistics Readiness.", owner: "Logistics", deadline: "T-7", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Medium", weight: 2, status: "Not Started", parent_id: 38 },
  { id: 109, function: "Procurement", workstream: "Logistics Readiness", task: "Pouches (Local)", desc: "Complete this task as part of Logistics Readiness.", owner: "Logistics", deadline: "T+6", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Low", weight: 1, status: "Not Started", parent_id: 38 },
  { id: 110, function: "Logistics", workstream: "Logistics Readiness", task: "Finalizing instapay + COD flow", desc: "Complete this task as part of Logistics Readiness.", owner: "Logistics", deadline: "T-14", proof: "Vendor closure, roster, or SLA readiness tracker", validation: "Rider/picker supply is closed, trained, and aligned to store OPD/SLA requirements", priority: "Medium", weight: 2, status: "Not Started", parent_id: 38 },
  { id: 111, function: "Instock", workstream: "Instock Readiness", task: "Ordering sheets setup", desc: "Complete this task as part of Instock Readiness.", owner: "instock", deadline: "T-22", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Low", weight: 1, status: "Not Started", parent_id: 44 },
  { id: 112, function: "Operations", workstream: "Instock Readiness", task: "Store Space mapping X Category allocation (Space BU)", desc: "Complete this task as part of Pricing & Competition.", owner: "instock", deadline: "T-9", proof: "Space-BU mapping CSV/XLSX", validation: "File contains every store with category-wise space allocation (sqm or planogram %) and is signed off by ops", priority: "Medium", weight: 2, status: "Not Started", parent_id: 44 },
  { id: 113, function: "Tech", workstream: "Commercial Readiness", task: "Assortment table Setup needed to issue POs", desc: "Complete this task as part of Commercial Readiness.", owner: "instock", deadline: "T-21", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Low", weight: 1, status: "Not Started", parent_id: 12 },
  { id: 114, function: "Instock", workstream: "Commercial Readiness", task: "MPA codes creation for vendors needed to issue POs", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-16", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Priority vendors are onboarded, contracted, and commercial terms are captured in system", priority: "Medium", weight: 2, status: "Not Started", parent_id: 28 },
  { id: 115, function: "Tech", workstream: "Instock Readiness", task: "UF & F&V Ordering sheets setup", desc: "Complete this task as part of Instock Readiness.", owner: "instock", deadline: "T-14", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Medium", weight: 2, status: "Not Started", parent_id: 44 },
  { id: 116, function: "Operations", workstream: "Instock Readiness", task: "Capacity Plan (IB/OB) WH", desc: "Complete this task as part of Instock Readiness.", owner: "instock", deadline: "T-22", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Low", weight: 1, status: "Not Started", parent_id: 44 },
  { id: 117, function: "Tech", workstream: "Instock Readiness", task: "Tech dashboards live (Assortment, Stock/AVL, Replenishment, tables)", desc: "Single tracker for all instock tech dashboards going live: (1) Tables replicated from other markets · (2) Assortment + Stock dashboard replicated · (3) AVL realtime view · (4) Replenishment / delivery tracking. Per-component dates: T-21 dashboard replication · T-16 AVL + Replenishment · T-15 tables replication.", owner: "Instock / Tech", deadline: "T-21", proof: "Live dashboard links + screenshots for each component", validation: "All four dashboards live and showing real data; replenishment tracks delivery vs PO with fill rate per vendor", priority: "High", weight: 4, status: "Not Started", parent_id: 12 },
  { id: 118, function: "Instock", workstream: "Instock Readiness", task: "RO tracker (track deliveries & FR) creation", desc: "Complete this task as part of Instock Readiness.", owner: "instock", deadline: "T-21", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Medium", weight: 2, status: "Not Started", parent_id: 44 },
  { id: 119, function: "Tech", workstream: "Instock Readiness", task: "Replenishment dashboard for delivery tracking", desc: "ARCHIVED — rolled into task #117 'Tech dashboards live'.", owner: "instock", deadline: "T-16", proof: "Live dashboard link + screenshot", validation: "Superseded by #117", priority: "Medium", weight: 2, status: "Not Started", parent_id: 12, archived: true },
  { id: 120, function: "Tech", workstream: "Instock Readiness", task: "Tables Replication from other markets", desc: "ARCHIVED — rolled into task #117 'Tech dashboards live'.", owner: "instock", deadline: "T-15", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Superseded by #117", priority: "Medium", weight: 2, status: "Not Started", parent_id: 12, archived: true },
  { id: 121, function: "Tech", workstream: "Instock Readiness", task: "AVL dashboard creation for Realtime View", desc: "ARCHIVED — rolled into task #117 'Tech dashboards live'.", owner: "instock", deadline: "T-16", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Superseded by #117", priority: "Medium", weight: 2, status: "Not Started", parent_id: 12, archived: true },
  { id: 122, function: "Instock", workstream: "Commercial Readiness", task: "Vendor group creation for communication", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-15", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Priority vendors are onboarded, contracted, and commercial terms are captured in system", priority: "Medium", weight: 2, status: "Not Started", parent_id: 24 },
  { id: 123, function: "Instock", workstream: "Commercial Readiness", task: "Delivery schedule setting for FnV & Fresh (Alignment with vendors)", desc: "Complete this task as part of Commercial Readiness.", owner: "instock", deadline: "T-14", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Priority vendors are onboarded, contracted, and commercial terms are captured in system", priority: "Medium", weight: 2, status: "Not Started", parent_id: 24 },
  { id: 124, function: "Commercial", workstream: "Commercial Readiness", task: "FnV Category Mapping", desc: "Complete this task as part of Commercial Readiness.", owner: "In-stock", deadline: "T-14", proof: "Category mapping CSV", validation: "CSV maps every FnV SKU to its category and sub-category and is signed off by commercial", priority: "Medium", weight: 2, status: "Not Started", parent_id: 23 },
  { id: 125, function: "Instock", workstream: "Commercial Readiness", task: "Delivery schedule for FZ & Chilled vendors for DTS", desc: "Complete this task as part of Commercial Readiness.", owner: "instock", deadline: "T-15", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Priority vendors are onboarded, contracted, and commercial terms are captured in system", priority: "Medium", weight: 2, status: "Not Started", parent_id: 24 },
  { id: 126, function: "Operations", workstream: "Instock Readiness", task: "DTS Inbound plan to be shared with OPs for feasibility of receiving + manpower prep.", desc: "Complete this task as part of Instock Readiness.", owner: "instock", deadline: "T-17", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "High", weight: 3, status: "Not Started", parent_id: 44 },
  { id: 127, function: "Instock", workstream: "Commercial Readiness", task: "Assortment details Required for PO raising (MOQ uploader, Cost-list, Shelf life & storage condition)", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-17", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "High", weight: 3, status: "Not Started", parent_id: 24 },
  { id: 128, function: "Procurement", workstream: "Instock Readiness", task: "Core Transfer to DS, Truck Readiness", desc: "Complete this task as part of Instock Readiness.", owner: "instock", deadline: "T-15", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Medium", weight: 2, status: "Not Started", parent_id: 44 },
  { id: 129, function: "Instock", workstream: "Instock Readiness", task: "Raise 1st batch of POs for WH (AM) to be supplied on 2nd of April & DTS for (Chilled & Frozen) to be supplied starting thursday", desc: "Complete this task as part of Instock Readiness.", owner: "instock", deadline: "T-13", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Medium", weight: 2, status: "Not Started", parent_id: 30 },
  { id: 130, function: "Commercial", workstream: "Commercial Readiness", task: "Delivery confirmations from vendors for 100% of Assortment", desc: "Complete this task as part of Commercial Readiness.", owner: "instock", deadline: "T-10", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Priority vendors are onboarded, contracted, and commercial terms are captured in system", priority: "Medium", weight: 2, status: "Not Started", parent_id: 30 },
  { id: 131, function: "Instock", workstream: "Instock Readiness", task: "Capacity plan Core (OB) alignment", desc: "Complete this task as part of Instock Readiness.", owner: "instock", deadline: "T-14", proof: "PO/ASN/GRN or fill-rate dashboard screenshot", validation: "Inventory is inbounded/planned and launch fill-rate confidence is achieved", priority: "Medium", weight: 2, status: "Not Started", parent_id: 44 },
  { id: 132, function: "Instock", workstream: "Instock Readiness", task: "Core/Central team alignment on BAU Doc transfer creation for core SKUs", desc: "Complete this task as part of Instock Readiness.", owner: "instock", deadline: "T-14", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 30 },
  { id: 133, function: "On-site", workstream: "Growth Readiness", task: "Countdown on the core app with banners showing \"Coming in 2 days\"", desc: "Complete this task as part of Growth Readiness.", owner: "Onsite", deadline: "T-2", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "High", weight: 3, status: "Not Started", parent_id: 36 },
  { id: 134, function: "Commercial", workstream: "Growth Readiness", task: "Launch Video (long form) - go live (Instagram & paid ads) - Professional high end video", desc: "Complete this task as part of Commercial Readiness.", owner: "Brand Marketing", deadline: "T-2", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "High", weight: 3, status: "Not Started", parent_id: 36 },
  { id: 135, function: "Legal", workstream: "Growth Readiness", task: "Influencer & on-ground activations, Insta influencers (Micro & medium)", desc: "Complete this task as part of Legal Entity registration.", owner: "Brand Marketing", deadline: "T+1", proof: "Influencer tracker CSV + signed agreements", validation: "CSV lists each influencer with handle, tier, fees, deliverables and live date; signed agreements attached", priority: "Low", weight: 1, status: "Not Started", parent_id: 37 },
  { id: 136, function: "Growth", workstream: "Growth Readiness", task: "Social media readiness (PR local handles)", desc: "Complete this task as part of Commercial Readiness.", owner: "Brand Marketing", deadline: "T+1", proof: "Live handles screenshot + content calendar", validation: "All PR-managed local social handles are live with first post; content calendar covers launch week", priority: "Low", weight: 1, status: "Not Started", parent_id: 36 },
  { id: 137, function: "On-site", workstream: "Growth Readiness", task: "Clear USPs for launch communication: Branding campaigns, Launch videos, Teaser - brief: key categories, SKUs, Areas, what to focus on (being local), speed", desc: "Complete this task as part of Commercial Readiness.", owner: "Brand Marketing", deadline: "T-13", proof: "Vendor tracker, MPA/BDA, or signed agreement", validation: "Priority vendors are onboarded, contracted, and commercial terms are captured in system", priority: "High", weight: 3, status: "Not Started", parent_id: 36 },
  { id: 138, function: "Growth", workstream: "Growth Readiness", task: "Influencer video to go live on launch date - Finalization of script, influnercer", desc: "Complete this task as part of Commercial Readiness.", owner: "Brand Marketing", deadline: "T+1", proof: "Final video file + go-live screenshot", validation: "Final influencer video file delivered and screenshot of live post on launch date attached", priority: "Low", weight: 1, status: "Not Started", parent_id: 37 },
  { id: 139, function: "Growth", workstream: "Growth Readiness", task: "Exclusive Partnerships: Banks, Universities, Airlines, Telcom, Gym, Payment apps - - Employees: Typical employers, suppliers, partners - visibility at multiple places", desc: "Complete this task as part of Legal Entity registration.", owner: "Growth", deadline: "T+13", proof: "Partnership tracker CSV + signed MoUs", validation: "CSV lists each partner with deal type, status and go-live date; signed MoUs attached for closed partnerships", priority: "Medium", weight: 2, status: "Not Started", parent_id: 36 },
  { id: 140, function: "Growth", workstream: "Growth Readiness", task: "Affiliate marketing - align on plan & channels Channels to be finalized Sandbox Ads - channels, plan, ROI", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T-10", proof: "Affiliate plan PDF + channel CSV", validation: "Plan PDF lists channels, ROI assumptions and budgets; CSV lists affiliate partners with status", priority: "Medium", weight: 2, status: "Not Started", parent_id: 36 },
  { id: 141, function: "Growth", workstream: "Growth Readiness", task: "Digital Marketing - Country + Attribution Setup - Google [P0] - Meta [P0] - Tiktok [P1] - X [P1] - With coming soon banners", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T-13", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "High", weight: 4, status: "Not Started", parent_id: 36 },
  { id: 142, function: "On-site", workstream: "Growth Readiness", task: "Digital Marketing - Assets readiness for all the above channels", desc: "Complete this task as part of Growth Readiness.", owner: "Onsite", deadline: "T-7", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "Medium", weight: 2, status: "Not Started", parent_id: 36 },
  { id: 143, function: "Growth", workstream: "Growth Readiness", task: "Digital Marketing - Alignment with agencies on channels and target spends, audience, geo location and readiness check", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T-10", proof: "Agency briefing deck + spend plan CSV", validation: "Briefing deck is signed off by agencies; CSV lists channel, audience, geo and target spend with finance approval", priority: "Medium", weight: 2, status: "Not Started", parent_id: 36 },
  { id: 144, function: "Growth", workstream: "Growth Readiness", task: "Coupon offers Finalization & Setup - 2. Construct of NU, RU, Dormant", desc: "ARCHIVED — merged into task #63 'Coupon offers - construct + setup'.", owner: "Growth", deadline: "T-16", proof: "Coupon construct doc + setup screenshot", validation: "Superseded by #63", priority: "Medium", weight: 2, status: "Not Started", parent_id: 31, archived: true },
  { id: 145, function: "Growth", workstream: "Growth Readiness", task: "Bank Offers - all bank offers + comp benchmarking", desc: "Complete this task as part of Legal Entity registration.", owner: "Growth", deadline: "T+6", proof: "Bank offer tracker CSV + signed agreements", validation: "CSV lists each bank with offer construct, status and live date; signed agreements attached for confirmed banks", priority: "Low", weight: 1, status: "Not Started", parent_id: 36 },
  { id: 146, function: "Growth", workstream: "Growth Readiness", task: "Delivery fees - construct + setup", desc: "Single task covering delivery fee construct (New User discount + how many orders) and system setup.", owner: "Growth", deadline: "T-16", proof: "Construct doc + setup screenshot", validation: "Construct defines NU delivery fee discount + qualifying order count; system setup matches doc", priority: "Medium", weight: 2, status: "Not Started", parent_id: 31 },
  { id: 147, function: "Growth", workstream: "Growth Readiness", task: "Delivery fees configuration - construct & setup 2. Construct for New User, (Discount + How many orders)", desc: "ARCHIVED — merged into task #146 'Delivery fees - construct + setup'.", owner: "Growth", deadline: "T-16", proof: "Updated tracker link or evidence screenshot", validation: "Superseded by #146", priority: "Low", weight: 1, status: "Not Started", parent_id: 31, archived: true },
  { id: 148, function: "Growth", workstream: "Growth Readiness", task: "Boosting logic setup", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T-15", proof: "Updated tracker link or evidence screenshot", validation: "Owner confirms completion and required evidence is uploaded", priority: "Medium", weight: 2, status: "Not Started", parent_id: 34 },
  { id: 149, function: "Growth", workstream: "Growth Readiness", task: "Search boosting (for null searches) of SKUs", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T-1", proof: "SKU upload/tool screenshot or MSL file", validation: "Launch SKUs are created, searchable, attributed, costed, and mapped correctly", priority: "High", weight: 3, status: "Not Started", parent_id: 34 },
  { id: 150, function: "Growth", workstream: "Growth Readiness", task: "Define OPD targets", desc: "Building blocks of OPD targets : Core - Performance Marketing - Affiliate - Awareness Campaigns (BTL, Influencers, ATL) - Organic", owner: "Growth", deadline: "T-10", proof: "CSV upload", validation: "Daily and weekly OPD targets for each store consistent with the launches are to be included", priority: "Medium", weight: 2, status: "Not Started", parent_id: 33 },
  { id: 151, function: "Growth", workstream: "Growth Readiness", task: "Hub wise ramp up plan", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T-10", proof: "Ramp-up plan CSV/XLSX", validation: "File lists each hub with weekly OPD ramp targets through W+8 and is signed off by central + market", priority: "Medium", weight: 2, status: "Not Started", parent_id: 35 },
  { id: 152, function: "Growth", workstream: "Growth Readiness", task: "Referral plan 1. Construct 2. Set up & go live", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T+6", proof: "Campaign calendar, live asset screenshot, or dashboard link", validation: "Growth asset/campaign is approved, scheduled/live, and aligned to OPD plan", priority: "Low", weight: 1, status: "Not Started", parent_id: 31 },
  { id: 153, function: "Growth", workstream: "Growth Readiness", task: "Dashboards readiness - - Real time dashboard, Category wise real time, Other MP trends - D-1 view: RCA dashboard, BI overview - Spends, delivery fees, coupons - Realtime & DoD - Central dashboards", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T-9", proof: "Live dashboard links list", validation: "All listed dashboards (real time, category, RCA, BI overview, spends/coupons) are live and accessible at the provided links", priority: "Medium", weight: 2, status: "Not Started", parent_id: 31 },
  { id: 154, function: "Growth", workstream: "Growth Readiness", task: "1. Email to all noon employers to post offers on the group (Ellen)", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T-3", proof: "Sent email screenshot + posted offer screenshot", validation: "Email to noon employer groups is sent and screenshot of the offer posted in the group is attached", priority: "High", weight: 3, status: "Not Started", parent_id: 36 },
  { id: 155, function: "Growth", workstream: "Growth Readiness", task: "Flyer and Door hanger - BTL Activation", desc: "Complete this task as part of Growth Readiness.", owner: "Growth", deadline: "T-3", proof: "Final asset PDFs + distribution plan CSV", validation: "Print-ready flyer & door-hanger PDFs delivered; CSV lists distribution areas, drop counts and dates", priority: "High", weight: 3, status: "Not Started", parent_id: 36 },
  { id: 156, function: "Pricing", workstream: "Pricing & Competition", task: "Scraping of Talabat, Breadfast, Rabbit", desc: "ARCHIVED — competitor list rolled into task #81 'Scrape all competitors in the market'.", owner: "Pricing", deadline: "T-13", proof: "Competition scrape CSV", validation: "Superseded by #81", priority: "Medium", weight: 2, status: "Not Started", parent_id: 7, archived: true },
  { id: 157, function: "Admin", workstream: "Instock Readiness", task: "Mapping sprint completed with admin team", desc: "Complete the SKU / location / vendor mapping sprint with the admin team before launch; deliverable is a clean mapping file", owner: "Pricing", deadline: "T-10", proof: "Mapping CSV/XLSX upload", validation: "Mapping file is fully populated (no blanks in mandatory fields) and is signed off by the admin lead", priority: "Medium", weight: 2, status: "Not Started", parent_id: 44 },
  { id: 158, function: "Pricing", workstream: "Pricing & Competition", task: "SRP Pricing Engine live for the market", desc: "Complete this task as part of Pricing & Competition.", owner: "Pricing", deadline: "T-13", proof: "Live engine screenshot + pricing run CSV", validation: "SRP engine is live for the market; sample pricing run CSV shows SRPs generated for KVI SKUs within PC1 thresholds", priority: "High", weight: 3, status: "Not Started", parent_id: 7 },
  { id: 159, function: "Commercial", workstream: "Commercial Readiness", task: "Promo uploads", desc: "Complete this task as part of Commercial Readiness.", owner: "Commercial", deadline: "T-10", proof: "PDF upload", validation: "Confirmation on Promo uploads", priority: "High", weight: 3, status: "Not Started", parent_id: 45 },
];

// Helper: returns only tasks that haven't been archived during consolidation.
// Archived tasks stay in TASKS for audit trail but are hidden from all UI views.
const activeTasks = () => TASKS.filter(t => !t.archived);

let MILESTONES = [
  { id: 1, function: "Central Launch", workstream: "Plan Readiness", task: "AOP locked", desc: "", owner: "Central Launch", deadline: "T-60", proof: "Excel/G-sheet", validation: "Manual Validation", priority: "High", weight: 4, status: "Not Started" },
  { id: 2, function: "Central Launch", workstream: "Team Readiness", task: "P0 hires onboarded", desc: "GM, Real Estate, Fulfilment & Commercil", owner: "Central Launch", deadline: "T-60", proof: "Noon systems", validation: "Nubsub validations", priority: "High", weight: 4, status: "Not Started" },
  { id: 3, function: "Legal", workstream: "Legal Entity Registration", task: "Entity registration", desc: "Get in touch with the legal and finance team to get all necessary information", owner: "General Manager", deadline: "T-50", proof: "PDF", validation: "Manual Validation", priority: "High", weight: 4, status: "Not Started" },
  { id: 4, function: "Legal", workstream: "Legal Entity Registration", task: "Operating licenses secured", desc: "", owner: "General Manager", deadline: "T-50", proof: "PDF", validation: "License PDF", priority: "High", weight: 4, status: "Not Started" },
  { id: 5, function: "Finance", workstream: "Legal Entity Registration", task: "Company bank account opened", desc: "", owner: "General Manager", deadline: "T-48", proof: "PDF", validation: "Bank Account Header", priority: "High", weight: 4, status: "Not Started" },
  { id: 6, function: "Logistics", workstream: "Logistics Readiness", task: "Last-mile polygons uploaded", desc: "The last mile polygons are the pillars to the 15 minute delivery and have to be in line with the darkstore location", owner: "General Manager", deadline: "T-45", proof: "Noon systems", validation: "Backend driven", priority: "High", weight: 4, status: "Not Started" },
  { id: 7, function: "Pricing", workstream: "Pricing Readiness", task: "Competition scrape live", desc: "Scrape competition in the market for SKUs and pricing", owner: "Commercial Manager", deadline: "T-45", proof: "Tables created", validation: "Manual Validation", priority: "High", weight: 4, template: "Scrape Template", status: "Not Started" },
  { id: 8, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS lease template shared with legal", desc: "This will help for future dark stores", owner: "Real Estate Manager", deadline: "T-49", proof: "PDF", validation: "Template document", priority: "High", weight: 4, status: "Not Started" },
  { id: 9, function: "Real Estate", workstream: "Dark Store Readiness", task: "Fit-out vendors closed (racks, shelving, cold rooms)", desc: "", owner: "Real Estate Manager", deadline: "T-40", proof: "PDF", validation: "Signed agreement", priority: "High", weight: 4, status: "Not Started" },
  { id: 10, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #1 lease signed & handover taken", desc: "", owner: "Real Estate Manager", deadline: "T-40", proof: "PDF", validation: "Signed agreement", priority: "High", weight: 4, status: "Not Started" },
  { id: 11, function: "IT", workstream: "IT Readiness", task: "IT assets & internet secured", desc: "Make a list of all required IT assets and secure the same for smooth operations", owner: "General Manager", deadline: "T-25", proof: "PDF", validation: "Signed Agreements", priority: "High", weight: 3, status: "Not Started" },
  { id: 12, function: "Tech", workstream: "Tech Readiness", task: "Nubsubs & dashboards replicated", desc: "", owner: "General Manager", deadline: "T-40", proof: "Noon systems", validation: "Backend driven", priority: "High", weight: 4, status: "Not Started" },
  { id: 13, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #2 lease signed & handover taken", desc: "", owner: "Real Estate Manager", deadline: "T-35", proof: "PDF", validation: "Signed Agreements", priority: "High", weight: 3, status: "Not Started" },
  { id: 14, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #3 lease signed & handover taken", desc: "", owner: "Real Estate Manager", deadline: "T-30", proof: "PDF", validation: "Signed Agreements", priority: "High", weight: 3, status: "Not Started" },
  { id: 15, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #4 lease signed & handover taken", desc: "", owner: "Real Estate Manager", deadline: "T-25", proof: "PDF", validation: "Signed Agreements", priority: "High", weight: 3, status: "Not Started" },
  { id: 16, function: "Real Estate", workstream: "Warehouse Readiness", task: "Warehouse lease signed & handover taken", desc: "", owner: "Fulfilment Manager", deadline: "T-40", proof: "PDF", validation: "Signed agreement", priority: "High", weight: 4, status: "Not Started" },
  { id: 17, function: "Fulfilment", workstream: "Warehouse Readiness", task: "Linehaul agreements closed", desc: "", owner: "Fulfilment Manager", deadline: "T-30", proof: "PDF", validation: "Signed agreement", priority: "High", weight: 3, status: "Not Started" },
  { id: 18, function: "Fulfilment", workstream: "Warehouse Readiness", task: "Warehouse operational", desc: "", owner: "Fulfilment Manager", deadline: "T-12", proof: "Validation on RE app", validation: "Backend driven", priority: "High", weight: 2, status: "Not Started" },
  { id: 19, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #1 operational", desc: "", owner: "Real Estate Manager", deadline: "T-15", proof: "Validation on RE app", validation: "Backend driven", priority: "High", weight: 2, status: "Not Started" },
  { id: 20, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #2 operational", desc: "", owner: "Real Estate Manager", deadline: "T-10", proof: "Validation on RE app", validation: "Backend driven", priority: "High", weight: 2, status: "Not Started" },
  { id: 21, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #3 operational", desc: "", owner: "Real Estate Manager", deadline: "T-5", proof: "Validation on RE app", validation: "Backend driven", priority: "High", weight: 2, status: "Not Started" },
  { id: 22, function: "Real Estate", workstream: "Dark Store Readiness", task: "DS #4 operational", desc: "", owner: "Real Estate Manager", deadline: "T-0", proof: "Validation on RE app", validation: "Backend driven", priority: "High", weight: 2, status: "Not Started" },
  { id: 23, function: "Commercial", workstream: "Commercial Readiness", task: "Brand universe populated", desc: "", owner: "Commercial Manager", deadline: "T-43", proof: "Live G Drive Link", validation: "Manual Validation", priority: "High", weight: 4, template: "Brand Universe Exercise - Template", status: "Not Started" },
  { id: 24, function: "Commercial", workstream: "Commercial Readiness", task: "Vendor sheet populated", desc: "", owner: "Commercial Manager", deadline: "T-40", proof: "Live G Drive Link", validation: "Manual Validation", priority: "High", weight: 4, template: "Commercial Vendors Template", status: "Not Started" },
  { id: 25, function: "Commercial", workstream: "Commercial Readiness", task: "All vendors approached", desc: "", owner: "Commercial Manager", deadline: "T-35", proof: "Live G Drive Link", validation: "Manual Validation", priority: "High", weight: 3, status: "Not Started" },
  { id: 26, function: "Commercial", workstream: "Commercial Readiness", task: "20% of assortment ready", desc: "", owner: "Commercial Manager", deadline: "T-30", proof: "Noon systems", validation: "Backend driven", priority: "High", weight: 3, status: "Not Started" },
  { id: 27, function: "Commercial", workstream: "Commercial Readiness", task: "40% of assortment ready", desc: "", owner: "Commercial Manager", deadline: "T-27", proof: "Noon systems", validation: "Backend driven", priority: "High", weight: 3, status: "Not Started" },
  { id: 28, function: "Commercial", workstream: "Commercial Readiness", task: "60% of assortment ready", desc: "", owner: "Commercial Manager", deadline: "T-25", proof: "Noon systems", validation: "Backend driven", priority: "High", weight: 3, status: "Not Started" },
  { id: 29, function: "Commercial", workstream: "Commercial Readiness", task: "80% of assortment ready", desc: "", owner: "Commercial Manager", deadline: "T-22", proof: "Noon systems", validation: "Backend driven", priority: "High", weight: 3, status: "Not Started" },
  { id: 30, function: "Commercial", workstream: "Commercial Readiness", task: "100% of assortment ready", desc: "", owner: "Commercial Manager", deadline: "T-20", proof: "Noon systems", validation: "Backend driven", priority: "High", weight: 3, status: "Not Started" },
  { id: 31, function: "Growth", workstream: "Growth Readiness", task: "Growth dashboards live (BI, DoD, Coupons, Del Fee)", desc: "", owner: "Growth Manager", deadline: "T-30", proof: "Dashboard Link", validation: "Manual Validation", priority: "High", weight: 3, status: "Not Started" },
  { id: 32, function: "Growth", workstream: "Growth Readiness", task: "Campaign calendar shared", desc: "", owner: "Growth Manager", deadline: "T-25", proof: "G Drive Link", validation: "Manual Validation", priority: "High", weight: 3, status: "Not Started" },
  { id: 33, function: "Growth", workstream: "Growth Readiness", task: "OPD targets set", desc: "", owner: "Growth Manager", deadline: "T-20", proof: "G Drive Link", validation: "Manual Validation", priority: "High", weight: 3, status: "Not Started" },
  { id: 34, function: "Growth", workstream: "Growth Readiness", task: "Search boosting configured", desc: "", owner: "Growth Manager", deadline: "T-10", proof: "App Video", validation: "Manual Validation", priority: "High", weight: 2, status: "Not Started" },
  { id: 35, function: "Growth", workstream: "Growth Readiness", task: "Hub-wise ramp-up plan shared", desc: "", owner: "Growth Manager", deadline: "T-10", proof: "Sheet/Excel link", validation: "Manual Validation", priority: "High", weight: 2, status: "Not Started" },
  { id: 36, function: "Growth", workstream: "Growth Readiness", task: "ATL & BTL activations closed", desc: "", owner: "Growth Manager", deadline: "T-20", proof: "PDF", validation: "Signed Agreement", priority: "High", weight: 3, status: "Not Started" },
  { id: 37, function: "Growth", workstream: "Growth Readiness", task: "Influencer campaign closed", desc: "", owner: "Growth Manager", deadline: "T-20", proof: "PDF", validation: "Signed Agreement", priority: "High", weight: 3, status: "Not Started" },
  { id: 38, function: "Logistics", workstream: "Logistics Readiness", task: "Logistics vendors onboarded", desc: "", owner: "Logistics Manager", deadline: "T-20", proof: "PDF", validation: "Signed Agreement", priority: "High", weight: 3, status: "Not Started" },
  { id: 39, function: "HR", workstream: "Team Readiness", task: "R1 hiring closed", desc: "Logistics Manager, Growth Manager", owner: "General Manager", deadline: "T-45", proof: "Noon systems", validation: "Nubsub validations", priority: "High", weight: 4, status: "Not Started" },
  { id: 40, function: "HR", workstream: "Team Readiness", task: "PC2 structure & hiring closed", desc: "Warehouse and dark store supervisors", owner: "Fulfilment Manager", deadline: "T-40", proof: "Noon systems", validation: "Nubsub validations", priority: "High", weight: 4, status: "Not Started" },
  { id: 41, function: "HR", workstream: "Team Readiness", task: "R2 hiring closed", desc: "Facilities Manager", owner: "Real Estate Manager", deadline: "T-30", proof: "Noon systems", validation: "Nubsub validations", priority: "High", weight: 3, status: "Not Started" },
  { id: 42, function: "HR", workstream: "Team Readiness", task: "Commercial team hiring closed", desc: "", owner: "Commercial Manager", deadline: "T-35", proof: "Noon systems", validation: "Nubsub validations", priority: "High", weight: 3, status: "Not Started" },
  { id: 43, function: "HR", workstream: "Team Readiness", task: "R3 hiring closed", desc: "In-stock manager", owner: "General Manager", deadline: "T-40", proof: "Noon systems", validation: "Nubsub validations", priority: "High", weight: 4, status: "Not Started" },
  { id: 44, function: "Instock", workstream: "In-stock Readiness", task: "Capacity planning closed", desc: "All Inbound and outbound quantities have ben planned from WH to the DS", owner: "In-Stock Manager", deadline: "T-20", proof: "G Drive Link", validation: "Manual Validation", priority: "High", weight: 3, template: "Capacity Planning reference", status: "Not Started" },
  { id: 45, function: "Commercial", workstream: "Commercial Readiness", task: "Launch promos live", desc: "", owner: "Commercial Manager", deadline: "T-7", proof: "Link", validation: "Manual Validation", priority: "High", weight: 2, status: "Not Started" },
  { id: 46, function: "Logistics", workstream: "Tracking", task: "Rider & adherence metrics live", desc: "Create dashboard to track adherence", owner: "Logistics Manager", deadline: "T-7", proof: "Link", validation: "Manual Validation", priority: "High", weight: 2, status: "Not Started" },
  { id: 47, function: "Instock", workstream: "Tracking", task: "Availability metrics live", desc: "Create dashboard to track availability", owner: "In-Stock Manager", deadline: "T-7", proof: "Link", validation: "Manual Validation", priority: "High", weight: 2, status: "Not Started" },
  { id: 48, function: "Pricing", workstream: "Tracking", task: "PC1 metrics live", desc: "Create dashboard to track profitability", owner: "Commercial Manager", deadline: "T-7", proof: "Link", validation: "Manual Validation", priority: "High", weight: 2, status: "Not Started" },
  { id: 49, function: "Finance", workstream: "Tracking", task: "PnL dashboard live", desc: "Create dashboard for overall PnL", owner: "Central Finance", deadline: "T-7", proof: "Link", validation: "Manual Validation", priority: "High", weight: 2, status: "Not Started" },
];

const TEMPLATES = [
  {
    "id": "scrape_template",
    "name": "Scrape Template",
    "summary": "Standard format for scraping competitor SKUs and prices.",
    "fields": [
      "competitor_name",
      "sku_name",
      "brand",
      "pack_size",
      "price_local_ccy",
      "promo_price",
      "category",
      "scrape_date",
      "scraped_by"
    ],
    "use": "Pricing & Competition team weekly. Fed into the SRP Pricing Engine and Competition Benchmarking dashboards.",
    "milestones": [
      7
    ]
  },
  {
    "id": "brand_universe_exercise_template",
    "name": "Brand Universe Exercise - Template",
    "summary": "Maps every brand operating in the market across categories, with scale, velocity and competitive position.",
    "fields": [
      "category_l1",
      "category_l2",
      "brand_name",
      "brand_tier (T1/T2/T3)",
      "estimated_market_share",
      "active_on_competitors",
      "priority_to_onboard",
      "owner"
    ],
    "use": "Commercial team — populated once at the start of a new market launch; refreshed quarterly.",
    "milestones": [
      23
    ]
  },
  {
    "id": "commercial_vendors_template",
    "name": "Commercial Vendors Template",
    "summary": "Master vendor list capturing all suppliers in the market with their commercial profile and onboarding status.",
    "fields": [
      "vendor_name",
      "vendor_type (manufacturer/distributor)",
      "categories",
      "brands",
      "estimated_volume",
      "preferred_terms",
      "contact_poc",
      "le_code_status",
      "mpa_status",
      "agreement_status"
    ],
    "use": "Commercial team — the central source of truth for vendor onboarding through the launch.",
    "milestones": [
      24
    ]
  },
  {
    "id": "capacity_planning_reference",
    "name": "Capacity Planning reference",
    "summary": "Inbound/outbound capacity planning model for the warehouse and dark stores.",
    "fields": [
      "facility_type (WH/DS)",
      "sku_count",
      "inbound_volume_per_day",
      "outbound_volume_per_day",
      "manpower_required",
      "shift_pattern",
      "cold_chain_capacity"
    ],
    "use": "In-Stock + Fulfilment teams — built once at launch planning, refined as OPD ramp validates.",
    "milestones": [
      44
    ]
  }
];

// Tasks page view mode: 'milestones' (49 milestone rollups) or 'detailed' (all 159 raw tasks)
let TASK_VIEW_MODE = 'detailed';
let EXPANDED_MILESTONES = new Set();  // milestone ids currently expanded in milestone view


let ACTIVITY = [
  { ts: "today · 10:42", who: "Sid", what: "marked", target: "AOP", detail: "Complete" },
  { ts: "today · 09:30", who: "Fatima K.", what: "uploaded artifact to", target: "Fulfilment dynamics" },
  { ts: "yesterday · 17:10", who: "Ahmed R.", what: "started", target: "Vendor master sign-up" },
  { ts: "yesterday · 14:05", who: "Lina M.", what: "uploaded artifact to", target: "Understanding Logistics dynamics" },
  { ts: "2 days ago", who: "Sid", what: "created", target: "launch", detail: "Riyadh" },
];

let currentTaskId = null;
let currentTaskSource = 'task';

function deadlineToDate(dl) {
  if (!dl || !dl.startsWith("T-")) return null;
  const offset = parseInt(dl.replace("T-",""));
  if (isNaN(offset)) return null;
  const d = new Date(LAUNCH_DATE); d.setDate(d.getDate() - offset); return d;
}
function fmtDate(d) { return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : "—"; }
function daysUntil(d) { return Math.ceil((d - new Date()) / 86400000); }
function functionReadiness(fnName) {
  const ts = activeTasks().filter(t => t.function === fnName);
  const total = ts.reduce((s,t) => s + t.weight, 0);
  const done = ts.filter(t => t.status === "Complete").reduce((s,t) => s + t.weight, 0);
  return total ? Math.round((done / total) * 100) : 0;
}
function overallReadiness() {
  let num = 0, den = 0;
  FUNCTIONS.forEach(f => { const p = functionReadiness(f.name) / 100; num += p * f.weight; den += f.weight; });
  return den ? Math.round((num / den) * 100) : 0;
}
function statusPill(s) {
  const map = {
    "Complete":"bg-green-500/10 text-green-400 border border-green-500/20",
    "In Progress":"bg-blue-500/10 text-blue-400 border border-blue-500/20",
    "Pending Validation":"bg-amber-500/10 text-amber-400 border border-amber-500/20",
    "Not Started":"bg-neutral-800 text-neutral-400 border border-neutral-700"
  };
  return `<span class="pill ${map[s]||''}">${s}</span>`;
}
function priorityPill(p) {
  if (p === "High") return `<span class="pill bg-rose-500/10 text-rose-400 border border-rose-500/20">● High</span>`;
  if (p === "Medium") return `<span class="pill bg-amber-500/10 text-amber-400 border border-amber-500/20">● Med</span>`;
  return `<span class="pill bg-neutral-800 text-neutral-400 border border-neutral-700">● Low</span>`;
}


// ============================================================================
// ROLES & PERMISSIONS (B-mode: localStorage persistence, no backend)
// ============================================================================
// Roles available in the demo. Add more by extending this list.
//   - 'cbo' has read-only access to everything (no edit privileges)
//   - 'manager' has edit/add/delete within their own function
//   - 'viewer' is pure read-only (no upload, no status change either)
let ROLES = [
  { id: "sid",          name: "Sid",                role: "Super Admin",               fn: null,             initials: "SC", color: "bg-red-600" },
  { id: "asmadan",      name: "Angad",              role: "Super Admin",               fn: null,             initials: "AM", color: "bg-orange-600" },
  { id: "ali",          name: "Ali Kafil Hussain",  role: "Super Admin",               fn: null,             initials: "AK", color: "bg-violet-600" },
  { id: "saro",         name: "Saro",               role: "Commercial Manager",        fn: "Commercial",     initials: "SA", color: "bg-blue-600" },
  { id: "obaid",        name: "Obaid",              role: "Commercial Manager (Core)", fn: "Commercial",     initials: "OB", color: "bg-blue-600" },
  { id: "ahmed",        name: "Ahmed Sabri",        role: "Real Estate Manager",       fn: "Real Estate",    initials: "AS", color: "bg-red-500" },
  { id: "alok",         name: "Alok",               role: "Growth Manager",            fn: "Growth",         initials: "AL", color: "bg-pink-600" },
  { id: "sajni",        name: "Sajni",              role: "On-site Manager",           fn: "On-site",        initials: "SJ", color: "bg-red-500" },
  { id: "nishant",      name: "Nishant Yadav",      role: "Instock Manager",           fn: "Instock",        initials: "NY", color: "bg-cyan-600" },
  { id: "ziad",         name: "Ziad",               role: "Fulfilment Manager",        fn: "Fulfilment",     initials: "ZI", color: "bg-green-600" },
  { id: "gianluca",     name: "Gianluca",           role: "Logistics Manager",         fn: "Logistics",      initials: "GL", color: "bg-emerald-600" },
  { id: "thaman",       name: "Thaman",             role: "Pricing Manager",           fn: "Pricing",        initials: "TH", color: "bg-lime-600" },
  { id: "cherry",       name: "Cherry",             role: "Legal Manager",             fn: "Legal",          initials: "CH", color: "bg-yellow-600" },
  { id: "gopal",        name: "Gopal",              role: "Finance Manager",           fn: "Finance",        initials: "GO", color: "bg-indigo-600" },
  { id: "gopal-proc",   name: "Gopal",              role: "Procurement Manager",       fn: "Procurement",    initials: "GO", color: "bg-teal-600" },
  { id: "viewer",       name: "Viewer",             role: "Read-only",                 fn: null,             initials: "VW", color: "bg-neutral-700" },
];

const STORAGE_KEY = "noon_minutes_playbook_state_v3";
let CURRENT_USER_ID = "sid";

function currentUser() {
  return ROLES.find(r => r.id === CURRENT_USER_ID) || ROLES[0];
}
function isManager() {
  const u = currentUser();
  return u.role && u.role.toLowerCase().includes("manager");
}
// Auto-provisioned Day-0 leadership accounts. GM = full edit; the three function
// heads can edit tasks within their permsScope (Commercial Head extends to
// Pricing; Fulfilment Head extends to Logistics + Warehouse).
function isDay0Lead() { return !!currentUser()._day0Created; }
// Users who are allowed to set/change the function on a task (i.e. not locked
// to a single function). Owner (CBO) and GM both qualify.
function canSetAnyFunction() {
  const u = currentUser();
  if (isOwner()) return true;
  if (isDay0Lead() && u.permsScope === "all") return true; // GM
  return false;
}
function _day0LeadEditableFunctions(scope) {
  switch (scope) {
    case "all":          return null; // null sentinel = anything goes
    case "commercial":   return ["Commercial", "Pricing"];
    case "realestate":   return ["Real Estate"];
    case "fulfilment":   return ["Fulfilment", "Logistics", "Warehouse"];
    default:             return [];
  }
}
function canEditTask(task) {
  const u = currentUser();
  if (!task) return false;
  // Owner (CBO) can edit any task
  if (isOwner()) return true;
  // GM (Day-0 created) can edit anything in their scope
  if (isDay0Lead()) {
    const allowed = _day0LeadEditableFunctions(u.permsScope);
    if (allowed === null) return true;
    return allowed.includes(task.function);
  }
  // Managers can only edit tasks in their own function
  if (isManager()) return task.function === u.fn;
  return false;  // Group CBO, Viewer cannot edit task content
}
function canAddTask() {
  // Owner (CBO) + Managers + Day-0 leadership can add tasks.
  // Managers/Day-0 leads get their function locked to their scope; the owner can pick any function.
  return isOwner() || isManager() || isDay0Lead();
}
function canDeleteTask(task) {
  return canEditTask(task);  // same permission as edit
}

// ----- Persistence ----------------------------------------------------------
// Derive the absolute LAUNCH_DATE from the Day-0 anchor. T-90 == the day Day 0
// was called; launch (T-0) is 90 days later. Pre-Day-0 it's a rolling placeholder.
// This must run on every load so the launch date (and every T-N deadline) is
// consistent across reloads and across users — it's no longer a transient global.
function _recomputeLaunchDate() {
  if (LAUNCH_STATE === "active" && DAY0_CALLED_AT) {
    const d0 = new Date(DAY0_CALLED_AT);
    LAUNCH_DATE = new Date(d0); LAUNCH_DATE.setDate(LAUNCH_DATE.getDate() + 90);
  } else {
    LAUNCH_DATE = new Date(); LAUNCH_DATE.setDate(LAUNCH_DATE.getDate() + 90);
  }
}

// Write the live-computed readiness for the active market back into MARKETS_DATA
// so it's persisted and every user sees the current number on the market cards.
function _syncActiveMarketReadiness() {
  const m = MARKETS_DATA.find(x => x.id === ACTIVE_MARKET_ID);
  if (!m) return;
  m.readiness = (typeof overallReadiness === "function") ? overallReadiness() : (m.readiness || 0);
  m.day0CalledAt = DAY0_CALLED_AT || null;   // surface Day 0 date on the market card
}

let _saveTimer = null;
function saveState() {
  _syncActiveMarketReadiness();
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    currentUserId: CURRENT_USER_ID,
    tasks: TASKS,
    milestones: MILESTONES,
    activity: ACTIVITY.slice(0, 50),
    launchState: LAUNCH_STATE,
    day0CalledAt: DAY0_CALLED_AT,
    day0Values: DAY0_VALUES,
    day0Roles: ROLES.filter(r => r._day0Created),
    marketsData: MARKETS_DATA,
    userRegistry: USER_REGISTRY,
    activeMarketId: ACTIVE_MARKET_ID,
  };
  // Keep localStorage as instant local fallback
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch(e) {}
  // Debounce Supabase writes to avoid hammering on rapid changes
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      await _sb.from("market_state").upsert({
        id: ACTIVE_MARKET_ID || "default",
        state: payload,
        updated_at: new Date().toISOString(),
        updated_by: CURRENT_USER_ID,
      });
    } catch(e) { console.warn("Supabase save failed:", e); }
  }, 800);
}

function _applyPayload(payload) {
  if (payload.tasks && Array.isArray(payload.tasks)) TASKS = payload.tasks;
  if (payload.milestones && Array.isArray(payload.milestones)) MILESTONES = payload.milestones;
  if (payload.activity && Array.isArray(payload.activity)) ACTIVITY = payload.activity;
  // currentUserId is owned by the session (ignition_session) — never restore from shared state
  if (payload.launchState) LAUNCH_STATE = payload.launchState;
  if (payload.day0CalledAt) DAY0_CALLED_AT = payload.day0CalledAt;
  if (payload.day0Values) DAY0_VALUES = payload.day0Values;
  if (payload.day0Roles && Array.isArray(payload.day0Roles)) {
    ROLES = ROLES.filter(r => !r._day0Created).concat(payload.day0Roles);
  }
  if (payload.marketsData && Array.isArray(payload.marketsData)) MARKETS_DATA = payload.marketsData;
  if (payload.userRegistry && Array.isArray(payload.userRegistry)) {
    USER_REGISTRY = payload.userRegistry;
    // Keep ROLES in sync so currentUser() can find every registered user
    USER_REGISTRY.forEach(u => {
      if (!ROLES.find(r => r.id === u.id)) ROLES.push({ id: u.id, name: u.name, role: u.role, fn: u.fn, initials: u.initials, color: u.color });
    });
  }
  if (payload.activeMarketId) ACTIVE_MARKET_ID = payload.activeMarketId;
  // Re-anchor the absolute launch date from the persisted Day-0 timestamp so
  // every T-N deadline resolves correctly after a reload / for other users.
  _recomputeLaunchDate();
}

async function loadState() {
  // Load localStorage first as a quick seed
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { _applyPayload(JSON.parse(raw)); }
  } catch(e) {}
  // Await Supabase so boot doesn't render until real data is ready
  try {
    const marketId = ACTIVE_MARKET_ID || "default";
    const { data, error } = await _sb.from("market_state").select("state").eq("id", marketId).single();
    if (!error && data) _applyPayload(data.state);
  } catch(e) { console.warn("Supabase load failed:", e); }
  return true;
}

// Fetch every market's own stored readiness/state from its Supabase row and
// patch the in-memory MARKETS_DATA so the Launch Control grid shows live, accurate
// numbers for ALL markets (not just the one currently loaded). Each market's true
// readiness lives in its own row's marketsData[self].readiness.
async function syncAllMarketReadiness() {
  try {
    const { data, error } = await _sb.from("market_state").select("id,state");
    if (error || !data) return;
    data.forEach(row => {
      const st = row.state || {};
      const localM = MARKETS_DATA.find(m => m.id === row.id);
      if (!localM) return;
      // Prefer the market's own copy of itself inside its row
      const selfInRow = Array.isArray(st.marketsData) ? st.marketsData.find(m => m.id === row.id) : null;
      if (selfInRow && typeof selfInRow.readiness === "number") localM.readiness = selfInRow.readiness;
      if (selfInRow && selfInRow.state) localM.state = selfInRow.state;
      if (selfInRow && selfInRow.launchDate) localM.launchDate = selfInRow.launchDate;
      // Day-0 timestamp lives at the top level of each market's state blob
      if (st.day0CalledAt) localM.day0CalledAt = st.day0CalledAt;
    });
    if (typeof renderLCMarketsGrid === "function") renderLCMarketsGrid();
    if (typeof renderMarketStatusGrid === "function") renderMarketStatusGrid();
  } catch(e) { console.warn("syncAllMarketReadiness failed:", e); }
}

// Real-time: re-render whenever another user saves state for the active market
_sb.channel("market_state_changes")
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "market_state" }, (payload) => {
    if (payload.new && payload.new.id === (ACTIVE_MARKET_ID || "default") && payload.new.updated_by !== CURRENT_USER_ID) {
      _applyPayload(payload.new.state);
      typeof refresh === "function" && refresh();
    }
  })
  .subscribe();

function resetState() {
  if (!confirm("Reset all changes? This will reload the page and clear edits, status changes and activity history.")) return;
  localStorage.removeItem(STORAGE_KEY);
  (async () => {
    try { await _sb.from("market_state").delete().eq("id", ACTIVE_MARKET_ID || "default"); } catch(e) {}
    location.reload();
  })();
}
function exportState() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: currentUser().name,
    tasks: TASKS,
    activity: ACTIVITY,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date().toISOString().slice(0, 10);
  a.download = "playbook-state-" + ts + ".json";
  a.click();
  URL.revokeObjectURL(url);
  toast("✓ Exported playbook state");
}
function importState(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const payload = JSON.parse(e.target.result);
      if (!payload.tasks || !Array.isArray(payload.tasks)) throw new Error("Invalid format");
      if (!confirm("Import will replace all current tasks and activity in this browser with " + payload.tasks.length + " tasks. Continue?")) return;
      TASKS = payload.tasks;
      ACTIVITY = payload.activity || [];
      saveState();
      refreshUserUI();
      refresh();
      toast("✓ Imported " + payload.tasks.length + " tasks");
    } catch (err) {
      alert("Could not import: " + err.message);
    } finally {
      evt.target.value = "";  // allow re-import of same file
    }
  };
  reader.readAsText(file);
}

// Tasks that are implicit prerequisites of Day 0: when the gate is called,
// these are auto-marked Complete because the gate confirms them. On reset they
// revert to Not Started.
const DAY0_PREREQUISITE_TASK_IDS = [1, 2, 3];

// When Day 0 is called, an account is auto-created for each of these four
// roles using the email provided on the gate. On reset, the created accounts
// are removed.
const DAY0_USER_TEMPLATES = {
  gm:          { roleLabel: "GM",                       fn: null,         color: "bg-red-600",    permsScope: "all"        },
  commercial:  { roleLabel: "Head of Commercial",       fn: "Commercial", color: "bg-blue-600",   permsScope: "commercial" },
  realestate:  { roleLabel: "Head of Real Estate",      fn: "Real Estate",color: "bg-red-500",    permsScope: "realestate" },
  fulfilment:  { roleLabel: "Head of Fulfilment",       fn: "Fulfilment", color: "bg-green-600",  permsScope: "fulfilment" },
};

function _nameFromEmail(email) {
  const local = (email || "").split("@")[0] || "";
  return local
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase()) || "User";
}
function _initialsFromName(name) {
  const parts = (name || "").trim().split(/\s+/);
  if (!parts.length || !parts[0]) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}





// ============================================================================
// FEATURE 1, 2, 3: MARKETS, ACCESS MANAGEMENT & GMAIL LOGIN
// ============================================================================

// ─── Data ───────────────────────────────────────────────────────────────────
// MARKETS: each market has id, name, code, launchDate, launchState, tasks, etc.
let MARKETS_DATA = [
  { id: "uae",  name: "UAE",     code: "AE", launchDate: null, state: "active",   optionalRoles: [], readiness: 87 },
  { id: "ksa",  name: "KSA",     code: "SA", launchDate: null, state: "active",   optionalRoles: [], readiness: 72 },
  { id: "egypt",name: "Egypt",   code: "EG", launchDate: null, state: "pre_day0", optionalRoles: ["On-site Manager"], readiness: 34 },
];

// USER_REGISTRY: the canonical email→user mapping.
// markets: array of market ids this user can access.
let USER_REGISTRY = [
  { id: "sid",      name: "Sid",              email: "schoudhary@noon.com", role: "Super Admin",        fn: null,          markets: ["uae","ksa","egypt"], initials: "SC", color: "bg-red-600" },
  { id: "ali",      name: "Ali Kafil Hussain",email: "akh@noon.com",        role: "Super Admin",        fn: null,          markets: ["uae","ksa","egypt"], initials: "AK", color: "bg-violet-600" },
  { id: "saro",     name: "Saro",             email: "saro@noon.com",     role: "Commercial Manager", fn: "Commercial",  markets: ["uae","ksa"],         initials: "SA", color: "bg-blue-600" },
  { id: "obaid",    name: "Obaid",            email: "obaid@noon.com",    role: "Commercial Manager", fn: "Commercial",  markets: ["uae"],                initials: "OB", color: "bg-blue-600" },
  { id: "ahmed",    name: "Ahmed Sabri",      email: "ahmed@noon.com",    role: "Real Estate Manager",fn: "Real Estate", markets: ["uae"],                initials: "AS", color: "bg-red-500" },
  { id: "alok",     name: "Alok",             email: "alok@noon.com",     role: "Growth Manager",     fn: "Growth",      markets: ["ksa"],                initials: "AL", color: "bg-pink-600" },
  { id: "sajni",    name: "Sajni",            email: "sajni@noon.com",    role: "On-site Manager",    fn: "On-site",     markets: ["uae"],                initials: "SJ", color: "bg-red-500" },
  { id: "nishant",  name: "Nishant Yadav",    email: "nishant@noon.com",  role: "Instock Manager",    fn: "Instock",     markets: ["uae"],                initials: "NY", color: "bg-cyan-600" },
  { id: "ziad",     name: "Ziad",             email: "ziad@noon.com",     role: "Fulfilment Manager", fn: "Fulfilment",  markets: ["ksa"],                initials: "ZI", color: "bg-green-600" },
  { id: "gianluca", name: "Gianluca",         email: "gianluca@noon.com", role: "Logistics Manager",  fn: "Logistics",   markets: ["ksa"],                initials: "GL", color: "bg-emerald-600" },
  { id: "thaman",   name: "Thaman",           email: "thaman@noon.com",   role: "Pricing Manager",    fn: "Pricing",     markets: ["uae"],                initials: "TH", color: "bg-lime-600" },
  { id: "cherry",   name: "Cherry",           email: "cherry@noon.com",   role: "Legal Manager",      fn: "Legal",       markets: ["uae"],                initials: "CH", color: "bg-yellow-600" },
  { id: "gopal",    name: "Gopal",            email: "gopal@noon.com",    role: "Finance Manager",    fn: "Finance",     markets: ["uae","ksa"],          initials: "GO", color: "bg-indigo-600" },
  { id: "viewer",   name: "Viewer",           email: "viewer@noon.com",   role: "Read-only",          fn: null,          markets: ["uae"],                initials: "VW", color: "bg-neutral-700" },
  { id: "asmadan",  name: "Angad",            email: "asmadan@noon.com",  role: "Super Admin",         fn: null,          markets: ["uae","ksa","egypt"], initials: "AM", color: "bg-orange-600" },
];

// Currently selected market context (for single-market users, auto-selected)
let ACTIVE_MARKET_ID = "uae";

// Login state
let IS_LOGGED_IN = false;
let LOGGED_IN_EMAIL = null;

// Editing target for user access modal
let _editingUserId = null;

// ─── Role helpers ────────────────────────────────────────────────────────────
function userFromRegistry(userId) { return USER_REGISTRY.find(u => u.id === userId); }
// isSuperAdmin and SUPER_ADMIN_IDS defined earlier near isOwner
function isGlobalRole(role) { return ["Super Admin","CBO","Group CBO","Admin","Master Admin"].includes(role); }
function canManageAccess() { return isLaunchControl(CURRENT_USER_ID); }

function userMarketsVisible() {
  const u = userFromRegistry(CURRENT_USER_ID);
  if (!u) return MARKETS_DATA;
  if (isSuperAdmin(CURRENT_USER_ID)) return MARKETS_DATA;
  return MARKETS_DATA.filter(m => u.markets.includes(m.id));
}

// ─── Feature 2: Gmail / Email Login ─────────────────────────────────────────
function showLoginScreen() {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  const loader = document.getElementById("view-loader");
  if (loader) { loader.classList.remove("active"); loader.style.opacity = ""; }
  const ls = document.getElementById("view-login");
  if (ls) ls.classList.remove("hidden");
  document.getElementById("top-nav").style.display = "none";
  const mbn = document.getElementById("mobile-bottom-nav");
  if (mbn) mbn.style.display = "none";
  setTimeout(() => { const e = document.getElementById("login-email"); if(e) e.focus(); }, 100);
}

// ─── Passwords (plaintext — prototype) ───────────────────────────────────────
const USER_PASSWORDS = { "master@ignition.com": "M!aster" };
const DEFAULT_NOON_PASSWORD = "noon2026";

function togglePasswordVisibility() {
  const input = document.getElementById("login-password");
  const icon  = document.getElementById("pw-eye-icon");
  if (!input) return;
  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  icon.innerHTML = isHidden
    ? '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'
    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
}

// ── Access Requests store ────────────────────────────────────────────────────
let ACCESS_REQUESTS = []; // { id, email, name, market, role, ts, status: 'pending'|'granted'|'denied' }

function saveAccessRequests() {
  // No-op: individual request saves happen via saveAccessRequest()
}
async function saveAccessRequest(req) {
  try {
    await _sb.from("access_requests").upsert({
      id: req.id,
      email: req.email,
      name: req.name,
      market: req.market || null,
      market_name: req.marketName || (MARKETS_DATA.find(m => m.id === req.market)?.name) || req.market || null,
      role: req.role || null,
      status: req.status || "pending",
    });
  } catch(e) { console.warn("Supabase access_requests save failed:", e); }
}
function loadAccessRequests() {
  (async () => {
    try {
      const { data, error } = await _sb.from("access_requests").select("*").order("created_at", { ascending: false });
      if (error || !data) return;
      ACCESS_REQUESTS = data.map(r => ({
        id: r.id, email: r.email, name: r.name,
        market: r.market,
        marketName: r.market_name || MARKETS_DATA.find(m => m.id === r.market)?.name || r.market,
        role: r.role, status: r.status,
        ts: r.created_at,
      }));
      typeof renderAccessRequests === "function" && renderAccessRequests();
      typeof renderManageAccess === "function" && renderManageAccess();
    } catch(e) { console.warn("Supabase access_requests load failed:", e); }
  })();
}

// Real-time: notify LC instantly when a new access request comes in
_sb.channel("access_requests_changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "access_requests" }, () => {
    loadAccessRequests();
  })
  .subscribe();

function loginAsGuest(email) {
  IS_LOGGED_IN = true;
  LOGGED_IN_EMAIL = email;
  CURRENT_USER_ID = "__guest__";
  // Synthesise a transient guest entry (not saved to USER_REGISTRY)
  window.__GUEST_EMAIL__ = email;
  const firstName = email.split("@")[0].split(".")[0];
  const displayName = firstName.charAt(0).toUpperCase() + firstName.slice(1);
  window.__GUEST_NAME__ = displayName;

  document.getElementById("view-login").classList.add("hidden");
  showLoader(displayName, function() {
    document.getElementById("top-nav").style.display = "none"; // no top nav for guests
    const mbn = document.getElementById("mobile-bottom-nav");
    if (mbn) mbn.style.display = "none";
    showSeekAccessView();
  });
}

const AUTH0_DOMAIN    = "dev-vaja32qf7o1yfzhg.us.auth0.com";
const AUTH0_CLIENT_ID = "JRrJFLZKCYipLUYC9CIClLeBmFuwWvax";
const AUTH0_REDIRECT  = "https://ignition-a-production.up.railway.app";

let auth0Client = null;

async function getAuth0Client() {
  if (auth0Client) return auth0Client;
  auth0Client = await window.auth0.createAuth0Client({
    domain:    AUTH0_DOMAIN,
    clientId:  AUTH0_CLIENT_ID,
    authorizationParams: {
      redirect_uri: AUTH0_REDIRECT,
      connection:   "google-oauth2",
    },
    cacheLocation: "localstorage",
  });
  return auth0Client;
}

async function triggerGoogleLogin() {
  try {
    const client = await getAuth0Client();
    await client.loginWithRedirect({
      authorizationParams: {
        connection:   "google-oauth2",
        redirect_uri: AUTH0_REDIRECT,
      }
    });
  } catch (e) {
    console.error("Auth0 login error:", e);
    const errEl = document.getElementById("login-error");
    if (errEl) {
      errEl.textContent = "Google Sign-In failed. Try again or use email/password below.";
      errEl.style.display = "block";
      setTimeout(() => errEl.style.display = "none", 5000);
    }
  }
}

// Handle Auth0 redirect callback on page load
async function handleAuth0Callback() {
  // Only run if there's a code+state in the URL (Auth0 redirect)
  const params = new URLSearchParams(window.location.search);
  if (!params.has("code") && !params.has("state")) return false;

  try {
    const client = await getAuth0Client();
    await client.handleRedirectCallback();
    // Clean URL
    window.history.replaceState({}, document.title, AUTH0_REDIRECT);

    const user = await client.getUser();
    if (!user || !user.email) return false;

    const email = user.email.toLowerCase();
    // Map Auth0 user to registry
    const regUser = USER_REGISTRY.find(u => u.email === email);
    if (regUser) {
      loginAs(regUser.id, email);
    } else {
      // Not in registry — guest/seek-access flow
      loginAsGuest(email);
    }
    return true;
  } catch (e) {
    console.error("Auth0 callback error:", e);
    // Bad callback — clean URL and show login
    window.history.replaceState({}, document.title, AUTH0_REDIRECT);
    return false;
  }
}

function attemptLogin() {
  const emailEl = document.getElementById("login-email");
  const pwEl    = document.getElementById("login-password");
  const errEl   = document.getElementById("login-error");
  const email   = (emailEl && emailEl.value || "").trim().toLowerCase();
  const password = (pwEl && pwEl.value || "");
  errEl.style.display = "none";

  if (!email)    { errEl.textContent = "Please enter your email address."; errEl.style.display = "block"; return; }
  if (!password) { errEl.textContent = "Please enter your password.";      errEl.style.display = "block"; return; }

  // Master admin
  if (email === "master@ignition.com") {
    if (password !== USER_PASSWORDS["master@ignition.com"]) {
      errEl.textContent = "Incorrect password."; errEl.style.display = "block"; return;
    }
    const master = USER_REGISTRY.find(u => u.id === "master");
    if (master) { loginAs(master.id, email); return; }
  }

  // Non-noon emails get guest view-only access too
  if (!email.endsWith("@noon.com")) {
    if (!email.includes("@") || !email.includes(".")) {
      errEl.textContent = "Please enter a valid email address.";
      errEl.style.display = "block"; return;
    }
    loginAsGuest(email);
    return;
  }

  const user = USER_REGISTRY.find(u => u.email === email);
  if (!user) {
    // Unknown noon.com user — grant view-only access and prompt them to request
    loginAsGuest(email);
    return;
  }

  const expectedPw = USER_PASSWORDS[email] || DEFAULT_NOON_PASSWORD;
  if (password !== expectedPw) {
    errEl.textContent = "Incorrect password."; errEl.style.display = "block"; return;
  }

  loginAs(user.id, email);
}

function loginAs(userId, email) {
  IS_LOGGED_IN = true;
  LOGGED_IN_EMAIL = email;
  CURRENT_USER_ID = userId;
  try { localStorage.setItem("ignition_session", JSON.stringify({ userId, email })); } catch(e) {}
  saveState();

  // Hide login screen
  document.getElementById("view-login").classList.add("hidden");

  // Show loader
  const user = userFromRegistry(userId);
  const firstName = (user && user.name) ? user.name.split(" ")[0] : "there";
  showLoader(firstName, function() {
    // After loader completes — reveal the app
    document.getElementById("top-nav").style.display = "";
    const mbn = document.getElementById("mobile-bottom-nav");
    if (mbn) mbn.style.display = "";
    refreshUserUI();
    applyMarketsNavVisibility();
    const visible = userMarketsVisible();
    if (visible.length > 0) ACTIVE_MARKET_ID = visible[0].id;
    refresh();
    applyLaunchStateUI();
    navigate("dashboard");
    syncMobileNav("dashboard");
    applyLCDashboard();
  });
}

function signOut() {
  IS_LOGGED_IN = false;
  LOGGED_IN_EMAIL = null;
  CURRENT_USER_ID = "sid";
  try { localStorage.removeItem("ignition_session"); } catch(e) {}
  window.__GUEST_EMAIL__ = null;
  window.__GUEST_NAME__ = null;
  localStorage.removeItem(STORAGE_KEY);
  const sa = document.getElementById("view-seek-access");
  if (sa) sa.style.display = "none";
  document.getElementById("top-nav").style.display = "none";
  const mbn = document.getElementById("mobile-bottom-nav");
  if (mbn) mbn.style.display = "none";
  showLoginScreen();
}

async function bootWithAuth() {
  await loadState();
  loadAccessRequests();
  // Ensure master account always exists
  if (!USER_REGISTRY.find(u => u.id === "master")) {
    USER_REGISTRY.push({ id: "master", name: "Master Admin", email: "master@ignition.com", role: "Super Admin", fn: null, markets: MARKETS_DATA.map(m => m.id), initials: "MA", color: "bg-orange-500" });
  }
  // Restore session from persisted state
  const savedSession = (() => { try { return JSON.parse(localStorage.getItem("ignition_session")); } catch(e) { return null; } })();
  if (savedSession && savedSession.userId && savedSession.email) {
    IS_LOGGED_IN = true;
    LOGGED_IN_EMAIL = savedSession.email;
    CURRENT_USER_ID = savedSession.userId;
  } else {
    IS_LOGGED_IN = false;
    LOGGED_IN_EMAIL = null;
  }

  // Sync USER_REGISTRY into ROLES
  USER_REGISTRY.forEach(u => {
    if (!ROLES.find(r => r.id === u.id)) ROLES.push({ id: u.id, name: u.name, role: u.role, fn: u.fn, initials: u.initials, color: u.color });
  });

  // Check if this is an Auth0 redirect callback — if so, handle it and skip login screen
  const handledCallback = await handleAuth0Callback();
  if (!handledCallback) {
    if (IS_LOGGED_IN) {
      document.getElementById("view-login").classList.add("hidden");
      document.getElementById("top-nav").style.display = "";
      const mbn = document.getElementById("mobile-bottom-nav");
      if (mbn) mbn.style.display = "";
      refreshUserUI();
      navigate("dashboard");
    } else {
      showLoginScreen();
    }
  }
  // Remove boot overlay now that the correct view is shown
  const overlay = document.getElementById("boot-overlay");
  if (overlay) {
    overlay.style.opacity = "0";
    setTimeout(() => overlay.remove(), 300);
  }
}



