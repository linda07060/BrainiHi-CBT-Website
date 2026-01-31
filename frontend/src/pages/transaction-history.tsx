/* transaction-history.tsx
   Adjusted responsiveness for mobile:
   - On small screens the invoice columns use a larger relative height (60vh) so transactions are visible.
   - On desktop they use the requested calc-based height.
   - The column headers (Clear / title) are sticky so they remain visible while the invoice lists scroll underneath.
   - No logic or behaviour changed (fetching, filtering, clearing, events preserved).
*/
import React, { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import axios from "axios";
import {
  Box,
  Button,
  Container,
  Grid,
  Paper,
  Typography,
  List,
  ListItem,
  ListItemText,
  Stack,
  Chip,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Divider,
  TextField,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  IconButton,
  Alert,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import DeleteIcon from "@mui/icons-material/Delete";

type InvoiceStatus = string;

type Invoice = {
  id: string;
  plan: string;
  amount: string;
  currency: string;
  issuedAt: string;
  status: InvoiceStatus;
  receipt_url?: string | null;
  reason?: string | null;
  changeTo?: string | null;
  raw?: any;
  __synthetic?: boolean;
};

const INVOICES_CACHE_KEY = "cached_invoices_v1";
const LAST_CREATED_KEY = "last_created_payment";

/* ---------- Invoice helpers ---------- */
function tryParseRaw(raw: any) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function normalizeInvoiceShape(raw: any): Invoice {
  const parsed = tryParseRaw(raw) ?? raw ?? {};
  const id =
    String(
      parsed?.id ??
      parsed?.paymentId ??
      parsed?.payment_id ??
      parsed?.invoiceId ??
      parsed?.raw_order_id ??
      parsed?.paypal_order_id ??
      `inv-${Math.random().toString(36).slice(2, 9)}`
    );
  const plan =
    parsed?.plan ?? parsed?.plan_name ?? parsed?.product ?? parsed?.metadata?.plan ?? parsed?.profile?.plan ?? "Unknown";
  const amount = String(parsed?.amount ?? parsed?.total ?? parsed?.price ?? "0.00");
  const currency = parsed?.currency ?? parsed?.currency_code ?? "USD";
  const issuedAt = parsed?.date ?? parsed?.issuedAt ?? parsed?.createdAt ?? parsed?.created_at ?? new Date().toISOString();
  const reason =
    parsed?.reason ??
    parsed?.__meta?.reason ??
    parsed?.change_to ??
    parsed?.changeTo ??
    null;
  const status = String(parsed?.status ?? parsed?.state ?? "pending").toLowerCase();

  return {
    id,
    plan,
    amount,
    currency,
    issuedAt: new Date(issuedAt).toISOString(),
    status,
    receipt_url: parsed?.receipt_url ?? parsed?.receiptUrl ?? null,
    reason,
    changeTo: parsed?.change_to ?? parsed?.changeTo ?? null,
    raw: parsed,
    __synthetic: Boolean(parsed?.__synthetic),
  };
}

function loadInvoicesFromCache(): Invoice[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(INVOICES_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeInvoiceShape);
  } catch {
    return [];
  }
}

function saveInvoicesToCache(list: Invoice[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(INVOICES_CACHE_KEY, JSON.stringify(list));
  } catch {}
}

function statusChip(inv: Invoice) {
  const s = String(inv.status).toLowerCase();
  if (["paid", "completed", "succeeded", "success"].includes(s)) {
    return <Chip label="Paid" color="success" size="small" />;
  }
  if (s.includes("past") || s.includes("due")) {
    return <Chip label="Past due" color="error" size="small" />;
  }
  if (s === "pending" || s === "pending_local") {
    return <Chip label="Pending" color="warning" size="small" />;
  }
  return <Chip label={s} size="small" />;
}

function formatDate(iso?: string) {
  try {
    if (!iso) return "";
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso ?? "");
  }
}

/* ---------- Component ---------- */

