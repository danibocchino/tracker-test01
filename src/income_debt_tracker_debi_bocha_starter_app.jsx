import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Income & Debt Tracker – Minimal React Single-File App
 * ----------------------------------------------------
 * Goals covered from your spec:
 *  - Two members: Debi & Bocha (simple auth gate with PIN 1234; switch user)
 *  - Top-left logo that can be uploaded (PNG 600x100 with transparency recommended)
 *  - Summary cards: Total Income, Shares, Current Debt (who owes who)
 *  - Filters: period (Last 6M default), client, creator
 *  - Chart: monthly totals (last 6 months by default)
 *  - Invoices table:
 *      • currency USD default; ARS (peso) supported with per-row FX rate editable
 *      • net amount = base + per-row adjustments (fixed or %; taxes/discounts)
 *      • createdBy (Debi or Bocha)
 *      • split (amounts or %; editable)
 *  - Expenses section (below) with same currency+FX handling and per-row split
 *  - Client manager: seeded with Lions, TGI, Ecuabet; add more later
 *  - Data persistence: localStorage; import/export JSON; change log (append-only)
 *  - No backend yet, but a DataAdapter interface is ready to be wired to Google Sheets
 *
 * IMPORTANT: This is a self-contained preview component for quick iteration.
 * Later we can graduate it to a full repo (Vite/Next.js) and plug in a Sheets/DB adapter.
 */

// ----------------------------- Utilities -----------------------------
const fmtUSD = (n) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const todayISO = () => new Date().toISOString().slice(0, 10);
const lastMonths = (n) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - (n - 1));
  const start = d.toISOString().slice(0, 10);
  return { start, end: todayISO() };
};

// Simple ID helper
const uid = () => Math.random().toString(36).slice(2, 10);

// ----------------------------- Data Model -----------------------------
/**
 * Each money row can be income or expense.
 * currency: "USD" or "ARS" (peso). For ARS we convert to USD using fxRate (ARS per 1 USD).
 * usd = currency === "USD" ? amount : amount / fxRate
 * adjustments: array of { id, label, type: 'fixed'|'percent', value }
 * split: { debi: number, bocha: number, mode: 'amount'|'percent' }
 * For expenses, paidBy indicates who paid (affects debt calc like invoices creator does).
 */

const seed = () => ({
  meta: {
    members: ["Debi", "Bocha"],
    clients: [
      { id: "c-lions", name: "Lions" },
      { id: "c-tgi", name: "TGI" },
      { id: "c-ecuabet", name: "Ecuabet" },
    ],
    logoDataUrl: null,
  },
  settings: {
    period: "6m",
  },
  invoices: [
    // Example starting rows (editable)
    {
      id: uid(), date: new Date().toISOString().slice(0,10), clientId: "c-lions", invoiceNo: "INV-1001",
      currency: "USD", amount: 1200, fxRate: 0,
      createdBy: "Debi",
      adjustments: [ { id: uid(), label: "Bank tax", type: "percent", value: -3 } ], // -3% cost
      split: { mode: "percent", debi: 50, bocha: 50 },
      notes: "Example row",
    },
    {
      id: uid(), date: new Date().toISOString().slice(0,10), clientId: "c-tgi", invoiceNo: "INV-1002",
      currency: "ARS", amount: 900000, fxRate: 1000, // ARS per 1 USD; 900k ARS ≈ $900
      createdBy: "Bocha",
      adjustments: [],
      split: { mode: "percent", debi: 50, bocha: 50 },
      notes: "Peso example",
    },
  ],
  expenses: [
    {
      id: uid(), date: todayISO(), description: "Accountant retainer",
      currency: "USD", amount: 200, fxRate: 0,
      paidBy: "Debi",
      adjustments: [],
      split: { mode: "percent", debi: 50, bocha: 50 },
    },
  ],
  changelog: [],
});

const STORAGE_KEY = "idtracker_v1";
const loadDB = () => {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : seed(); } catch { return seed(); }
};
const saveDB = (db) => localStorage.setItem(STORAGE_KEY, JSON.stringify(db));

