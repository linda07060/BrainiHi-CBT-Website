import React, { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  Box,
  Button,
  Container,
  Grid,
  Paper,
  Typography,
  Chip,
  Divider,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Tooltip,
  Snackbar,
  CircularProgress,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import axios from "axios";
import Header from "../components/Header";
import PaymentMethodDisplay from "../components/PaymentMethodDisplay";
import { useAuth } from "../context/AuthContext";

/* ---------- Helpers ---------- */

function normalizePlanString(candidate?: any): string | null {
  if (candidate === undefined || candidate === null) return null;
  const s = String(candidate).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low.includes("pro")) return "Pro";
  if (low.includes("tutor")) return "Tutor";
  if (low.includes("free")) return "Free";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function mapPlanPrice(plan?: string, billingPeriod?: string) {
  const p = (plan || "Pro").toString().toLowerCase();
  if (p.includes("pro")) {
    if (billingPeriod === "yearly") return { amount: "99.00", currency: "USD" };
    return { amount: "12.99", currency: "USD" };
  }
  if (p.includes("tutor")) {
    if (billingPeriod === "yearly") return { amount: "199.00", currency: "USD" };
    return { amount: "24.99", currency: "USD" };
  }
  return { amount: "0.00", currency: "USD" };
}

function collectPlanCandidatesFromProfile(obj: any): string[] {
  if (!obj || typeof obj !== "object") return [];
  const tryStr = (v: any) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const out: string[] = [];

  const direct = [
    obj.plan,
    obj.planName,
    obj.plan_name,
    obj.subscription?.plan,
    obj.subscription?.name,
    obj.subscription?.product?.name,
    obj.subscription_plan,
    obj.metadata?.plan,
    obj.meta?.plan,
    obj.profile?.plan,
    obj.account?.plan,
    obj.membership?.plan,
    obj.tier,
    obj.role,
  ];
  for (const v of direct) {
    const s = tryStr(v);
    if (s) out.push(s);
  }

  try {
    if (Array.isArray(obj.subscriptions)) {
      for (const s of obj.subscriptions) {
        const cand = tryStr(s?.plan ?? s?.name ?? s?.product?.name ?? s?.price?.product?.name);
        if (cand) out.push(cand);
      }
    }
  } catch {}

  const nested = [
    obj.data?.plan,
    obj.data?.subscription?.plan,
    obj.settings?.plan,
    obj.attributes?.plan,
    obj.info?.plan,
    obj.subscriptionInfo?.plan,
    obj.subscription?.items?.[0]?.plan,
    obj.subscription?.items?.[0]?.price?.product?.metadata?.plan,
    obj.subscription?.items?.[0]?.price?.product?.name,
    obj.subscription?.price?.product?.name,
  ];
  for (const v of nested) {
    const s = tryStr(v);
    if (s) out.push(s);
  }

  const claims = obj?.claims ?? obj?.tokenClaims ?? obj?.payload ?? null;
  if (claims && typeof claims === "object") {
    const s = tryStr(claims.plan) ?? tryStr(claims.planName) ?? tryStr(claims.subscription);
    if (s) out.push(s);
  }

  return out;
}

function getPlanLimits(plan: string): string[] {
  const p = String(plan || "").toLowerCase();
  if (p === "pro") {
    return [
      "Unlimited tests",
      "15–20 questions per test",
      "2 attempts for each test",
      "50 AI explanations per month",
      "No time limits",
    ];
  }
  if (p === "tutor") {
    return [
      "Unlimited tests",
      "20–30 questions per test",
      "Unlimited attempts",
      "1000+ AI explanations per month (soft limit)",
      "Personal AI tutor in chat",
      "Full analytics of weak areas",
    ];
  }
  return ["1 test per day", "10 questions per test", "1 attempt only", "Up to 3 AI explanations per day"];
}

function parseJwtPayload(tokenStr?: string | null): any | null {
  if (!tokenStr) return null;
  try {
    const parts = tokenStr.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/* ---------- Invoice type ---------- */
type InvoiceStatus = "pending" | "paid" | "cancelled" | "completed" | "succeeded" | "success";
type InvoiceReason = "change_plan" | "past_due" | "next_due" | "regular" | "unknown";
type Invoice = {
  id: string;
  plan: string;
  changeTo?: string | null;
  amount: string;
  currency: string;
  issuedAt: string;
  dueAt?: string | null;
  status: InvoiceStatus;
  notes?: string | null;
  reason?: InvoiceReason;
};

/* ---------- localStorage helpers for invoice caching ---------- */
const INVOICES_CACHE_KEY = "cached_invoices_v1";
const LAST_CREATED_KEY = "last_created_payment";
function loadInvoicesFromCache(): Invoice[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(INVOICES_CACHE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Invoice[];
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

/* ---------- Component ---------- */

export default function SubscriptionPage(): JSX.Element {
  const router = useRouter();
  const { token, user: ctxUser, setUser } = useAuth() as any;

  const apiBase = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  // small tooltip text reused
  const txTooltip = "View your billing history — pending and paid invoices";

  // Dev-only debug: log token presence + axios requests/responses for payments endpoints
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    console.debug("[dev][subscription] token present:", !!token, token ? `len=${String(token).length}` : "none");
    const reqId = axios.interceptors.request.use((config) => {
      try {
        if (config.url && String(config.url).includes("/api/payments")) {
          console.debug("[dev][axios.request]", config.method, config.url, { headers: config.headers });
        }
      } catch {}
      return config;
    });
    const resId = axios.interceptors.response.use(
      (res) => {
        try {
          if (res.config?.url && String(res.config.url).includes("/api/payments")) {
            console.debug("[dev][axios.response]", res.status, res.config.url);
          }
        } catch {}
        return res;
      },
      (err) => {
        try {
          if (err?.config?.url && String(err.config.url).includes("/api/payments")) {
            console.warn("[dev][axios.error]", err.response?.status ?? "no-status", err.config.url, err.message);
          }
        } catch {}
        return Promise.reject(err);
      }
    );
    return () => {
      axios.interceptors.request.eject(reqId);
      axios.interceptors.response.eject(resId);
    };
  }, [token]);

  const [sub, setSub] = useState<any | null>(null);
  const [profile, setProfile] = useState<any | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<any | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  const [canonicalPlan, setCanonicalPlan] = useState<string | null>(null);

  const [invoices, setInvoices] = useState<Invoice[]>(() => {
    if (typeof window === "undefined") return [];
    return loadInvoicesFromCache();
  });

  const syntheticInvoiceIdRef = useRef<string | null>(null);

  const [completePaymentDialogOpen, setCompletePaymentDialogOpen] = useState(false);
  const [dialogPlan, setDialogPlan] = useState<string | null>(null);
  const [dialogBilling, setDialogBilling] = useState<"monthly" | "yearly">("monthly");
  const [dialogPrice, setDialogPrice] = useState<{ amount: string; currency: string } | null>(null);

  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  const [snack, setSnack] = useState<{ severity: "success" | "info" | "warning" | "error"; message: string } | null>(null);

  // change plan dialog
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeSelectedPlan, setChangeSelectedPlan] = useState<string | null>(null);
  const [changeBillingPeriod, setChangeBillingPeriod] = useState<"monthly" | "yearly">("monthly");
  const [allowedChangeTargets, setAllowedChangeTargets] = useState<string[] | null>(null);

  const [reactivateDialogOpen, setReactivateDialogOpen] = useState(false);
  const [reactivatePayload, setReactivatePayload] = useState<{ plan: string; amount: string; limits: string[] } | null>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Hide footer on this page
  useEffect(() => {
    if (typeof window === "undefined") return;
    const footer = document.querySelector("footer");
    if (!footer) return;
    const prev = (footer as HTMLElement).style.display;
    (footer as HTMLElement).style.display = "none";
    return () => {
      try {
        (footer as HTMLElement).style.display = prev || "";
      } catch {}
    };
  }, []);

  /* ---------- Load subscription & profile ---------- */
  useEffect(() => {
    let mountedLocal = true;

    async function loadSubscription() {
      setLoading(true);
      try {
        const url = (apiBase ? `${apiBase}` : "") + "/api/payments/subscription";
        let res: any | null = null;
        try {
          res = await axios.get(url, { headers, withCredentials: true });
        } catch {
          res = await axios.get("/api/payments/subscription", { headers, withCredentials: true }).catch(() => null);
        }
        if (!mountedLocal) return;
        setSub(res?.data ?? null);
      } catch {
        if (!mountedLocal) return;
        setSub(null);
      } finally {
        if (mountedLocal) setLoading(false);
      }
    }

    async function loadProfile() {
      if (!token) {
        if (mountedLocal) setProfile(ctxUser ?? null);
        return;
      }
      try {
        const url = (apiBase ? `${apiBase}` : "") + "/auth/me";
        let res: any | null = null;
        try {
          res = await axios.get(url, { headers, withCredentials: true });
        } catch {
          res = await axios.get("/auth/me", { headers, withCredentials: true }).catch(() => null);
        }
        if (!mountedLocal) return;
        const fetchedUser = (res?.data ?? {}) as any;
        setProfile(fetchedUser);

        const candidates = collectPlanCandidatesFromProfile(fetchedUser)
          .map((c) => normalizePlanString(c))
          .filter(Boolean) as string[];
        if (candidates.length > 0) {
          const pref = candidates.includes("Tutor") ? "Tutor" : candidates.includes("Pro") ? "Pro" : candidates[0];
          setCanonicalPlan(pref);
        }

        try {
          const normalizedAuth = { token, user: fetchedUser };
          if (typeof window !== "undefined") localStorage.setItem("auth", JSON.stringify(normalizedAuth));
          try {
            setUser?.(normalizedAuth);
          } catch {}
        } catch {}
      } catch {
        if (mountedLocal) setProfile(ctxUser ?? null);
      }
    }

    loadSubscription();
    loadProfile();

    return () => {
      mountedLocal = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /* ---------- paymentStatus ---------- */
  const fetchPaymentStatus = async () => {
    if (!token) return null;
    try {
      const url = `${process.env.NEXT_PUBLIC_API_URL}/api/payments/check-access`;
      let res: any | null = null;
      try {
        res = await axios.get(url, { headers, withCredentials: true });
      } catch {
        res = await axios.get("/api/payments/check-access", { headers, withCredentials: true }).catch(() => null);
      }
      const data = res?.data ?? null;
      setPaymentStatus(data);
      return data;
    } catch {
      setPaymentStatus(null);
      return null;
    }
  };

  useEffect(() => {
    fetchPaymentStatus().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /* ---------- Invoices fetching (server returns user-scoped invoices) ---------- */
  const fetchInvoices = async () => {
    if (!token) return null;
    try {
      const urlBase = (apiBase ? `${apiBase}` : "") + "/api/payments/invoices";
      // cache-busting param
      const url = `${urlBase}${urlBase.includes("?") ? "&" : "?"}_=${Date.now()}`;

      // request with no-cache headers to avoid 304 caching interfering with data delivery
      const opts = { headers: { ...(headers as any), "Cache-Control": "no-cache", Pragma: "no-cache" }, withCredentials: true };

      let res: any | null = null;
      try {
        res = await axios.get(url, opts);
      } catch (err) {
        // fallback to relative path (in case apiBase is not configured or cross-origin issues)
        try {
          res = await axios.get(`/api/payments/invoices?_=${Date.now()}`, opts).catch(() => null);
        } catch {
          res = null;
        }
      }

      // If 304 Not Modified (some intermediaries), fallback to cached local data
      if (res && res.status === 304) {
        const cached = loadInvoicesFromCache();
        if (cached && cached.length > 0) {
          setInvoices((prev) => {
            const arr = [...cached, ...prev]; // prepend authoritative server list
            saveInvoicesToCache(arr);
            return arr;
          });
          return cached;
        }
        return null;
      }

      const raw = res?.data ?? null;

      // If server returned null / empty, do not clear current invoices (to avoid wiping UI)
      if (!raw) {
        return null;
      }

      // Normalize server response into Invoice[]
      const mapped = (Array.isArray(raw) ? raw : [raw]).map((it: any) => ({
        id: it.id ?? `inv-${Math.random().toString(36).slice(2, 9)}`,
        plan: it.plan ?? "Free",
        amount: String(it.amount ?? "0.00"),
        currency: it.currency ?? "USD",
        status: (it.status ?? "pending") as InvoiceStatus,
        issuedAt: it.date ?? new Date().toISOString(),
        reason: it.reason ?? (it.__meta?.reason ?? null),
        changeTo: it.change_to ?? null,
      })) as Invoice[];

      const sorted = mapped.sort((a, b) => Number(new Date(b.issuedAt)) - Number(new Date(a.issuedAt)));

      // Prepend authoritative server list so UI shows all rows (no merge)
      setInvoices((prev) => {
        const out = [...sorted, ...prev];
        saveInvoicesToCache(out);
        return out;
      });

      return sorted;
    } catch (err) {
      // On error, keep existing invoices (avoid wiping UI), log for debugging
      try {
        // eslint-disable-next-line no-console
        console.warn("[subscription] fetchInvoices failed:", err);
      } catch {}
      return null;
    }
  };

  useEffect(() => {
    // clear UI only when token changes (we still prefer not to blank on transient errors)
    setInvoices(loadInvoicesFromCache());
    // run first fetch immediately and schedule short retries to cover timing windows
    fetchInvoices().catch(() => {});
    const t1 = setTimeout(() => fetchInvoices().catch(() => {}), 500);
    const t2 = setTimeout(() => fetchInvoices().catch(() => {}), 1500);
    const t3 = setTimeout(() => fetchInvoices().catch(() => {}), 3000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /* ---------- Listen for checkout-created invoices (postMessage / custom event / SSE) ---------- */
  useEffect(() => {
    const scheduleRefreshes = () => {
      fetchInvoices().catch(() => {});
      setTimeout(() => fetchInvoices().catch(() => {}), 500);
      setTimeout(() => fetchInvoices().catch(() => {}), 1500);
      setTimeout(() => fetchInvoices().catch(() => {}), 3000);
    };

    const onPaymentsCreatedEvent = (ev: Event) => {
      try {
        const detail = (ev as CustomEvent)?.detail ?? null;
        const payment = detail?.payment ?? null;
        if (payment) {
          const invoice: Invoice = {
            id: payment.id ?? `inv-${Math.random().toString(36).slice(2, 9)}`,
            plan: payment.plan ?? "Free",
            amount: String(payment.amount ?? "0.00"),
            currency: payment.currency ?? "USD",
            issuedAt: payment.date ?? new Date().toISOString(),
            status: (payment.status ?? "pending") as InvoiceStatus,
            reason: payment.reason ?? payment.__meta?.reason ?? null,
            changeTo: payment.change_to ?? payment.__meta?.change_to ?? null,
          };

          setInvoices((prev) => {
            const arr = [invoice, ...prev]; // prepend (no merging)
            saveInvoicesToCache(arr);
            return arr;
          });

          scheduleRefreshes();
        }
      } catch (err) {
        // no-op
      }
    };

    const onWindowMessage = (ev: MessageEvent) => {
      try {
        if (!ev?.data) return;
        if (ev.data?.type === "payment:created" && ev.data?.payment) {
          const payment = ev.data.payment;
          const invoice: Invoice = {
            id: payment.id ?? `inv-${Math.random().toString(36).slice(2, 9)}`,
            plan: payment.plan ?? "Free",
            amount: String(payment.amount ?? "0.00"),
            currency: payment.currency ?? "USD",
            issuedAt: payment.date ?? new Date().toISOString(),
            status: (payment.status ?? "pending") as InvoiceStatus,
            reason: payment.reason ?? payment.__meta?.reason ?? null,
            changeTo: payment.change_to ?? payment.__meta?.change_to ?? null,
          };
          setInvoices((prev) => {
            const arr = [invoice, ...prev]; // prepend (no merging)
            saveInvoicesToCache(arr);
            return arr;
          });
          scheduleRefreshes();
        }
      } catch (err) {
        // noop
      }
    };

    const onStorage = (ev: StorageEvent) => {
      try {
        if (!ev.key) return;
        if (ev.key === LAST_CREATED_KEY && ev.newValue) {
          let parsed = null;
          try { parsed = JSON.parse(ev.newValue); } catch {}
          if (parsed) {
            try { window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: parsed } })); } catch {}
          }
          scheduleRefreshes();
        } else if (ev.key === INVOICES_CACHE_KEY && ev.newValue) {
          try {
            const parsedList = JSON.parse(ev.newValue);
            if (Array.isArray(parsedList)) {
              const mapped = parsedList.map((payment: any) => ({
                id: payment.id ?? `inv-${Math.random().toString(36).slice(2, 9)}`,
                plan: payment.plan ?? "Free",
                amount: String(payment.amount ?? "0.00"),
                currency: payment.currency ?? "USD",
                status: (payment.status ?? "pending") as InvoiceStatus,
                issuedAt: payment.issuedAt ?? payment.date ?? new Date().toISOString(),
                reason: payment.reason ?? payment.__meta?.reason ?? null,
                changeTo: payment.change_to ?? payment.__meta?.change_to ?? null,
              })) as Invoice[];
              setInvoices((prev) => {
                const arr = [...mapped, ...prev]; // prepend authoritative cache contents
                saveInvoicesToCache(arr);
                return arr;
              });
            }
          } catch (e) {}
        }
      } catch {}
    };

    try {
      const raw = localStorage.getItem(LAST_CREATED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.id) {
          window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: parsed } }));
          try { localStorage.removeItem(LAST_CREATED_KEY); } catch {}
        }
      }
    } catch {}

    let es: EventSource | null = null;
    try {
      const baseEvents = apiBase ? `${apiBase}/api/payments/events` : `/api/payments/events`;
      const sseUrl = token ? `${baseEvents}${baseEvents.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : baseEvents;
      es = new EventSource(sseUrl);

      es.addEventListener("paymentCreated", (ev: MessageEvent) => {
        try {
          const payload = JSON.parse((ev as any).data);
          const payment = payload ?? null;
          if (!payment) return;
          const invoice: Invoice = {
            id: payment.id ?? `inv-${Math.random().toString(36).slice(2, 9)}`,
            plan: payment.plan ?? payment.plan_name ?? "Free",
            amount: String(payment.amount ?? "0.00"),
            currency: payment.currency ?? "USD",
            issuedAt:
              payment.date ?? payment.createdAt ?? new Date().toISOString(),
            status: (payment.status ?? "pending") as InvoiceStatus,
            reason: payment.reason ?? payment.__meta?.reason ?? null,
            changeTo: payment.change_to ?? payment.__meta?.change_to ?? null,
          };

          setInvoices((prev) => {
            const arr = [invoice, ...prev]; // prepend (no merging)
            saveInvoicesToCache(arr);
            return arr;
          });

          scheduleRefreshes();
        } catch (err) {
          // ignore
        }
      });

      es.onerror = () => {};
    } catch { /* ignore SSE init errors */ }

    window.addEventListener("payments:created", onPaymentsCreatedEvent as EventListener);
    window.addEventListener("message", onWindowMessage);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener("payments:created", onPaymentsCreatedEvent as EventListener);
      window.removeEventListener("message", onWindowMessage);
      window.removeEventListener("storage", onStorage);
      try {
        if (es) es.close();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, token]);

  /* ---------- Poll while pending to pick up updates immediately after checkout/capture ---------- */
  useEffect(() => {
    let mountedLocal = true;
    let timer: any = null;

    const shouldPoll = () => {
      if (!paymentStatus) return false;
      const isPaid = Boolean(paymentStatus.activeSubscription || paymentStatus.hasSuccessfulPayment);
      const pendingFlag = !isPaid && (paymentStatus?.plan && String(paymentStatus.plan).toLowerCase() !== "free");
      const hasPendingInvoice = invoices.some((i) => String(i.status).toLowerCase() === "pending");
      return Boolean(pendingFlag || hasPendingInvoice);
    };

    async function pollOnce() {
      if (!mountedLocal) return;
      const ps = await fetchPaymentStatus();
      await fetchInvoices();
      try {
        const becameActive = ps && (ps.activeSubscription === true || ps.hasSuccessfulPayment === true);
        if (becameActive && token) {
          const url = (apiBase ? `${apiBase}` : "") + "/auth/me";
          let res: any | null = null;
          try {
            res = await axios.get(url, { headers, withCredentials: true });
          } catch {
            res = await axios.get("/auth/me", { headers, withCredentials: true }).catch(() => null);
          }
          const fetchedUser = (res?.data ?? {}) as any;
          const normalizedAuth = { token, user: fetchedUser };
          try {
            if (typeof window !== "undefined") localStorage.setItem("auth", JSON.stringify(normalizedAuth));
          } catch {}
          try {
            setUser?.(normalizedAuth);
            setProfile(fetchedUser);
          } catch {}
        }
      } catch {}
    }

    if (shouldPoll()) timer = setInterval(() => pollOnce().catch(() => {}), 5000);

    return () => {
      mountedLocal = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentStatus, invoices]);

  /* ---------- Sort & filter invoices (render-ready) ---------- */
  const sortInvoicesByIssuedDesc = (arr: Invoice[]) =>
    [...arr].sort((a, b) => Number(new Date(b.issuedAt)) - Number(new Date(a.issuedAt)));

  const sortedInvoices = useMemo(() => {
    // We intentionally keep duplicates; preserve every DB row received.
    return sortInvoicesByIssuedDesc(invoices);
  }, [invoices]);

  const pendingInvoices = useMemo(() => sortedInvoices.filter((inv) => String(inv.status).toLowerCase() === "pending"), [sortedInvoices]);
  const paidInvoices = useMemo(() => sortedInvoices.filter((i) => ["paid","completed","succeeded","success"].includes(String(i.status).toLowerCase())), [sortedInvoices]);

  /* ---------- Plan resolution ---------- */
  const storedAuth = (() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem("auth");
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();

  const tokenClaims = parseJwtPayload(token ?? null) ?? {};

  const planCandidates = useMemo(() => {
    const list: string[] = [];

    if (paymentStatus?.plan) list.push(String(paymentStatus.plan));
    if (sub) list.push(...collectPlanCandidatesFromProfile(sub));
    if (profile) list.push(...collectPlanCandidatesFromProfile(profile));
    if (ctxUser) {
      list.push(...collectPlanCandidatesFromProfile(ctxUser));
      if (ctxUser?.user) list.push(...collectPlanCandidatesFromProfile(ctxUser.user));
    }
    if (canonicalPlan) list.push(canonicalPlan);
    if (storedAuth?.user) list.push(...collectPlanCandidatesFromProfile(storedAuth.user));
    if (tokenClaims) list.push(...collectPlanCandidatesFromProfile(tokenClaims));

    const q = router.query?.plan;
    if (typeof q === "string" && q.trim() !== "") list.push(q);

    try {
      if (typeof window !== "undefined") {
        const keys = ["selected_plan", "pendingPlan", "registration_plan", "signup_plan"];
        for (const k of keys) {
          const v = localStorage.getItem(k);
          if (v && v.trim() !== "") list.push(v);
        }
      }
    } catch {}

    const normalized = list.map((c) => normalizePlanString(c)).filter(Boolean) as string[];
    return Array.from(new Set(normalized));
  }, [paymentStatus, sub, profile, ctxUser, canonicalPlan, storedAuth, tokenClaims, router.query]);

  const resolvedPlan = useMemo(() => {
    if (!planCandidates || planCandidates.length === 0) return "Free";
    if (planCandidates.includes("Tutor")) return "Tutor";
    if (planCandidates.includes("Pro")) return "Pro";
    return planCandidates[0] ?? "Free";
  }, [planCandidates]);

  /* ---------- billing frequency helper ---------- */
  function getBillingFrequencyDisplay(): string | null {
    const raw = sub?.billing_frequency ?? profile?.billing_frequency ?? paymentStatus?.billing_frequency ?? null;
    if (raw && String(raw).trim() !== "") return String(raw);
    return null;
  }

  /* ---------- Billing info (typed) ---------- */
  const billingInfo = useMemo(() => {
    let status: string = "unknown";

    if (paymentStatus) {
      if (typeof paymentStatus.activeSubscription === "boolean") {
        status = paymentStatus.activeSubscription ? "active" : status;
      }
      if (status === "unknown" && typeof paymentStatus.hasSuccessfulPayment === "boolean") {
        if (paymentStatus.hasSuccessfulPayment === true && !(paymentStatus.activeSubscription === true)) status = "past_due";
      }
      const s = (paymentStatus.status ?? paymentStatus.billing_status ?? null);
      if (s && typeof s === "string") {
        const ls = s.toLowerCase();
        if (ls.includes("active")) status = "active";
        else if (ls.includes("past") || ls.includes("due")) status = "past_due";
        else if (ls.includes("cancel")) status = "cancelled";
        else if (ls.includes("pending")) status = "pending";
      }
    }

    if (status === "unknown") {
      const candidate = (sub?.billing_status ?? profile?.billing_status ?? null);
      if (candidate && typeof candidate === "string") {
        const lc = candidate.toLowerCase();
        if (lc.includes("active")) status = "active";
        else if (lc.includes("past") || lc.includes("due")) status = "past_due";
        else if (lc.includes("cancel")) status = "cancelled";
        else if (lc.includes("pending")) status = "pending";
      }
    }

    if (status === "unknown") {
      if (paidInvoices.length > 0) status = "active";
    }
    if (status === "unknown" || status === "pending") {
      if (pendingInvoices.length > 0) {
        const inv = pendingInvoices[0];
        if ((inv as any).reason === "past_due") status = "past_due";
        else status = "pending";
      }
    }

    const nextPaymentCandidate =
      sub?.next_billing_date ??
      paymentStatus?.next_invoice?.due_at ??
      paymentStatus?.next_billing_date ??
      pendingInvoices[0]?.dueAt ??
      null;

    const nextPayment = nextPaymentCandidate ? new Date(nextPaymentCandidate).toISOString() : null;

    const lastPaymentCandidate = sub?.last_payment_date ?? paidInvoices[0]?.issuedAt ?? null;
    const lastPayment = lastPaymentCandidate ? new Date(lastPaymentCandidate).toISOString() : null;

    return { status, nextPayment, lastPayment } as { status: string; nextPayment: string | null; lastPayment: string | null };
  }, [paymentStatus, sub, profile, pendingInvoices, paidInvoices]);

  function billingStatusColor(status: string) {
    const s = String(status).toLowerCase();
    if (s === "active") return "success";
    if (s === "past_due" || s === "past-due" || s === "pastdue") return "error";
    if (s === "cancelled" || s === "canceled") return "default";
    if (s === "pending") return "warning";
    return "default";
  }

  /* ---------- Derived helpers ---------- */
  const billingFrequencyRaw = (sub?.billing_frequency ?? profile?.billing_frequency ?? "monthly").toString().toLowerCase();
  const billingPeriod = billingFrequencyRaw.includes("year") ? "yearly" : "monthly";
  const expectedPrice = mapPlanPrice(resolvedPlan, billingPeriod);

  const hasPendingPayment = useMemo(() => {
    if (!resolvedPlan || resolvedPlan.toLowerCase() === "free") return false;
    if (paymentStatus) {
      const active = typeof paymentStatus.activeSubscription === "boolean" ? paymentStatus.activeSubscription : Boolean(paymentStatus.active ?? false);
      const hasPaid = Boolean(paymentStatus.hasSuccessfulPayment ?? paymentStatus.hasSuccessful ?? false);
      return !active && !hasPaid;
    }
    const billingStatus = (sub?.billing_status ?? profile?.billing_status ?? "") as string;
    if (!billingStatus) return true;
    if (String(billingStatus).toLowerCase() !== "active") return true;
    return false;
  }, [resolvedPlan, paymentStatus, sub, profile]);

  const completeBtnTooltip = hasPendingPayment
    ? `Pending payment: ${expectedPrice.amount} ${expectedPrice.currency} for ${resolvedPlan} (${billingPeriod})`
    : `No pending payment`;

  /* ---------- Portal open ---------- */
  async function openPortal() {
    setBusy(true);
    try {
      const candidateFromSub = sub?.portal_url ?? sub?.portalUrl ?? sub?.billing_portal_url ?? sub?.billingPortalUrl ?? null;
      const candidateFromPaymentStatus = paymentStatus?.portal_url ?? paymentStatus?.portalUrl ?? null;
      const portalCandidate = candidateFromSub ?? candidateFromPaymentStatus;
      if (portalCandidate) {
        try {
          window.open(portalCandidate, "_blank", "noopener,noreferrer");
          setBusy(false);
          return;
        } catch {
          window.location.href = portalCandidate;
          setBusy(false);
          return;
        }
      }

      const url = (apiBase ? `${apiBase}` : "") + "/api/payments/portal";
      let res: any | null = null;
      try {
        res = await axios.post(url, {}, { headers, withCredentials: true });
      } catch {
        res = await axios.post("/api/payments/portal", {}, { headers, withCredentials: true }).catch(() => null);
      }
      const data: any = res?.data ?? null;
      const portalUrl = (data?.url) ?? (data?.portal_url) ?? (data?.redirectUrl) ?? (data?.checkoutUrl) ?? null;
      if (!portalUrl) {
        setSnack({ severity: "warning", message: "Billing portal unavailable." });
        setBusy(false);
        return;
      }
      try {
        window.open(portalUrl, "_blank", "noopener,noreferrer");
      } catch {
        window.location.href = portalUrl;
      }
    } catch (err: any) {
      console.warn("openPortal failed", err);
      setSnack({ severity: "error", message: err?.response?.data?.message ?? "Unable to open billing portal." });
    } finally {
      setBusy(false);
    }
  }

  /* ---------- Reactivate ---------- */
  function doReactivate() {
    const planCandidate = resolvedPlan || "Pro";
    const price = mapPlanPrice(planCandidate, billingPeriod);
    const limits = getPlanLimits(planCandidate);
    setReactivatePayload({ plan: planCandidate, amount: `${price.amount} ${price.currency}`, limits });
    setReactivateDialogOpen(true);
  }

  async function confirmReactivate() {
    if (!reactivatePayload) return;
    setReactivateDialogOpen(false);
    setBusy(true);
    try {
      await router.push({
        pathname: "/checkout",
        query: {
          plan: reactivatePayload.plan,
          billingPeriod,
          amount: reactivatePayload.amount.split(" ")[0],
          reason: "past_due", // explicit reason for reactivate flow
        },
      });
    } catch (err) {
      console.warn("navigate to checkout failed", err);
      setSnack({ severity: "error", message: "Unable to navigate to checkout. Please try again." });
    } finally {
      setBusy(false);
      setReactivatePayload(null);
    }
  }

  /* ---------- Change plan ---------- */
  const handleOpenChangePlan = () => {
    const current = (resolvedPlan ?? "Free").toLowerCase();
    let allowed: string[] = [];
    if (current === "free") allowed = ["Pro", "Tutor"];
    else if (current === "pro") allowed = ["Tutor"];
    else if (current === "tutor") allowed = ["Pro"];
    else allowed = ["Pro", "Tutor"];
    setAllowedChangeTargets(allowed);
    setChangeSelectedPlan(allowed.length > 0 ? allowed[0] : null);
    // default billing toggle to current billing period (if available) or monthly
    setChangeBillingPeriod(billingPeriod === "yearly" ? "yearly" : "monthly");
    setChangeOpen(true);
  };

  const confirmChangePlan = async () => {
    if (!changeSelectedPlan) return;
    setChangeOpen(false);
    setBusy(true);
    try {
      const amount = mapPlanPrice(changeSelectedPlan, changeBillingPeriod).amount;
      await router.push({
        pathname: "/checkout",
        query: { plan: changeSelectedPlan, billingPeriod: changeBillingPeriod, amount, reason: "change_plan" },
      });
    } catch (err) {
      console.warn("navigate to checkout failed", err);
      setSnack({ severity: "error", message: "Unable to navigate to checkout. Please try again." });
    } finally {
      setBusy(false);
    }
  };

  /* ---------- Invoice dialog ---------- */
  const openInvoiceDialog = (inv: Invoice) => {
    setSelectedInvoice(inv);
    setInvoiceDialogOpen(true);
  };
  const closeInvoiceDialog = () => {
    setSelectedInvoice(null);
    setInvoiceDialogOpen(false);
  };

  const makePaymentForInvoice = async (inv: Invoice) => {
    try {
      await router.push({ pathname: "/checkout", query: { plan: inv.plan, billingPeriod, amount: inv.amount, invoiceId: inv.id } });
      setInvoices((prev) => prev.map((i) => (i.id === inv.id ? { ...i, status: "pending" } : i)));
      setSnack({ severity: "success", message: "Redirecting to checkout..." });
      closeInvoiceDialog();
    } catch (err: any) {
      console.warn("makePaymentForInvoice failed", err);
      setSnack({ severity: "error", message: "Unable to start invoice payment." });
    }
  };

  /* ---------- Complete payment dialog ---------- */
  const openCompletePaymentDialog = (planOverride?: string, billingOverride?: "monthly" | "yearly") => {
    const candidate = planOverride ? normalizePlanString(planOverride) ?? resolvedPlan : resolvedPlan;
    const billing = billingOverride ?? billingPeriod;
    setDialogPlan(candidate);
    setDialogBilling(billing);
    setDialogPrice(mapPlanPrice(candidate, billing));
    setCompletePaymentDialogOpen(true);
  };

  const closeCompletePaymentDialog = () => {
    setCompletePaymentDialogOpen(false);
    setDialogPlan(null);
    setDialogBilling("monthly");
    setDialogPrice(null);
  };

  const proceedToCheckout = async () => {
    const plan = dialogPlan ?? resolvedPlan ?? "Pro";
    const billing = dialogBilling ?? billingPeriod;
    const amount = dialogPrice?.amount ?? mapPlanPrice(plan, billing).amount;
    await router.push({ pathname: "/checkout", query: { plan, billingPeriod: billing, amount } });
    closeCompletePaymentDialog();
  };

  /* ---------- Logout ---------- */
  const handleLogout = () => {
    try {
      if (typeof window !== "undefined") localStorage.removeItem("auth");
    } catch {}
    try { setUser?.(null); } catch {}
    if (typeof window !== "undefined") window.location.replace("/login");
  };

  /* ---------- Display name ---------- */
  const displayName = mounted ? (profile?.name ?? ctxUser?.name ?? profile?.email?.split?.("@")?.[0] ?? "User") : "User";

  /* ---------- Render helpers ---------- */
  const invoiceChip = (inv: Invoice) => {
    const reason = (inv as any).reason ?? "unknown";
    if (["paid", "completed", "succeeded", "success"].includes(String(inv.status).toLowerCase())) return <Chip label="Paid" size="small" color="success" />;
    if (reason === "past_due") return <Chip label="Past due" size="small" color="error" />;
    if (reason === "change_plan") return <Chip label={`Change → ${inv.changeTo ?? inv.plan}`} size="small" sx={{ bgcolor: "#f4e9f0", color: "#7b1d2d" }} />;
    if (reason === "next_due") return <Chip label="Next due" size="small" color="info" />;
    return <Chip label="Pending" size="small" color="warning" />;
  };

  /* ---------- Debug: log invoices changes (helps confirm UI receives server data) ---------- */
  useEffect(() => {
    console.debug("[subscription] invoices state updated:", invoices.map(i => i.id));
  }, [invoices]);

  /* ---------- PLACEHOLDER while hydrating (client mount) ---------- */
  if (!mounted) {
    return (
      <Container maxWidth="lg" sx={{ py: 6, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
        <CircularProgress />
      </Container>
    );
  }

  /* ---------- Render ---------- */
  return (
    <Container maxWidth="lg" sx={{ py: 6 }}>
      <Head>
        <title>Subscription — BrainiHi</title>
      </Head>

      <Header />

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: { xs: "flex-start", md: "space-between" },
          mb: 3,
          flexWrap: "wrap",
          gap: 1,
        }}
      >
        <Box sx={{ minWidth: 0, flex: { xs: "1 1 100%", md: "0 1 auto" } }}>
          <Typography variant="h4" sx={{ fontWeight: 800, wordBreak: "break-word" }}>
            Subscription
          </Typography>
          <Typography variant="subtitle1" color="text.secondary" sx={{ mt: 1 }}>
            Account: {displayName}
          </Typography>
        </Box>

        <Box
          sx={{
            display: "flex",
            gap: 1,
            alignItems: "center",
            flexWrap: "wrap",
            justifyContent: { xs: "center", md: "flex-end" },
            mt: { xs: 2, md: 0 },
            flex: { xs: "1 1 100%", md: "0 0 auto" },
          }}
        >
          <Box sx={{ width: { xs: "90%", sm: "auto" }, maxWidth: { xs: 520, md: "none" } }}>
            <Tooltip title={txTooltip}>
              <Button
                variant="outlined"
                onClick={() => router.push("/transaction-history")}
                fullWidth
                sx={{
                  textTransform: "none",
                  whiteSpace: "nowrap",
                  fontWeight: 700,
                  borderRadius: 2,
                  py: 1.25,
                }}
              >
                Transaction history
              </Button>
            </Tooltip>
          </Box>

          <Box sx={{ width: { xs: "90%", sm: "auto" }, maxWidth: { xs: 520, md: "none" } }}>
            <Tooltip title={completeBtnTooltip}>
              <Box>
                <Button
                  variant="contained"
                  color="secondary"
                  onClick={() => openCompletePaymentDialog(resolvedPlan, billingPeriod)}
                  disabled={busy}
                  fullWidth
                  sx={{
                    textTransform: "none",
                    boxShadow: 2,
                    fontWeight: 800,
                    py: 1.25,
                    borderRadius: 2,
                  }}
                >
                  Complete payment
                </Button>
              </Box>
            </Tooltip>
          </Box>

          <Box sx={{ width: { xs: "90%", sm: "auto" }, maxWidth: { xs: 520, md: "none" } }}>
            <Button
              variant="outlined"
              color="inherit"
              onClick={handleLogout}
              fullWidth
              sx={{
                textTransform: "none",
                whiteSpace: "nowrap",
                fontWeight: 700,
                borderRadius: 2,
                py: 1.25,
              }}
            >
              Logout
            </Button>
          </Box>
        </Box>
      </Box>

      {hasPendingPayment && (
        <Box sx={{ mb: 2 }}>
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" onClick={() => openCompletePaymentDialog(resolvedPlan, billingPeriod)}>Complete payment</Button>
            }
            sx={{
              display: "flex",
              flexDirection: { xs: "column", sm: "row" },
              alignItems: { xs: "flex-start", sm: "center" },
              justifyContent: "space-between",
              gap: 1,
              wordBreak: "break-word",
            }}
          >
            <Box sx={{ flex: 1 }}>
              You have a pending payment of <strong>{expectedPrice.amount} {expectedPrice.currency}</strong> for the <strong>{resolvedPlan}</strong> plan.
            </Box>
          </Alert>
        </Box>
      )}

      <Grid container spacing={3}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: { xs: 2, md: 3 } }}>
            <Typography variant="h6">Plan</Typography>

            <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: 1, flexWrap: "wrap" }}>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>
                {resolvedPlan}
              </Typography>
              <Chip
                label={billingInfo.status ?? "unknown"}
                size="small"
                color={billingStatusColor(billingInfo.status ?? "unknown") as any}
                sx={{ textTransform: "none" }}
              />
            </Box>

            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, wordBreak: "break-word" }}>
              {getBillingFrequencyDisplay() ?? "No billing frequency available"}
            </Typography>

            <Divider sx={{ my: 2 }} />

            <Typography variant="subtitle2">Next payment</Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {billingInfo.nextPayment ? new Date(billingInfo.nextPayment).toLocaleString() : "None scheduled"}
            </Typography>

            <Typography variant="subtitle2" sx={{ mt: 2 }}>
              Last payment
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {billingInfo.lastPayment ? new Date(billingInfo.lastPayment).toLocaleString() : "No payments recorded"}
            </Typography>

            <Divider sx={{ my: 2 }} />

            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
              <Button variant="outlined" onClick={openPortal} disabled={busy} sx={{ textTransform: "none", width: { xs: "100%", sm: "auto" } }}>
                Manage billing
              </Button>

              <Button variant="contained" onClick={() => doReactivate()} disabled={busy || (billingInfo.status === "active")} sx={{ width: { xs: "100%", sm: "auto" } }}>
                Reactivate
              </Button>

              <Button variant="text" onClick={handleOpenChangePlan} sx={{ width: { xs: "100%", sm: "auto" } }}>
                Change plan
              </Button>
            </Stack>

            <Divider sx={{ my: 2 }} />

            <PaymentMethodDisplay token={token} />

            <Box sx={{ mt: 2 }}>
              <Typography variant="h6" sx={{ mb: 1 }}>Billing help & support</Typography>

              <Stack spacing={1}>
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>Why is my invoice missing?</Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Invoices are generated after the payment gateway confirms the transaction. If you completed checkout, allow a minute and then refresh. You can also open the Billing portal to view receipts.
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>I paid but my plan didn't update</Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Payments sometimes take a few moments to reconcile. If your status remains unchanged after a few minutes, open the Billing portal or contact support with your receipt.
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>How can I get a receipt?</Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Receipts are available in the Billing portal and will be emailed to your account address when payment completes.
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>Can I change my billing period?</Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Yes — use the Change plan flow or the billing portal to switch between monthly and yearly billing. Yearly billing usually provides a discount.
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>Need more help?</Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Contact our billing team (include your account email and any receipt IDs) for fastest help.
                  </Typography>
                </Box>

                <Box sx={{ display: "flex", gap: 1, mt: 1, flexWrap: "wrap" }}>
                  <Button variant="contained" size="small" onClick={() => { window.location.href = "mailto:support@brainihi.com"; }}>
                    Email support
                  </Button>
                  <Button variant="outlined" size="small" onClick={() => router.push("/contact")}>
                    Help center
                  </Button>
                </Box>
              </Stack>
            </Box>
          </Paper>
        </Grid>

        <Grid item xs={12} md={6}>
          <Stack spacing={2}>
            <Paper sx={{ p: { xs: 2, md: 3 } }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 2, flexWrap: "wrap" }}>
                <Box>
                  <Typography variant="h6">Subscription insights</Typography>
                  <Typography variant="subtitle2" sx={{ mt: 1 }}>Current plan</Typography>
                  <Typography variant="h6" sx={{ fontWeight: 800 }}>{resolvedPlan}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Status: <strong style={{ textTransform: "capitalize" }}>{billingInfo.status ?? "unknown"}</strong>
                    {billingInfo.nextPayment ? ` • Next: ${new Date(billingInfo.nextPayment).toLocaleString()}` : " • No scheduled payment"}
                  </Typography>
                </Box>

                <Box sx={{ display: "flex", gap: 1 }}>
                  <Tooltip title={txTooltip}>
                    <Button
                      variant="outlined"
                      onClick={() => router.push("/transaction-history")}
                      sx={{ textTransform: "none", whiteSpace: "nowrap" }}
                    >
                      Transaction history
                    </Button>
                  </Tooltip>

                  <Button variant="contained" onClick={() => handleOpenChangePlan()} sx={{ textTransform: "none" }}>
                    Change plan
                  </Button>
                </Box>
              </Box>

              <Divider sx={{ my: 2 }} />

              <Typography variant="subtitle2">Recommended actions</Typography>
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, flexWrap: "wrap" }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>Try Tutor for smarter learning</Typography>
                    <Typography variant="caption" color="text.secondary">Personalized study plans and expanded AI explanations.</Typography>
                  </Box>
                  <Box sx={{ display: "flex", gap: 1 }}>
                    <Button size="small" variant="contained" onClick={() => openCompletePaymentDialog("Tutor", "monthly")}>Explore Tutor</Button>
                  </Box>
                </Box>

                <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, flexWrap: "wrap" }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>Save with yearly billing</Typography>
                    <Typography variant="caption" color="text.secondary">Switch to yearly billing to reduce your monthly cost.</Typography>
                  </Box>
                  <Box sx={{ display: "flex", gap: 1 }}>
                    <Button size="small" variant="outlined" onClick={() => openCompletePaymentDialog(resolvedPlan, "yearly")}>Switch to yearly</Button>
                  </Box>
                </Box>
              </Stack>
            </Paper>

            <Paper sx={{ p: { xs: 2, md: 3 } }}>
              <Typography variant="h6">Usage & limits</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                Plan: <strong>{resolvedPlan}</strong> • Billing: <strong>{billingFrequencyRaw}</strong>
              </Typography>

              <Divider sx={{ my: 2 }} />

              <Typography variant="subtitle2">Plan limits</Typography>
              <Stack spacing={1} sx={{ mt: 1 }}>
                {getPlanLimits(resolvedPlan).map((line, i) => (
                  <Box key={i} sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    <Typography variant="body2">• {line}</Typography>
                    <Typography variant="caption" color="text.secondary">—</Typography>
                  </Box>
                ))}
              </Stack>

              <Divider sx={{ my: 2 }} />

              <Typography variant="subtitle2">Quick actions</Typography>
              <Box sx={{ mt: 1, display: "flex", gap: 1, flexWrap: "wrap" }}>
                <Tooltip title={txTooltip}>
                  <Button variant="outlined" size="small" onClick={() => router.push("/transaction-history")}>Transaction history</Button>
                </Tooltip>
                <Button variant="outlined" size="small" onClick={() => openCompletePaymentDialog(resolvedPlan, billingPeriod)}>Adjust billing</Button>
                <Button variant="contained" size="small" onClick={() => handleOpenChangePlan()}>Upgrade plan</Button>
                <Button variant="text" size="small" onClick={openPortal}>Open billing portal</Button>
              </Box>
            </Paper>
          </Stack>
        </Grid>
      </Grid>

      {/* Change plan dialog - updated to show prices and billing toggle */}
      <Dialog open={changeOpen} onClose={() => setChangeOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Change plan</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ mt: 1 }}>
            <FormControl fullWidth>
              <InputLabel id="change-plan-label">Plan</InputLabel>
              <Select
                labelId="change-plan-label"
                value={changeSelectedPlan ?? ""}
                label="Plan"
                onChange={(e) => setChangeSelectedPlan(String(e.target.value))}
              >
                {(allowedChangeTargets ?? []).filter(p => normalizePlanString(p) !== normalizePlanString(resolvedPlan)).map((p) => (
                  <MenuItem key={p} value={p}>{p}</MenuItem>
                ))}
              </Select>
            </FormControl>

            <Box sx={{ mt: 2, display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
              <Typography variant="subtitle2">Billing period</Typography>
              <ToggleButtonGroup
                value={changeBillingPeriod}
                exclusive
                onChange={(_, val) => {
                  if (!val) return;
                  setChangeBillingPeriod(val);
                }}
                size="small"
              >
                <ToggleButton value="monthly">Monthly</ToggleButton>
                <ToggleButton value="yearly">Yearly</ToggleButton>
              </ToggleButtonGroup>

              <Box sx={{ ml: "auto", textAlign: "right" }}>
                <Typography variant="subtitle2">Price</Typography>
                <Typography variant="h6" sx={{ fontWeight: 800 }}>
                  {changeSelectedPlan ? `${mapPlanPrice(changeSelectedPlan, changeBillingPeriod).amount} ${mapPlanPrice(changeSelectedPlan, changeBillingPeriod).currency}` : "—"}
                </Typography>
              </Box>
            </Box>

            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle2">Plan limits ({changeSelectedPlan ?? "—"})</Typography>
              {(changeSelectedPlan ? getPlanLimits(changeSelectedPlan) : getPlanLimits(resolvedPlan)).map((l, i) => (
                <Typography key={i} variant="body2">• {l}</Typography>
              ))}
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setChangeOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={confirmChangePlan} disabled={!changeSelectedPlan}>Proceed to checkout</Button>
        </DialogActions>
      </Dialog>

      {/* Invoice dialog */}
      <Dialog open={invoiceDialogOpen} onClose={closeInvoiceDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Invoice</DialogTitle>
        <DialogContent dividers>
          {selectedInvoice ? (
            <Box>
              <Typography variant="h6">{selectedInvoice.plan}</Typography>
              <Typography variant="caption" color="text.secondary">{new Date(selectedInvoice.issuedAt).toLocaleString()}</Typography>

              <Divider sx={{ my: 1 }} />

              <Typography variant="subtitle2">Amount</Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>{selectedInvoice.amount} {selectedInvoice.currency}</Typography>

              <Typography variant="subtitle2">Plan limits</Typography>
              {getPlanLimits(selectedInvoice.plan).map((l, i) => (
                <Typography key={`${l}-${i}`} variant="body2">• {l}</Typography>
              ))}

              <Divider sx={{ my: 1 }} />

              <Typography variant="subtitle2">Status</Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>{selectedInvoice.status}</Typography>

              <Typography variant="subtitle2">Issued</Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>{new Date(selectedInvoice.issuedAt).toLocaleString()}</Typography>

              <Typography variant="subtitle2">Plan expiry</Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>{profile?.plan_expiry ? new Date(profile.plan_expiry).toLocaleString() : "N/A"}</Typography>

              {(selectedInvoice as any).reason === "change_plan" && (
                <>
                  <Divider sx={{ my: 1 }} />
                  <Typography variant="caption" color="text.secondary">This invoice is for a plan change{(selectedInvoice as any).changeTo ? ` → ${(selectedInvoice as any).changeTo}` : ""}.</Typography>
                </>
              )}

            </Box>
          ) : (
            <Box sx={{ py: 2 }}><CircularProgress size={20} /></Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeInvoiceDialog}>Close</Button>
          {selectedInvoice && selectedInvoice.status === "pending" && (
            <Button variant="contained" onClick={() => makePaymentForInvoice(selectedInvoice)}>Make payment</Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Reactivate confirmation dialog */}
      <Dialog open={reactivateDialogOpen} onClose={() => setReactivateDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Confirm Reactivation</DialogTitle>
        <DialogContent dividers>
          {reactivatePayload ? (
            <Box>
              <Typography variant="body1" sx={{ mb: 1 }}>
                Confirm you want to reactivate your recent plan: <strong>{reactivatePayload.plan}</strong>
              </Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>
                Amount: <strong>{reactivatePayload.amount}</strong>
              </Typography>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Plan limits</Typography>
              {reactivatePayload.limits.map((l, i) => (
                <Typography key={i} variant="body2">• {l}</Typography>
              ))}
            </Box>
          ) : (
            <Box sx={{ py: 2 }}><CircularProgress size={20} /></Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReactivateDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={confirmReactivate} disabled={busy}>Proceed to checkout</Button>
        </DialogActions>
      </Dialog>

      {/* Complete payment dialog */}
      <Dialog open={completePaymentDialogOpen} onClose={closeCompletePaymentDialog} maxWidth="xs" fullWidth>
        <DialogTitle>Complete payment</DialogTitle>
        <DialogContent>
          <Box sx={{ py: 1 }}>
            <Typography variant="body2" sx={{ mb: 1 }}>
              You're about to pay for the <strong>{dialogPlan ?? resolvedPlan}</strong> plan.
            </Typography>

            <Typography variant="body2" sx={{ mb: 1 }}>
              Billing period:
              <Button size="small" sx={{ ml: 1 }} onClick={() => { setDialogBilling("monthly"); setDialogPrice(mapPlanPrice(dialogPlan ?? resolvedPlan, "monthly")); }} variant={dialogBilling === "monthly" ? "contained" : "outlined"}>Monthly</Button>
              <Button size="small" sx={{ ml: 1 }} onClick={() => { setDialogBilling("yearly"); setDialogPrice(mapPlanPrice(dialogPlan ?? resolvedPlan, "yearly")); }} variant={dialogBilling === "yearly" ? "contained" : "outlined"}>Yearly</Button>
            </Typography>

            <Typography variant="h6" sx={{ mt: 2 }}>
              Amount: {dialogPrice ? `${dialogPrice.amount} ${dialogPrice.currency}` : "—"}
            </Typography>
          </Box>
        </DialogContent>

        <DialogActions>
          <Button onClick={() => { setChangeOpen(true); closeCompletePaymentDialog(); }}>Change plan</Button>
          <Button onClick={closeCompletePaymentDialog}>Cancel</Button>
          <Button variant="contained" onClick={proceedToCheckout}>Proceed to checkout</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!snack} autoHideDuration={5000} onClose={() => setSnack(null)} anchorOrigin={{ vertical: "top", horizontal: "center" }}>
        {snack ? (
          <Alert severity={snack.severity} onClose={() => setSnack(null)} sx={{ width: "100%" }}>
            {snack.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Container>
  );
}