export default function TransactionHistoryPage(): JSX.Element {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>(() => {
    try { return typeof window !== "undefined" ? loadInvoicesFromCache() : []; } catch { return []; }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [userName, setUserName] = useState<string | null>(null);
  const [userUid, setUserUid] = useState<string | null>(null);

  const [viewOpen, setViewOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimeoutRef = useRef<number | null>(null);
  const elRefMap = useRef<Record<string, HTMLLIElement | null>>({});

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [amountMin, setAmountMin] = useState<string>("");
  const [amountMax, setAmountMax] = useState<string>("");

  const [latestCreated, setLatestCreated] = useState<any | null>(null);
  const [notifDismissedForId, setNotifDismissedForId] = useState<string | null>(null);

  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});
  const [deletingAll, setDeletingAll] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  useEffect(() => {
    setMounted(true);

    // Resolve basic user name/uid from auth endpoints or localStorage (no plan)
    (async () => {
      try {
        const apiBase = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
        const profileEndpoints = [
          (apiBase ? `${apiBase}` : "") + "/api/auth/me",
          (apiBase ? `${apiBase}` : "") + "/auth/me",
          (apiBase ? `${apiBase}` : "") + "/api/user/me",
        ];
        for (const url of profileEndpoints) {
          try {
            const res = await axios.get<any>(url, { withCredentials: true });
            if (res?.data) {
              const u = res.data;
              setUserName(u?.name ?? u?.email ?? null);
              setUserUid(u?.user_uid ?? u?.userId ?? u?.id ?? null);
              break;
            }
          } catch {}
        }

        // fallback to localStorage auth user
        try {
          const raw = localStorage.getItem("auth");
          if (raw) {
            const parsed = JSON.parse(raw);
            const user = parsed?.user ?? parsed;
            if (user) {
              setUserName((prev) => prev ?? (user?.name ?? user?.email ?? null));
              setUserUid((prev) => prev ?? (user?.user_uid ?? user?.userId ?? user?.id ?? null));
            }
          }
        } catch {}
      } catch {}
    })();

    try {
      const footer = document.querySelector("footer");
      if (footer) {
        (footer as any).__prevDisplay = (footer as HTMLElement).style.display;
        (footer as HTMLElement).style.display = "none";
      }
    } catch {}

    return () => {
      try {
        const footer = document.querySelector("footer");
        if (footer && (footer as any).__prevDisplay !== undefined) {
          (footer as HTMLElement).style.display = (footer as any).__prevDisplay || "";
        }
      } catch {}
      if (highlightTimeoutRef.current) window.clearTimeout(highlightTimeoutRef.current);
    };
  }, []);

  /* ---------- Server fetch REPLACES UI contents (authoritative) ---------- */
  async function fetchInvoicesFromServer() {
    setLoading(true);
    setError(null);
    try {
      const apiBase = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
      const urlBase = (apiBase ? `${apiBase}` : "") + "/api/payments/invoices";
      const url = `${urlBase}${urlBase.includes("?") ? "&" : "?"}_=${Date.now()}`;
      let res: any = null;
      try {
        res = await axios.get<any>(url, { withCredentials: true });
      } catch {
        res = await axios.get<any>(`/api/payments/invoices?_=${Date.now()}`, { withCredentials: true }).catch(() => null);
      }
      const raw = res?.data ?? null;
      if (!raw) { setLoading(false); return; }
      const arr = (Array.isArray(raw) ? raw : [raw]).map(normalizeInvoiceShape);
      // Replace UI with authoritative server list (no merging)
      setInvoices(arr);
      try { saveInvoicesToCache(arr); } catch {}
    } catch (err: any) {
      console.warn("[transaction-history] fetch failed", err?.message ?? err);
      setError("Unable to load invoices.");
    } finally {
      setLoading(false);
    }
  }

  /* ---------- Event listeners: always append incoming then refresh server ---------- */
  useEffect(() => {
    if (!mounted) return;

    fetchInvoicesFromServer().catch(() => {});

    const scheduleServerRefresh = (delay = 700) => {
      setTimeout(() => fetchInvoicesFromServer().catch(() => {}), delay);
    };

    const appendInvoice = (raw: any) => {
      try {
        const inv = normalizeInvoiceShape(raw);
        setInvoices((prev) => {
          const next = [inv, ...prev];
          try { saveInvoicesToCache(next); } catch {}
          return next;
        });
        const tmpKey = String(inv.id);
        setHighlightId(tmpKey);
        if (highlightTimeoutRef.current) window.clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = window.setTimeout(() => setHighlightId(null), 4000);
      } catch {}
    };

    const onPaymentsCreated = (ev: Event) => {
      try {
        const payment = (ev as CustomEvent)?.detail?.payment ?? null;
        if (payment) {
          appendInvoice(payment);
          setLatestCreated(payment);
          scheduleServerRefresh(700);
        }
      } catch {}
    };

    const onWindowMessage = (ev: MessageEvent) => {
      try {
        if (!ev?.data) return;
        if (ev.data?.type === "payment:created" && ev.data?.payment) {
          appendInvoice(ev.data.payment);
          setLatestCreated(ev.data.payment);
          scheduleServerRefresh(700);
        }
      } catch {}
    };

    const onStorage = (ev: StorageEvent) => {
      try {
        if (!ev.key) return;
        if (ev.key === LAST_CREATED_KEY && ev.newValue) {
          let parsed: any = null;
          try { parsed = JSON.parse(ev.newValue); } catch {}
          if (parsed) {
            appendInvoice(parsed);
            setLatestCreated(parsed);
            try { localStorage.removeItem(LAST_CREATED_KEY); } catch {}
            scheduleServerRefresh(700);
          }
        } else if (ev.key === INVOICES_CACHE_KEY && ev.newValue) {
          try {
            const parsedList = JSON.parse(ev.newValue);
            if (Array.isArray(parsedList)) {
              const normalized = parsedList.map(normalizeInvoiceShape);
              setInvoices((prev) => {
                const next = [...normalized, ...prev];
                try { saveInvoicesToCache(next); } catch {}
                return next;
              });
              scheduleServerRefresh(700);
            }
          } catch {}
        }
      } catch {}
    };

    try {
      const raw = localStorage.getItem(LAST_CREATED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed) {
          appendInvoice(parsed);
          setLatestCreated(parsed);
          try { localStorage.removeItem(LAST_CREATED_KEY); } catch {}
          scheduleServerRefresh(700);
        }
      }
    } catch {}

    window.addEventListener("payments:created", onPaymentsCreated as EventListener);
    window.addEventListener("message", onWindowMessage);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener("payments:created", onPaymentsCreated as EventListener);
      window.removeEventListener("message", onWindowMessage);
      window.removeEventListener("storage", onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  /* ---------- Filters & derived ---------- */
  const filteredInvoices = useMemo(() => {
    let arr = [...invoices];
    if (statusFilter && statusFilter !== "all") arr = arr.filter((i) => String(i.status).toLowerCase() === String(statusFilter).toLowerCase());
    if (dateFrom) {
      const fromTs = new Date(dateFrom).getTime();
      if (!isNaN(fromTs)) arr = arr.filter((i) => new Date(i.issuedAt).getTime() >= fromTs);
    }
    if (dateTo) {
      const toTs = new Date(dateTo).getTime();
      if (!isNaN(toTs)) {
        const dayEnd = toTs + 24 * 60 * 60 * 1000 - 1;
        arr = arr.filter((i) => new Date(i.issuedAt).getTime() <= dayEnd);
      }
    }
    const min = parseFloat(amountMin || "");
    const max = parseFloat(amountMax || "");
    if (!isNaN(min)) arr = arr.filter((i) => parseFloat(String(i.amount)) >= min);
    if (!isNaN(max)) arr = arr.filter((i) => parseFloat(String(i.amount)) <= max);
    arr.sort((a, b) => Number(new Date(b.issuedAt)) - Number(new Date(a.issuedAt)));
    return arr;
  }, [invoices, statusFilter, dateFrom, dateTo, amountMin, amountMax]);

  const pendingInvoices = useMemo(() => filteredInvoices.filter((i) => {
    const s = String(i.status).toLowerCase();
    return s === "pending" || s === "pending_local";
  }), [filteredInvoices]);

  const paidInvoices = useMemo(() => filteredInvoices.filter((i) => ["paid","completed","succeeded","success"].includes(String(i.status).toLowerCase())), [filteredInvoices]);

  function openView(inv: Invoice) { setSelectedInvoice(inv); setViewOpen(true); }
  function closeView() { setSelectedInvoice(null); setViewOpen(false); }

  function payInvoice(inv: Invoice) {
    router.push({ pathname: "/checkout", query: { plan: inv.plan, amount: inv.amount, billingPeriod: "monthly", invoiceId: inv.id } });
  }

  function openReceipt(inv: Invoice) {
    if (inv.receipt_url) window.open(inv.receipt_url, "_blank", "noopener,noreferrer");
    else router.push(`/receipt/${encodeURIComponent(inv.id)}`);
  }

  function dismissLatestNotification() {
    if (latestCreated && latestCreated?.id) setNotifDismissedForId(String(latestCreated.id));
    else setNotifDismissedForId("dismissed");
  }

  // Helper to extract paypal order id from raw payload to show in modal
  function extractPaypalOrderId(raw: any): string | null {
    if (!raw) return null;
    try {
      const r = typeof raw === "string" ? JSON.parse(raw) : raw;
      return r?.paypal_order_id ?? r?.paypalOrderId ?? r?.order_id ?? r?.id ?? (r?.purchase_units && r.purchase_units[0] && (r.purchase_units[0].reference_id ?? r.purchase_units[0].invoice_id ?? r.purchase_units[0].payments?.captures?.[0]?.id)) ?? null;
    } catch {
      return null;
    }
  }

  // Clear ALL pending invoices: confirmation modal triggers this
  async function clearAllPendingConfirmed() {
    const pendingCount = pendingInvoices.length;
    if (pendingCount === 0) {
      setClearDialogOpen(false);
      return;
    }
    setDeletingAll(true);
    try {
      const apiBase = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
      const clearEndpoint = (apiBase ? `${apiBase}` : "") + "/api/payments/clear-pending";
      let cleared = false;
      try {
        await axios.delete(clearEndpoint, { withCredentials: true });
        cleared = true;
      } catch (err) {
        try {
          for (const inv of pendingInvoices) {
            const id = String(inv.id);
            if (id.startsWith("temp-")) continue;
            const url = (apiBase ? `${apiBase}` : "") + `/api/payments/${encodeURIComponent(id)}`;
            try { await axios.delete(url, { withCredentials: true }); } catch {
              try { await axios.delete(`/api/payments/${encodeURIComponent(id)}`, { withCredentials: true }); } catch { console.warn("Failed to delete invoice id", id); }
            }
          }
          cleared = true;
        } catch (iterErr) {
          console.warn("clearAll fallback failed", iterErr);
        }
      }

      setInvoices((prev) => {
        const next = prev.filter((p) => {
          const s = String(p.status).toLowerCase();
          return !(s === "pending" || s === "pending_local");
        });
        try { saveInvoicesToCache(next); } catch {}
        return next;
      });

      try { await fetchInvoicesFromServer(); } catch {}

      if (!cleared) {
        alert("Some invoices could not be removed on the server. Local display cleared; please refresh or contact support.");
      }
    } catch (err) {
      console.warn("clearAllPendingConfirmed error", err);
      alert("Failed to clear pending invoices. Try again or contact support.");
    } finally {
      setDeletingAll(false);
      setClearDialogOpen(false);
    }
  }

  if (!mounted) {
    return (
      <>
        <Head><title>Transaction history — BrainiHi</title></Head>
        <Container maxWidth="lg" sx={{ py: 6 }}>
          <Paper sx={{ p: { xs:2, md:3 }, borderRadius: 3 }}>
            <Typography variant="h5">Transaction history</Typography>
            <Box sx={{ py:6, textAlign:"center" }}>
              <CircularProgress />
              <Typography variant="caption" color="text.secondary" sx={{ mt:1, display:"block" }}>Loading…</Typography>
            </Box>
          </Paper>
        </Container>
      </>
    );
  }

  return (
    <>
      <Head><title>Transaction history — BrainiHi</title></Head>
      <Container maxWidth="lg" sx={{ py: 6 }}>
        <Paper
          sx={{
            p: { xs: 2, md: 4 },
            borderRadius: 3,
            boxShadow: "0 4px 18px rgba(15,23,42,0.06)",
            bgcolor: "background.paper",
          }}
        >
          {/* Header / profile row */}
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 2, mb: 2, flexWrap: "wrap" }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h5">Transaction history</Typography>
              <Typography variant="caption" color="text.secondary">Pending and paid invoices</Typography>

              <Box sx={{ mt: 2 }}>
                <Typography variant="body2" sx={{ mb: 0.5 }}><strong>User:</strong> {userName ?? "—"}</Typography>
                <Typography variant="body2"><strong>USER-ID:</strong> {userUid ?? "—"}</Typography>
              </Box>
            </Box>

            <Stack direction="row" spacing={1} sx={{ mt: { xs: 2, md: 0 } }}>
              <Button variant="outlined" onClick={() => fetchInvoicesFromServer()} sx={{ textTransform: "none", borderRadius: 2 }}>
                Refresh
              </Button>
              <Button variant="contained" onClick={() => router.push("/subscription")} sx={{ textTransform: "none", borderRadius: 2, bgcolor: "#7b1d2d", ":hover": { bgcolor: "#6e1830" } }}>
                Back to subscription
              </Button>
            </Stack>
          </Box>

          {/* Space between profile and filters */}
          <Box sx={{ mt: 4 }}>
            {/* Responsive filter grid */}
            <Grid container spacing={2} alignItems="center">
              <Grid item xs={12} sm={6} md={2}>
                <FormControl fullWidth size="small">
                  <InputLabel id="status-filter-label">Status</InputLabel>
                  <Select
                    labelId="status-filter-label"
                    value={statusFilter}
                    label="Status"
                    onChange={(e) => setStatusFilter(String(e.target.value))}
                    sx={{ borderRadius: 2 }}
                  >
                    <MenuItem value="all">All</MenuItem>
                    <MenuItem value="pending">Pending</MenuItem>
                    <MenuItem value="paid">Paid</MenuItem>
                    <MenuItem value="past_due">Past due</MenuItem>
                    <MenuItem value="cancelled">Cancelled</MenuItem>
                  </Select>
                </FormControl>
              </Grid>

              <Grid item xs={12} sm={6} md={2}>
                <TextField
                  fullWidth
                  size="small"
                  label="From"
                  type="date"
                  InputLabelProps={{ shrink: true }}
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </Grid>

              <Grid item xs={12} sm={6} md={2}>
                <TextField
                  fullWidth
                  size="small"
                  label="To"
                  type="date"
                  InputLabelProps={{ shrink: true }}
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </Grid>

              <Grid item xs={12} sm={6} md={3}>
                <TextField
                  fullWidth
                  size="small"
                  label="Min amount"
                  type="number"
                  value={amountMin}
                  onChange={(e) => setAmountMin(e.target.value)}
                />
              </Grid>

              <Grid item xs={12} sm={6} md={2}>
                <TextField
                  fullWidth
                  size="small"
                  label="Max amount"
                  type="number"
                  value={amountMax}
                  onChange={(e) => setAmountMax(e.target.value)}
                />
              </Grid>

              <Grid item xs={12} sm={6} md={1} sx={{ display: "flex", justifyContent: { xs: "flex-start", md: "flex-end" } }}>
                <Button onClick={() => { setStatusFilter("all"); setDateFrom(""); setDateTo(""); setAmountMin(""); setAmountMax(""); }} sx={{ textTransform: "none" }}>
                  Clear
                </Button>
              </Grid>
            </Grid>
          </Box>

          {/* Notification */}
          {latestCreated && String(notifDismissedForId) !== String(latestCreated?.id) && (
            <Box sx={{ mt: 3 }}>
              <Alert severity="info" action={
                <IconButton aria-label="close" color="inherit" size="small" onClick={dismissLatestNotification}><CloseIcon fontSize="small" /></IconButton>
              } sx={{ alignItems:"flex-start", p:2 }}>
                <Box sx={{ display:"flex", flexDirection:"column" }}>
                  <Typography sx={{ fontWeight:700 }}>New invoice generated — {latestCreated?.amount ?? latestCreated?.total ?? "—"}</Typography>
                  <Typography variant="caption" color="text.secondary">{latestCreated?.plan ? `${latestCreated.plan} • ` : ""}{latestCreated?.reason ?? "Most recent invoice"} • {latestCreated?.date ? new Date(latestCreated.date).toLocaleString() : (latestCreated?.createdAt ? new Date(latestCreated.createdAt).toLocaleString() : "")}</Typography>
                  <Box sx={{ mt:1 }}>
                    <Button size="small" variant="contained" onClick={() => router.push({ pathname: "/checkout", query: { invoiceId: latestCreated?.id, plan: latestCreated?.plan, amount: latestCreated?.amount ?? latestCreated?.total } })}>Complete payment</Button>
                    <Button size="small" variant="text" onClick={() => { router.push("/subscription"); }} sx={{ ml:1 }}>Manage billing</Button>
                  </Box>
                </Box>
              </Alert>
            </Box>
          )}

          {/* Content grid with sticky headers and scrollable columns */}
          <Grid container spacing={3} sx={{ mt: 3 }}>
            <Grid item xs={12} md={6}>
              <Paper
                sx={{
                  p: 0,
                  borderRadius: 2,
                  boxShadow: "0 2px 8px rgba(15,23,42,0.04)",
                  // show more results on mobile while still respecting viewport
                  maxHeight: { xs: "77vh", md: "calc(100vh - 130px)" },
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {/* Sticky header inside the column */}
                <Box
                  sx={{
                    p: 2,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    position: "sticky",
                    top: 0,
                    zIndex: 3,
                    bgcolor: "background.paper",
                    borderBottom: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                    <Button
                      variant="outlined"
                      color="error"
                      size="small"
                      onClick={() => setClearDialogOpen(true)}
                      disabled={pendingInvoices.length === 0 || deletingAll}
                      startIcon={<DeleteIcon />}
                      sx={{ borderRadius: 2, textTransform: "none" }}
                    >
                      {deletingAll ? "Clearing…" : "Clear all pending"}
                    </Button>
                    <Typography variant="h6">Pending invoices</Typography>
                  </Box>
                  <Typography variant="caption" color="text.secondary">{pendingInvoices.length}</Typography>
                </Box>

                {/* Scrollable list area */}
                <Box sx={{ overflowY: "auto", px: 2, pt: 2 }}>
                  {loading && pendingInvoices.length === 0 ? (
                    <Box sx={{ display:"flex", justifyContent:"center", py:4 }}><CircularProgress size={20} /></Box>
                  ) : pendingInvoices.length === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No pending invoices</Typography>
                  ) : (
                    <List disablePadding>
                      {pendingInvoices.map((inv, idx) => {
                        const key = `${inv.id}-${idx}`;
                        return (
                          <ListItem
                            key={key}
                            sx={{
                              py:2,
                              px:0,
                              borderBottom:"1px solid",
                              borderColor:"divider",
                              alignItems:"flex-start",
                              background: highlightId === String(inv.id) ? "rgba(255,235,205,0.6)" : "transparent",
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 1,
                            }}
                            ref={(el) => (elRefMap.current[key] = el)}
                          >
                            <ListItemText
                              primary={<Box sx={{ display:"flex", gap:2, alignItems:"baseline", flexWrap:"wrap" }}><Typography sx={{ fontWeight:700 }}>{inv.plan}</Typography><Typography variant="caption" color="text.secondary">{formatDate(inv.issuedAt)}</Typography></Box>}
                              secondary={<Box sx={{ display:"flex", gap:2, alignItems:"center", mt:1 }}><Typography variant="subtitle1" sx={{ fontWeight:700 }}>{inv.amount} {inv.currency}</Typography><Typography variant="caption" color="text.secondary">{inv.reason ?? ""}</Typography></Box>}
                            />

                            <Box sx={{ display:"flex", gap:1, ml:2, alignItems:"center" }}>
                              {statusChip(inv)}
                              <Button variant="outlined" size="small" onClick={() => openView(inv)} sx={{ borderRadius: 1 }}>View</Button>
                              <Button variant="contained" size="small" onClick={() => payInvoice(inv)} sx={{ borderRadius: 1 }}>Pay</Button>
                            </Box>
                          </ListItem>
                        );
                      })}
                    </List>
                  )}
                </Box>
              </Paper>
            </Grid>

            <Grid item xs={12} md={6}>
              <Paper
                sx={{
                  p: 0,
                  borderRadius: 2,
                  boxShadow: "0 2px 8px rgba(15,23,42,0.04)",
                  maxHeight: { xs: "60vh", md: "calc(100vh - 160px)" },
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {/* Sticky header for paid column */}
                <Box
                  sx={{
                    p: 2,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    position: "sticky",
                    top: 0,
                    zIndex: 3,
                    bgcolor: "background.paper",
                    borderBottom: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Typography variant="h6">Paid invoices</Typography>
                  <Typography variant="caption" color="text.secondary">{paidInvoices.length}</Typography>
                </Box>

                {/* Scrollable paid list */}
                <Box sx={{ overflowY: "auto", px: 2, pt: 2 }}>
                  {loading && paidInvoices.length === 0 ? (
                    <Box sx={{ display:"flex", justifyContent:"center", py:4 }}><CircularProgress size={20} /></Box>
                  ) : paidInvoices.length === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No paid invoices</Typography>
                  ) : (
                    <List disablePadding>
                      {paidInvoices.map((inv, idx) => {
                        const key = `${inv.id}-${idx}`;
                        return (
                          <ListItem key={key} sx={{ py:2, px:0, borderBottom:"1px solid", borderColor:"divider", alignItems:"flex-start" }}>
                            <ListItemText
                              primary={<Box sx={{ display:"flex", gap:2, alignItems:"baseline", flexWrap:"wrap" }}><Typography sx={{ fontWeight:700 }}>{inv.plan}</Typography><Typography variant="caption" color="text.secondary">{formatDate(inv.issuedAt)}</Typography></Box>}
                              secondary={<Box sx={{ display:"flex", gap:2, alignItems:"center", mt:1 }}><Typography variant="subtitle1" sx={{ fontWeight:700 }}>{inv.amount} {inv.currency}</Typography><Typography variant="caption" color="text.secondary">{inv.reason ?? ""}</Typography></Box>}
                            />
                            <Box sx={{ display:"flex", gap:1, ml:2, alignItems:"center" }}>
                              {statusChip(inv)}
                              <Button variant="outlined" size="small" onClick={() => openView(inv)} sx={{ borderRadius: 1 }}>View</Button>
                              <Button variant="contained" size="small" onClick={() => openReceipt(inv)} sx={{ borderRadius: 1 }}>Receipt</Button>
                            </Box>
                          </ListItem>
                        );
                      })}
                    </List>
                  )}
                </Box>
              </Paper>
            </Grid>
          </Grid>

          {error && (<Box sx={{ mt:2 }}><Typography variant="caption" color="error">{error}</Typography></Box>)}
        </Paper>
      </Container>

      <Dialog open={viewOpen} onClose={closeView} maxWidth="sm" fullWidth>
        <DialogTitle>Invoice</DialogTitle>
        <DialogContent dividers>
          {selectedInvoice ? (
            <Box>
              <Typography variant="h6" sx={{ fontWeight:800 }}>{selectedInvoice.plan}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display:"block", mb:2 }}>{formatDate(selectedInvoice.issuedAt)}</Typography>

              <Divider sx={{ my:1 }} />

              <Typography variant="subtitle2">Amount</Typography>
              <Typography variant="body1" sx={{ mb:1, fontWeight:700 }}>{selectedInvoice.amount} {selectedInvoice.currency}</Typography>

              <Typography variant="subtitle2">Status</Typography>
              <Typography variant="body2" sx={{ mb:1 }}>{selectedInvoice.status}</Typography>

              <Typography variant="subtitle2">Reason</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb:1 }}>{selectedInvoice.reason ?? "—"}</Typography>

              {/* Show PayPal order id (if present) */}
              <Typography variant="subtitle2">PayPal Order ID</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb:1 }}>
                {(() => {
                  const pid = extractPaypalOrderId(selectedInvoice.raw);
                  return pid ?? "—";
                })()}
              </Typography>

              <Divider sx={{ my:1 }} />
            </Box>
          ) : (
            <Box sx={{ py:4, textAlign:"center" }}><CircularProgress size={20} /></Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeView}>Close</Button>
          {selectedInvoice && String(selectedInvoice.status).toLowerCase().includes("pending") && (<Button variant="contained" onClick={() => { payInvoice(selectedInvoice); closeView(); }}>Pay</Button>)}
          {selectedInvoice && ["paid","completed","succeeded","success"].includes(String(selectedInvoice.status).toLowerCase()) && (<Button variant="contained" onClick={() => { openReceipt(selectedInvoice); closeView(); }}>Receipt</Button>)}
        </DialogActions>
      </Dialog>

      {/* Confirmation dialog for clearing all pending invoices */}
      <Dialog open={clearDialogOpen} onClose={() => setClearDialogOpen(false)}>
        <DialogTitle>Clear pending invoices</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body1">You are about to permanently clear all pending invoices from your account and UI. This action is not reversible.</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display:"block", mt:2 }}>{pendingInvoices.length} pending invoice(s) will be removed.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClearDialogOpen(false)} disabled={deletingAll}>Cancel</Button>
          <Button color="error" variant="contained" onClick={clearAllPendingConfirmed} disabled={deletingAll}>
            {deletingAll ? "Clearing…" : "Clear all pending"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}