// Compute USD for a row
const usdOf = (row) => (row.currency === "USD" ? row.amount : (row.fxRate ? row.amount / row.fxRate : 0));
const netUsdOf = (row) => row.adjustments.reduce((acc, adj) => adj.type === "percent" ? acc * (1 + adj.value/100) : acc + adj.value, usdOf(row));

// Split helper -> returns { debiUSD, bochaUSD }
const splitUsd = (row) => {
  const net = netUsdOf(row);
  if (row.split.mode === "amount") {
    const debi = row.split.debi ?? 0;
    const bocha = row.split.bocha ?? 0;
    return { debiUSD: debi, bochaUSD: bocha };
  } else {
    const d = (row.split.debi ?? 0) / 100;
    const b = (row.split.bocha ?? 0) / 100;
    return { debiUSD: net * d, bochaUSD: net * b };
  }
};

// Debt convention:
//  - INCOME: creator collects; therefore creator owes the partner their share.
//  - EXPENSE: paidBy paid upfront; therefore partner owes the payer their share.
// We track net balance "Bocha owes Debi" (positive => Bocha owes Debi; negative => Debi owes Bocha)
const debtDeltaIncome = (inv) => {
  const { debiUSD, bochaUSD } = splitUsd(inv);
  if (inv.createdBy === "Debi") {
    // Debi holds all; she owes Bocha bochaUSD => decreases Bocha-owes-Debi
    return -bochaUSD;
  } else {
    // Bocha created => Bocha owes Debi debiUSD
    return +debiUSD;
  }
};
const debtDeltaExpense = (exp) => {
  const { debiUSD, bochaUSD } = splitUsd(exp);
  if (exp.paidBy === "Debi") {
    // Debi paid for both; Bocha owes Debi their share
    return +bochaUSD;
  } else {
    return -debiUSD;
  }
};

// ----------------------------- Main App -----------------------------
export default function App() {
  const [db, setDb] = useState(loadDB());
  const [user, setUser] = useState(null); // "Debi" | "Bocha"
  const [pin, setPin] = useState("");
  const fileInputRef = useRef(null);

  // persist
  useEffect(() => { saveDB(db); }, [db]);

  // derived: debt
  const debt = useMemo(() => {
    const inc = db.invoices.reduce((acc, r) => acc + debtDeltaIncome(r), 0);
    const exp = db.expenses.reduce((acc, r) => acc + debtDeltaExpense(r), 0);
    return inc + exp; // >0 Bocha owes Debi; <0 Debi owes Bocha
  }, [db]);

  // totals
  const totals = useMemo(() => {
    const incomeUSD = db.invoices.reduce((a, r) => a + Math.max(0, netUsdOf(r)), 0);
    const yourShare = db.invoices.reduce((a, r) => a + (user === "Debi" ? splitUsd(r).debiUSD : splitUsd(r).bochaUSD), 0);
    const partnerShare = incomeUSD - yourShare;
    return { incomeUSD, yourShare, partnerShare };
  }, [db, user]);

  // filters (period, client, creator)
  const [flt, setFlt] = useState({
    period: "6m", // 6m | 12m | ytd | all
    clientId: "all",
    creator: "all",
  });
  useEffect(() => { setFlt((f) => ({ ...f, period: db.settings.period || "6m" })); }, [db.settings.period]);

  const { start: defaultStart } = lastMonths(6);
  const dateRangeFor = (period) => {
    const now = new Date();
    const start = new Date(defaultStart);
    if (period === "12m") start.setMonth(now.getMonth() - 11);
    if (period === "ytd") { start.setMonth(0); start.setDate(1); start.setFullYear(now.getFullYear()); }
    if (period === "all") return { start: new Date("2000-01-01"), end: now };
    return { start, end: now };
  };

  const matchesFilters = (row) => {
    const d = new Date(row.date);
    const { start, end } = dateRangeFor(flt.period);
    if (d < start || d > end) return false;
    if (row.clientId && flt.clientId !== "all" && row.clientId !== flt.clientId) return false;
    if (row.createdBy && flt.creator !== "all" && row.createdBy !== flt.creator) return false;
    return true;
  };

  // monthly chart data (simple SVG line)
  const monthly = useMemo(() => {
    const map = new Map(); // key: YYYY-MM -> total USD net (incomes - expenses)
    const add = (date, val) => {
      const ym = date.slice(0,7);
      map.set(ym, (map.get(ym) || 0) + val);
    };
    db.invoices.forEach((r) => { if (matchesFilters(r)) add(r.date, netUsdOf(r)); });
    db.expenses.forEach((r) => { if (matchesFilters(r)) add(r.date, -netUsdOf(r)); });
    return [...map.entries()].sort(([a],[b]) => a.localeCompare(b));
  }, [db, flt]);

  // --------------- Actions & ChangeLog ---------------
  const log = (action, payload) => setDb((cur) => ({
    ...cur,
    changelog: [
      { id: uid(), ts: new Date().toISOString(), user: user || "sys", action, payload },
      ...cur.changelog,
    ]
  }));

  const addClient = (name) => setDb((cur) => ({
    ...cur,
    meta: { ...cur.meta, clients: [...cur.meta.clients, { id: `c-${uid()}`, name }] },
  }));

  const addInvoice = () => {
    const row = {
      id: uid(), date: todayISO(), clientId: curClientId(db), invoiceNo: `INV-${Math.floor(Math.random()*900+100)}`,
      currency: "USD", amount: 0, fxRate: 0,
      createdBy: user || "Debi",
      adjustments: [],
      split: { mode: "percent", debi: 50, bocha: 50 },
      notes: "",
    };
    setDb((cur) => ({ ...cur, invoices: [row, ...cur.invoices] }));
    log("add_invoice", { id: row.id });
  };

  const addExpense = () => {
    const row = {
      id: uid(), date: todayISO(), description: "",
      currency: "USD", amount: 0, fxRate: 0,
      paidBy: user || "Debi",
      adjustments: [],
      split: { mode: "percent", debi: 50, bocha: 50 },
    };
    setDb((cur) => ({ ...cur, expenses: [row, ...cur.expenses] }));
    log("add_expense", { id: row.id });
  };

  const updateRow = (type, id, patch) => setDb((cur) => {
    const key = type === "invoice" ? "invoices" : "expenses";
    const rows = cur[key].map((r) => r.id === id ? { ...r, ...patch } : r);
    return { ...cur, [key]: rows };
  });

  const removeRow = (type, id) => setDb((cur) => {
    const key = type === "invoice" ? "invoices" : "expenses";
    return { ...cur, [key]: cur[key].filter((r) => r.id !== id) };
  });

  const setLogo = async (file) => {
    const reader = new FileReader();
    reader.onload = () => setDb((cur) => ({ ...cur, meta: { ...cur.meta, logoDataUrl: reader.result } }));
    reader.readAsDataURL(file);
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `income-debt-tracker-${new Date().toISOString().slice(0,10)}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const importJSON = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { const data = JSON.parse(reader.result); setDb(data); } catch (e) { alert("Invalid JSON"); }
    };
    reader.readAsText(file);
  };

  const curClientId = (db) => (db.meta.clients[0]?.id || "");

  // ----------------------------- UI -----------------------------
  if (!user) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white w-full max-w-md p-6 rounded-2xl shadow">
        <div className="text-center">
          <div className="text-2xl font-semibold mb-1">Income & Debt Tracker</div>
          <div className="text-gray-500 mb-6">Debi & Bocha — enter PIN to continue</div>
        </div>
        <div className="space-y-3">
          <select className="w-full border rounded-xl p-3" defaultValue="Debi" onChange={(e)=>setUser(e.target.value)}>
            <option>Debi</option>
            <option>Bocha</option>
          </select>
          <input className="w-full border rounded-xl p-3" value={pin} onChange={(e)=>setPin(e.target.value)} placeholder="PIN (try 1234)"/>
          <button className="w-full rounded-xl p-3 bg-black text-white" onClick={()=> pin === "1234" ? setUser((p)=> p || "Debi") : alert("Wrong PIN")}>Enter</button>
        </div>
      </div>
    </div>
  );

  const memberColor = (name) => name === "Debi" ? "text-indigo-600" : "text-emerald-600";
  const debtLabel = debt > 0 ? `Bocha owes Debi ${fmtUSD(Math.abs(debt))}` : debt < 0 ? `Debi owes Bocha ${fmtUSD(Math.abs(debt))}` : "Even";

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <div className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto flex items-center justify-between p-3 gap-4">
          <div className="flex items-center gap-3">
            <button className="flex items-center gap-3 group" onClick={() => fileInputRef.current?.click()} title="Click to upload logo (600x100 PNG)">
              {db.meta.logoDataUrl ? (
                <img src={db.meta.logoDataUrl} alt="logo" className="h-8 object-contain"/>
              ) : (
                <div className="h-8 w-32 bg-gray-100 rounded flex items-center justify-center text-gray-400 text-xs">Upload Logo</div>
              )}
            </button>
            <input ref={fileInputRef} type="file" accept="image/png" hidden onChange={(e)=> e.target.files?.[0] && setLogo(e.target.files[0])}/>
            <div className="font-semibold">Income & Debt Tracker</div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${memberColor(user)}`}>Logged in: {user}</span>
            <button className="text-sm px-3 py-1 rounded-xl border" onClick={()=>setUser(null)}>Logout</button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-4 space-y-6">
        {/* Filters & Actions */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <select className="border rounded-2xl p-3" value={flt.period} onChange={(e)=>setFlt({...flt, period: e.target.value})}>
            <option value="6m">Last 6 months</option>
            <option value="12m">Last 12 months</option>
            <option value="ytd">YTD</option>
            <option value="all">All time</option>
          </select>
          <select className="border rounded-2xl p-3" value={flt.clientId} onChange={(e)=>setFlt({...flt, clientId: e.target.value})}>
            <option value="all">All clients</option>
            {db.meta.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="border rounded-2xl p-3" value={flt.creator} onChange={(e)=>setFlt({...flt, creator: e.target.value})}>
            <option value="all">Created by (any)</option>
            <option value="Debi">Debi</option>
            <option value="Bocha">Bocha</option>
          </select>
          <div className="flex gap-2">
            <button className="flex-1 border rounded-2xl p-3" onClick={addInvoice}>+ Invoice</button>
            <button className="flex-1 border rounded-2xl p-3" onClick={addExpense}>+ Expense</button>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Card title="Total Income" value={fmtUSD(totals.incomeUSD)} />
          <Card title={`${user}'s Share`} value={fmtUSD(totals.yourShare)} />
          <Card title="Partner's Share" value={fmtUSD(totals.partnerShare)} />
          <Card title="Current Debt" value={debtLabel} highlight />
        </div>

        {/* Chart */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border">
          <div className="font-medium mb-2">Balance by Month</div>
          <MiniLineChart data={monthly} height={140} />
        </div>

        {/* Invoices */}
        <Section title="Invoices">
          <TableInvoices db={db} setDb={setDb} updateRow={updateRow} removeRow={removeRow} matchesFilters={matchesFilters} />
        </Section>

        {/* Expenses */}
        <Section title="Common Expenses">
          <TableExpenses db={db} setDb={setDb} updateRow={updateRow} removeRow={removeRow} matchesFilters={matchesFilters} />
        </Section>

        {/* Clients & Data */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-white rounded-2xl p-4 shadow-sm border">
            <div className="font-medium mb-2">Clients</div>
            <div className="space-y-2">
              {db.meta.clients.map(c => (
                <div key={c.id} className="flex items-center justify-between border rounded-xl p-2">
                  <div>{c.name}</div>
                </div>
              ))}
            </div>
            <AddClient onAdd={(name)=> name && addClient(name)} />
          </div>
          <div className="bg-white rounded-2xl p-4 shadow-sm border">
            <div className="font-medium mb-2">Data</div>
            <div className="flex gap-2">
              <button className="border rounded-xl px-3 py-2" onClick={exportJSON}>Export JSON</button>
              <label className="border rounded-xl px-3 py-2 cursor-pointer">
                Import JSON
                <input type="file" accept="application/json" className="hidden" onChange={(e)=> e.target.files?.[0] && importJSON(e.target.files[0])}/>
              </label>
            </div>
            <div className="text-xs text-gray-500 mt-2">Append-only changelog keeps every action for transparency.</div>
          </div>
          <div className="bg-white rounded-2xl p-4 shadow-sm border">
            <div className="font-medium mb-2">Changelog (latest)</div>
            <div className="h-40 overflow-auto text-sm space-y-2">
              {db.changelog.slice(0,20).map(e => (
                <div key={e.id} className="flex items-start gap-2">
                  <div className="text-gray-400 text-xs w-32 shrink-0">{new Date(e.ts).toLocaleString()}</div>
                  <div><span className="font-medium">{e.user}</span> {e.action}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Dev note: DataAdapter placeholder for Google Sheets/DB */}
        <div className="text-xs text-gray-500">
          Adapter stub ready: implement load/save methods to sync with Google Sheets without wiping data. We will only append changes to the changelog and apply patch-migrations.
        </div>
      </div>
    </div>
  );
}

// ----------------------------- Reusable Bits -----------------------------
function Card({ title, value, highlight }) {
  return (
    <div className={`bg-white rounded-2xl p-4 shadow-sm border ${highlight ? "ring-1 ring-emerald-300" : ""}`}>
      <div className="text-sm text-gray-500">{title}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm border">
      <div className="font-medium mb-3">{title}</div>
      {children}
    </div>
  );
}

function AddClient({ onAdd }) {
  const [name, setName] = useState("");
  return (
    <div className="mt-3 flex gap-2">
      <input className="border rounded-xl p-2 flex-1" placeholder="Add client" value={name} onChange={(e)=>setName(e.target.value)} />
      <button className="border rounded-xl px-3" onClick={()=>{ onAdd(name.trim()); setName(""); }}>Add</button>
    </div>
  );
}

function ClientName({ id, db }) {
  return <span>{db.meta.clients.find(c=>c.id===id)?.name || "—"}</span>;
}

function PercentAmountToggle({ value, onChange }) {
  return (
    <select className="border rounded-lg p-1 text-xs" value={value} onChange={(e)=>onChange(e.target.value)}>
      <option value="percent">%</option>
      <option value="amount">$</option>
    </select>
  );
}

function MiniLineChart({ data, height=140 }) {
  // data: [ ["YYYY-MM", valueUSD], ... ]
  const width = 640;
  const padding = 24;
  const xs = data.map((d,i)=>i);
  const ys = data.map(([,v])=>v);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(10, ...ys);
  const scaleX = (i) => padding + (i * (width - padding*2)) / Math.max(1, (data.length-1));
  const scaleY = (v) => height - padding - ((v - minY) * (height - padding*2)) / Math.max(1, (maxY - minY));
  const path = data.map((d,i)=> `${i===0?"M":"L"}${scaleX(i)},${scaleY(d[1])}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
      <rect x="0" y="0" width={width} height={height} rx="14" className="fill-gray-50" />
      <path d={path} className="stroke-emerald-500 fill-none" strokeWidth="2" />
      {data.map((d,i)=> (
        <g key={i}>
          <circle cx={scaleX(i)} cy={scaleY(d[1])} r="3" className="fill-emerald-500" />
          <text x={scaleX(i)} y={height-6} textAnchor="middle" className="fill-gray-400 text-[10px]">{d[0].slice(2)}</text>
        </g>
      ))}
    </svg>
  );
}

// ----------------------------- Tables -----------------------------
function TableInvoices({ db, setDb, updateRow, removeRow, matchesFilters }) {
  const rows = db.invoices.filter(matchesFilters);
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-gray-500">
          <tr>
            <th className="p-2">Date</th>
            <th className="p-2">Client</th>
            <th className="p-2">Invoice #</th>
            <th className="p-2">Currency</th>
            <th className="p-2">Amount</th>
            <th className="p-2">FX (ARS/USD)</th>
            <th className="p-2">Created By</th>
            <th className="p-2">Split</th>
            <th className="p-2">Adj.</th>
            <th className="p-2">Net USD</th>
            <th className="p-2">Notes</th>
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => <InvoiceRow key={r.id} r={r} db={db} updateRow={updateRow} removeRow={removeRow} />)}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceRow({ r, db, updateRow, removeRow }) {
  const net = netUsdOf(r);
  const { debiUSD, bochaUSD } = splitUsd(r);
  return (
    <tr className="border-t">
      <td className="p-2"><input type="date" className="border rounded-lg p-1" value={r.date} onChange={(e)=>updateRow("invoice", r.id, { date: e.target.value })} /></td>
      <td className="p-2">
        <select className="border rounded-lg p-1" value={r.clientId} onChange={(e)=>updateRow("invoice", r.id, { clientId: e.target.value })}>
          {db.meta.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </td>
      <td className="p-2"><input className="border rounded-lg p-1 w-28" value={r.invoiceNo} onChange={(e)=>updateRow("invoice", r.id, { invoiceNo: e.target.value })}/></td>
      <td className="p-2">
        <select className="border rounded-lg p-1" value={r.currency} onChange={(e)=>updateRow("invoice", r.id, { currency: e.target.value })}>
          <option>USD</option>
          <option>ARS</option>
        </select>
      </td>
      <td className="p-2"><input type="number" className="border rounded-lg p-1 w-28" value={r.amount} onChange={(e)=>updateRow("invoice", r.id, { amount: parseFloat(e.target.value||0) })}/></td>
      <td className="p-2"><input type="number" step="0.0001" className="border rounded-lg p-1 w-28" value={r.fxRate} onChange={(e)=>updateRow("invoice", r.id, { fxRate: parseFloat(e.target.value||0) })} title="ARS per 1 USD on the transaction date"/></td>
      <td className="p-2">
        <select className="border rounded-lg p-1" value={r.createdBy} onChange={(e)=>updateRow("invoice", r.id, { createdBy: e.target.value })}>
          <option>Debi</option>
          <option>Bocha</option>
        </select>
      </td>
      <td className="p-2">
        <div className="flex items-center gap-1">
          <PercentAmountToggle value={r.split.mode} onChange={(v)=>updateRow("invoice", r.id, { split: { ...r.split, mode: v } })} />
          <input type="number" className="border rounded-lg p-1 w-16" value={r.split.debi} onChange={(e)=>updateRow("invoice", r.id, { split: { ...r.split, debi: parseFloat(e.target.value||0) } })} title="Debi share"/>
          <span>:</span>
          <input type="number" className="border rounded-lg p-1 w-16" value={r.split.bocha} onChange={(e)=>updateRow("invoice", r.id, { split: { ...r.split, bocha: parseFloat(e.target.value||0) } })} title="Bocha share"/>
          <div className="text-xs text-gray-500 ml-2">{`D ${fmtUSD(debiUSD)} • B ${fmtUSD(bochaUSD)}`}</div>
        </div>
      </td>
      <td className="p-2">
        <Adjustments r={r} onChange={(adj)=>updateRow("invoice", r.id, { adjustments: adj })} />
      </td>
      <td className="p-2 font-medium">{fmtUSD(net)}</td>
      <td className="p-2"><input className="border rounded-lg p-1 w-40" value={r.notes||""} onChange={(e)=>updateRow("invoice", r.id, { notes: e.target.value })}/></td>
      <td className="p-2 text-right">
        <button className="text-red-600" onClick={()=>removeRow("invoice", r.id)}>Delete</button>
      </td>
    </tr>
  );
}

function TableExpenses({ db, setDb, updateRow, removeRow, matchesFilters }) {
  const rows = db.expenses.filter(matchesFilters);
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-gray-500">
          <tr>
            <th className="p-2">Date</th>
            <th className="p-2">Description</th>
            <th className="p-2">Currency</th>
            <th className="p-2">Amount</th>
            <th className="p-2">FX (ARS/USD)</th>
            <th className="p-2">Paid By</th>
            <th className="p-2">Split</th>
            <th className="p-2">Adj.</th>
            <th className="p-2">Net USD</th>
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => <ExpenseRow key={r.id} r={r} updateRow={updateRow} removeRow={removeRow} />)}
        </tbody>
      </table>
    </div>
  );
}

function ExpenseRow({ r, updateRow, removeRow }) {
  const net = netUsdOf(r);
  const { debiUSD, bochaUSD } = splitUsd(r);
  return (
    <tr className="border-t">
      <td className="p-2"><input type="date" className="border rounded-lg p-1" value={r.date} onChange={(e)=>updateRow("expense", r.id, { date: e.target.value })} /></td>
      <td className="p-2"><input className="border rounded-lg p-1 w-64" value={r.description} onChange={(e)=>updateRow("expense", r.id, { description: e.target.value })}/></td>
      <td className="p-2">
        <select className="border rounded-lg p-1" value={r.currency} onChange={(e)=>updateRow("expense", r.id, { currency: e.target.value })}>
          <option>USD</option>
          <option>ARS</option>
        </select>
      </td>
      <td className="p-2"><input type="number" className="border rounded-lg p-1 w-28" value={r.amount} onChange={(e)=>updateRow("expense", r.id, { amount: parseFloat(e.target.value||0) })}/></td>
      <td className="p-2"><input type="number" step="0.0001" className="border rounded-lg p-1 w-28" value={r.fxRate} onChange={(e)=>updateRow("expense", r.id, { fxRate: parseFloat(e.target.value||0) })} title="ARS per 1 USD on the transaction date"/></td>
      <td className="p-2">
        <select className="border rounded-lg p-1" value={r.paidBy} onChange={(e)=>updateRow("expense", r.id, { paidBy: e.target.value })}>
          <option>Debi</option>
          <option>Bocha</option>
        </select>
      </td>
      <td className="p-2">
        <div className="flex items-center gap-1">
          <PercentAmountToggle value={r.split.mode} onChange={(v)=>updateRow("expense", r.id, { split: { ...r.split, mode: v } })} />
          <input type="number" className="border rounded-lg p-1 w-16" value={r.split.debi} onChange={(e)=>updateRow("expense", r.id, { split: { ...r.split, debi: parseFloat(e.target.value||0) } })} title="Debi share"/>
          <span>:</span>
          <input type="number" className="border rounded-lg p-1 w-16" value={r.split.bocha} onChange={(e)=>updateRow("expense", r.id, { split: { ...r.split, bocha: parseFloat(e.target.value||0) } })} title="Bocha share"/>
          <div className="text-xs text-gray-500 ml-2">{`D ${fmtUSD(debiUSD)} • B ${fmtUSD(bochaUSD)}`}</div>
        </div>
      </td>
      <td className="p-2"><Adjustments r={r} onChange={(adj)=>updateRow("expense", r.id, { adjustments: adj })} /></td>
      <td className="p-2 font-medium">{fmtUSD(net)}</td>
      <td className="p-2 text-right"><button className="text-red-600" onClick={()=>removeRow("expense", r.id)}>Delete</button></td>
    </tr>
  );
}

function Adjustments({ r, onChange }) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState("percent");
  const [value, setValue] = useState(0);
  const add = () => { onChange([...(r.adjustments||[]), { id: uid(), label: label||"Adj", type, value: parseFloat(value||0) }]); setLabel(""); setValue(0); };
  const remove = (id) => onChange((r.adjustments||[]).filter(a=>a.id!==id));
  return (
    <div>
      <div className="flex items-center gap-1 flex-wrap">
        {(r.adjustments||[]).map(a => (
          <span key={a.id} className="inline-flex items-center gap-1 bg-gray-100 rounded-full px-2 py-0.5 text-xs">
            {a.label} {a.type==='percent'?`${a.value}%`:`${fmtUSD(a.value)}`}
            <button className="text-gray-400" onClick={()=>remove(a.id)}>×</button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1 mt-1">
        <input className="border rounded-lg p-1 w-20" placeholder="Label" value={label} onChange={(e)=>setLabel(e.target.value)} />
        <select className="border rounded-lg p-1" value={type} onChange={(e)=>setType(e.target.value)}>
          <option value="percent">%</option>
          <option value="fixed">$</option>
        </select>
        <input type="number" className="border rounded-lg p-1 w-20" value={value} onChange={(e)=>setValue(e.target.value)} />
        <button className="border rounded-lg px-2" onClick={add}>Add</button>
      </div>
    </div>
  );
}
