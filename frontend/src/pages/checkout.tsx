import React, { useEffect, useRef, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import {
  Box,
  Container,
  Typography,
  CircularProgress,
  Alert,
  Button,
  Stack,
  Link as MuiLink,
} from "@mui/material";
import Header from "../components/Header";
import api from "../lib/api";

/* ---- Response shapes ---- */
interface AttachOrderResponse {
  payment?: any;
  paymentId?: number | string;
  [k: string]: any;
}
type CreateOrderResponse = { orderID?: string; orderId?: string; id?: string; payment?: any; paymentId?: number | string; [k: string]: any };
type CaptureResponse = { id?: number | string; paymentId?: number | string; [k: string]: any };
type CreatePendingResponse = { payment?: any; paymentId?: number | string } | null;

declare global {
  interface Window {
    paypal?: any;
  }
}

/* ---------- Small local helpers ---------- */
function getLocalAuthTokenFromStorage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("auth");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.token ?? null;
  } catch {
    return null;
  }
}

/* ---------- Small local price helper (same mapping used on subscription/practice) ---------- */
function mapPlanPrice(plan?: string | null, billingPeriod?: string | null) {
  const p = (plan || "Pro").toString().toLowerCase();
  const bp = (billingPeriod || "monthly").toString().toLowerCase();
  if (p.includes("pro")) {
    if (bp.includes("year")) return { amount: "99.00", currency: "USD" };
    return { amount: "12.99", currency: "USD" };
  }
  if (p.includes("tutor")) {
    if (bp.includes("year")) return { amount: "199.00", currency: "USD" };
    return { amount: "24.99", currency: "USD" };
  }
  return { amount: "0.00", currency: "USD" };
}

/* ---------- Utilities ---------- */
function formatError(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  try {
    const anyErr = err as any;
    if (anyErr?.message && typeof anyErr.message === "string") return anyErr.message;
  } catch {}
  try {
    return JSON.stringify(err, Object.getOwnPropertyNames(err));
  } catch {
    try {
      return String(err);
    } catch {
      return "Unknown error";
    }
  }
}

/* ---------- localStorage helpers for posting invoice to account page when opener missing ---------- */
const INVOICES_CACHE_KEY = "cached_invoices_v1";
const LAST_CREATED_KEY = "last_created_payment";

function normalizeServerPaymentForCache(serverPayment: any) {
  const createdAtIso =
    serverPayment?.date ||
    serverPayment?.createdAt ||
    serverPayment?.created_at ||
    serverPayment?.__meta?.createdAt ||
    new Date().toISOString();

  // return normalized object (but keep raw)
  return {
    id: String(serverPayment.id ?? `inv-${Math.random().toString(36).slice(2, 9)}`),
    plan: serverPayment.plan ?? serverPayment.plan_name ?? "Unknown",
    amount: String(serverPayment.amount ?? serverPayment.total ?? "0.00"),
    currency: serverPayment.currency ?? "USD",
    issuedAt: createdAtIso,
    createdAt: createdAtIso,
    created_at: createdAtIso,
    status: String(serverPayment.status ?? "pending").toLowerCase(),
    receipt_url: serverPayment.receipt_url ?? `/receipt/${serverPayment.id ?? ""}`,
    reason: serverPayment.reason ?? serverPayment.__meta?.reason ?? "regular",
    change_to: serverPayment.change_to ?? serverPayment.__meta?.change_to ?? null,
    raw: serverPayment,
  };
}

function cacheInvoiceLocally(serverPayment: any) {
  try {
    const norm = normalizeServerPaymentForCache(serverPayment);

    const rawCache = localStorage.getItem(INVOICES_CACHE_KEY);
    const parsedCache = rawCache ? JSON.parse(rawCache) : [];
    const merged = [norm, ...(Array.isArray(parsedCache) ? parsedCache : [])];

    const seen = new Set<string>();
    const deduped = merged.filter((invoice: any) => {
      const key = String(invoice.createdAt ?? invoice.created_at ?? invoice.issuedAt ?? invoice.id ?? "");
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    localStorage.setItem(INVOICES_CACHE_KEY, JSON.stringify(deduped));
    try { localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(serverPayment)); } catch {}
  } catch (e) {
    // noop
  }
}

/* ---------- SDK loader helper ---------- */
async function loadPayPalSdk(sdkSrc: string, timeoutMs = 15000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const existing = Array.from(document.querySelectorAll('script[src^="https://www.paypal.com/sdk/js"], script[src^="https://www.sandbox.paypal.com/sdk/js"]')) as HTMLScriptElement[];

      for (const s of existing) {
        if (s.src && s.src !== sdkSrc) {
          try { s.remove(); } catch {}
        }
      }

      const already = Array.from(document.querySelectorAll(`script[src="${sdkSrc}"]`)).shift() as HTMLScriptElement | undefined;

      const finalize = () => {
        const start = Date.now();
        const int = setInterval(() => {
          if ((window as any).paypal) {
            clearInterval(int);
            resolve();
            return;
          }
          if (Date.now() - start > timeoutMs) {
            clearInterval(int);
            reject(new Error("PayPal SDK did not initialize within timeout"));
          }
        }, 200);
      };

      if (already) {
        finalize();
        return;
      }

      const s = document.createElement("script");
      s.src = sdkSrc;
      s.async = true;
      s.onload = () => {
        finalize();
      };
      s.onerror = () => reject(new Error("Failed to load PayPal SDK script"));
      document.body.appendChild(s);
    } catch (err) {
      reject(err);
    }
  });
}

/** minute-bucket helper used as a loose fallback when invoices lack ids */
function minuteBucketIso(iso: string) {
  try {
    const d = new Date(iso);
    d.setSeconds(0, 0);
    return d.toISOString();
  } catch {
    return iso;
  }
}

/** Poll invoices by id (used to wait for authoritative invoice to appear)
    Modified to normalize, dedupe, and match by id or createdAt/created_at (and fall back to issuedAt minute-buckets).
*/
async function pollInvoicesForId(id: string | number | null, opts?: any, attempts = 15, delayMs = 2000) {
  if (!id) return null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await api.get("/api/payments/invoices", opts);
      const list = res?.data ?? [];
      if (Array.isArray(list)) {
        // Normalize all invoices
        const normalized = (list as any[]).map((it) => {
          const createdAtIso =
            it?.date ||
            it?.createdAt ||
            it?.created_at ||
            it?.__meta?.createdAt ||
            new Date().toISOString();
          return {
            ...it,
            id: String(it.id ?? it.paymentId ?? ""),
            createdAt: createdAtIso,
            created_at: createdAtIso,
            issuedAt: createdAtIso,
          };
        });

        // Deduplicate by createdAt / created_at / issuedAt
        const seen = new Set<string>();
        const deduped = normalized.filter((inv: any) => {
          const key = String(inv.createdAt ?? inv.created_at ?? inv.issuedAt ?? inv.id ?? "");
          if (!key) return true;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        try { localStorage.setItem(INVOICES_CACHE_KEY, JSON.stringify(deduped)); } catch {}

        // Try to find authoritative invoice by id
        const foundById = deduped.find((it: any) => String(it.id) === String(id));
        if (foundById) {
          try { localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(foundById)); } catch {}
          try { window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: foundById } })); } catch {}
          try { if (window.opener) window.opener.postMessage({ type: "payment:created", payment: foundById }, window.location.origin ?? "*"); } catch {}
          return foundById;
        }

        // If not found by id, try to match by createdAt / created_at
        const foundByCreated = deduped.find((it: any) => {
          // compare both createdAt and created_at as strings
          return String(it.createdAt) === String(id) || String(it.created_at) === String(id);
        });
        if (foundByCreated) {
          try { localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(foundByCreated)); } catch {}
          try { window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: foundByCreated } })); } catch {}
          try { if (window.opener) window.opener.postMessage({ type: "payment:created", payment: foundByCreated }, window.location.origin ?? "*"); } catch {}
          return foundByCreated;
        }

        // Loose fallback: if id isn't a real id but a createdAt/issuedAt timestamp, try minute-bucket matching
        const idIsIso = typeof id === "string" && !Number.isFinite(Number(id)) && !/^\d+$/.test(id);
        if (idIsIso) {
          const targetBucket = minuteBucketIso(String(id));
          const foundByBucket = deduped.find((it: any) => minuteBucketIso(String(it.createdAt ?? it.issuedAt ?? "")) === targetBucket);
          if (foundByBucket) {
            try { localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(foundByBucket)); } catch {}
            try { window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: foundByBucket } })); } catch {}
            try { if (window.opener) window.opener.postMessage({ type: "payment:created", payment: foundByBucket }, window.location.origin ?? "*"); } catch {}
            return foundByBucket;
          }
        }
      }
    } catch (e) {
      // ignore fetch errors and retry
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/** Retry capture helper - single implementation (fixes duplicate function error) */
async function retryCapture(orderID: string, opts?: any) {
  try {
    const res = await api.post("/api/payments/capture", { orderID }, opts);
    return res?.data ?? null;
  } catch {
    return null;
  }
}

/** Complete Checkout Page Logic (card funding enabled) */
export default function CheckoutPage(): JSX.Element {
  const router = useRouter();
  const { plan, billingPeriod, amount: amountQuery, invoiceId, reason: reasonQuery } = router.query as {
    plan?: string;
    billingPeriod?: string;
    amount?: string;
    invoiceId?: string;
    reason?: string;
  };

  const apiBase = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || "";

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orderID, setOrderID] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [creating, setCreating] = useState(false);

  // Pending creation lock to avoid duplicate create-pending requests
  const [pendingRequestInProgress, setPendingRequestInProgress] = useState(false);
  const pendingRequestInProgressRef = useRef(false);

  // Use ref for pendingPayment so we don't reinitialize SDK when it changes
  const pendingPaymentRef = useRef<any | null>(null);
  const [pendingPaymentState, setPendingPaymentState] = useState<any | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const computedPrice = (() => {
    if (typeof amountQuery === "string" && amountQuery.trim() !== "") {
      const parts = amountQuery.trim().split(/\s+/);
      const amount = parts[0];
      const currency = parts[1] ?? "USD";
      return { amount: String(amount), currency: String(currency) };
    }
    return mapPlanPrice(plan ?? undefined, billingPeriod ?? undefined);
  })();

  // Persist client_temp_id per checkout parameters so retries / concurrent requests reuse same token
  function clientTempKeyFor(plan?: string, billing?: string, amount?: string) {
    const p = String(plan ?? "Pro");
    const b = String(billing ?? "monthly");
    const a = String(amount ?? "");
    return `checkout_client_temp:${p}:${b}:${a}`;
  }

  function makeTempId() {
    return `temp-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
  }

  function getOrCreateClientTempId() {
    try {
      const k = clientTempKeyFor(plan, billingPeriod, computedPrice.amount);
      const existing = localStorage.getItem(k);
      if (existing) return existing;
      const id = makeTempId();
      localStorage.setItem(k, id);
      return id;
    } catch {
      return makeTempId();
    }
  }

  function clearClientTempId() {
    try {
      const k = clientTempKeyFor(plan, billingPeriod, computedPrice.amount);
      localStorage.removeItem(k);
    } catch {}
  }

  // Create pending invoice on server ASAP (store in ref to avoid re-triggering SDK)
  async function createPendingPaymentOnServer(): Promise<CreatePendingResponse | null> {
    // Prevent duplicate in-flight calls
    if (pendingRequestInProgressRef.current) {
      console.warn("Preventing duplicate create-pending API call");
      return null;
    }
    pendingRequestInProgressRef.current = true;
    setPendingRequestInProgress(true);

    // create and broadcast a synthetic pending invoice immediately so UIs update
    const syntheticId = getOrCreateClientTempId();
    const nowIso = new Date().toISOString();
    const syntheticInvoice = {
      id: syntheticId,
      plan: plan ?? "Pro",
      amount: String(computedPrice.amount ?? "0.00"),
      currency: computedPrice.currency ?? "USD",
      date: nowIso,
      issuedAt: nowIso,
      createdAt: nowIso,
      created_at: nowIso,
      status: "pending_local",
      receipt_url: null,
      reason: reasonQuery ? String(reasonQuery) : "pending_local",
      change_to: null,
      __synthetic: true,
      raw: { __synthetic: true, client_temp_id: syntheticId, __meta: { reason: reasonQuery ?? "regular", createdAt: nowIso, created_at: nowIso } },
    };

    try {
      const raw = localStorage.getItem(INVOICES_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const merged = [syntheticInvoice, ...(Array.isArray(parsed) ? parsed : [])];
      const seen = new Set<string>();
      const dedup = merged.filter((m: any) => {
        const key = String(m.createdAt ?? m.issuedAt ?? m.created_at ?? m.id ?? "");
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      localStorage.setItem(INVOICES_CACHE_KEY, JSON.stringify(dedup));
      localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(syntheticInvoice));
      window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: syntheticInvoice } }));
      if (window.opener) window.opener.postMessage({ type: "payment:created", payment: syntheticInvoice }, window.location.origin ?? "*");
    } catch {}

    const url = "/api/payments/create-pending";
    const payload: any = { plan: plan ?? "Pro", billingPeriod: billingPeriod ?? "monthly", amount: computedPrice.amount, client_temp_id: syntheticId, createdAt: nowIso, created_at: nowIso };
    if (reasonQuery) payload.reason = String(reasonQuery);

    const token = getLocalAuthTokenFromStorage();
    const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;

    try {
      const res = await api.post<CreatePendingResponse>(url, payload, opts);
      const data = res?.data ?? null;

      // Normalize & use server payment if returned
      if (data && (data.payment ?? data)) {
        const serverPaymentRaw = (data.payment ?? data) as any;

        // Normalize the returned serverPayment to include createdAt/created_at
        const createdAtIso =
          serverPaymentRaw?.date ||
          serverPaymentRaw?.createdAt ||
          serverPaymentRaw?.created_at ||
          serverPaymentRaw?.__meta?.createdAt ||
          new Date().toISOString();

        // Mutate/augment serverPaymentRaw so other code can rely on createdAt/created_at
        try {
          serverPaymentRaw.createdAt = createdAtIso;
          serverPaymentRaw.created_at = createdAtIso;
        } catch {}

        // Determine an id for cache usage
        const key = String(serverPaymentRaw.id ?? serverPaymentRaw.paymentId ?? syntheticId ?? `inv-${Math.random().toString(36).slice(2, 9)}`);

        const norm = {
          id: key,
          plan: serverPaymentRaw.plan ?? plan ?? "Unknown",
          amount: String(serverPaymentRaw.amount ?? computedPrice.amount ?? "0.00"),
          currency: serverPaymentRaw.currency ?? computedPrice.currency ?? "USD",
          issuedAt: createdAtIso,
          createdAt: createdAtIso,
          created_at: createdAtIso,
          status: String(serverPaymentRaw.status ?? "pending").toLowerCase(),
          receipt_url: serverPaymentRaw.receipt_url ?? `/receipt/${key}`,
          reason: serverPaymentRaw.reason ?? serverPaymentRaw.__meta?.reason ?? reasonQuery ?? "regular",
          change_to: serverPaymentRaw.change_to ?? serverPaymentRaw.__meta?.change_to ?? null,
          raw: serverPaymentRaw,
        };

        // Update local storage caches & dispatch events
        try {
          const rawCache = localStorage.getItem(INVOICES_CACHE_KEY);
          const parsedCache = rawCache ? JSON.parse(rawCache) : [];
          const filtered = (Array.isArray(parsedCache) ? parsedCache.filter((p: any) => String(p.id) !== syntheticId && String(p.createdAt ?? p.created_at ?? "") !== norm.createdAt) : parsedCache);
          const newCache = [norm, ...filtered];
          const seen2 = new Set<string>();
          const dedup2 = newCache.filter((m: any) => {
            const k = String(m.createdAt ?? m.issuedAt ?? m.created_at ?? m.id ?? "");
            if (!k) return true;
            if (seen2.has(k)) return false;
            seen2.add(k);
            return true;
          });
          localStorage.setItem(INVOICES_CACHE_KEY, JSON.stringify(dedup2));
        } catch {}

        try { localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(serverPaymentRaw)); } catch {}
        try { window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: serverPaymentRaw } })); } catch {}
        try { if (window.opener) window.opener.postMessage({ type: "payment:created", payment: serverPaymentRaw }, window.location.origin ?? "*"); } catch {}

        // Clear the persisted token for this checkout so future checkouts get a fresh token
        clearClientTempId();
        pendingPaymentRef.current = serverPaymentRaw;
        setPendingPaymentState(serverPaymentRaw);
      }

      return data;
    } catch (err: any) {
      const status = err?.response?.status ?? null;
      const serverMsg = err?.response?.data ?? err?.message ?? formatError(err);
      console.warn("[checkout.createPending] create-pending failed", status, serverMsg);
      try {
        if (status === 401 || status === 403) {
          alert("Not authenticated: create-pending failed (401/403). Please log in and try again.");
        } else {
          alert("Failed to create pending invoice on server. See console for details.");
        }
      } catch {}
      return null;
    } finally {
      pendingRequestInProgressRef.current = false;
      setPendingRequestInProgress(false);
    }
  }

  useEffect(() => {
    // Ensure we only create pending once for the given plan/billingPeriod and when they are available
    if (!plan || !billingPeriod) {
      return;
    }
    // Only start create-pending if we don't already have a pending payment
    if (!pendingPaymentRef.current && !pendingPaymentState && !pendingRequestInProgressRef.current) {
      createPendingPaymentOnServer().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, billingPeriod]);

  // Helper to call backend create-order endpoint (used as fallback)
  async function serverCreateOrder(): Promise<CreateOrderResponse> {
    const url = "/api/payments/create-order";
    const payload: any = { plan: plan ?? "Pro", billingPeriod: billingPeriod ?? "monthly" };
    if (amountQuery) payload.amount = computedPrice.amount;
    if (invoiceId) payload.invoiceId = invoiceId;
    if (reasonQuery) payload.reason = String(reasonQuery);
    // include client_temp_id to help server correlate
    try {
      payload.client_temp_id = getOrCreateClientTempId();
    } catch {}
    const token = getLocalAuthTokenFromStorage();
    const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
    const res = await api.post<CreateOrderResponse>(url, payload, opts);
    return res.data;
  }

  // Public attach fallback that includes client_temp_id so server can upsert
  async function publicAttachFallback(orderID: string) {
    try {
      const key = clientTempKeyFor(plan, billingPeriod, computedPrice.amount);
      const clientTemp = localStorage.getItem(key) ?? undefined;
      const createdAt = pendingPaymentRef.current?.createdAt ?? pendingPaymentState?.createdAt ?? new Date().toISOString();
      const res = await api.post<AttachOrderResponse>("/api/payments/attach-order-public", {
        orderID,
        raw: { __meta: { reason: reasonQuery ?? null, client_temp_id: clientTemp ?? null } },
        createdAt,
        created_at: createdAt,
        client_temp_id: clientTemp ?? undefined,
      });
      return res?.data ?? null;
    } catch (e) {
      return null;
    }
  }

  // PayPal Buttons and main UI flow (keeps logic concise but complete)
  useEffect(() => {
    if (!plan || !billingPeriod) {
      setError("Missing plan or billing period. Please select a plan from your account.");
      setLoading(false);
      return;
    }

    if (!clientId) {
      setError("PayPal client id missing. Set NEXT_PUBLIC_PAYPAL_CLIENT_ID in your frontend .env and restart the server.");
      setLoading(false);
      return;
    }

    const sdkSrc = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(
      computedPrice.currency ?? "USD"
    )}&intent=capture&commit=true&enable-funding=card,credit`;

    let mounted = true;

    async function renderButtons(): Promise<void> {
      if (!mounted) return;
      try {
        // If a pending payment already exists, we will reuse it and avoid creating a new one inside createOrder
        if (pendingPaymentRef.current || pendingPaymentState) {
          console.log("Using existing pending payment during PayPal button rendering", pendingPaymentRef.current ?? pendingPaymentState);
        }

        await loadPayPalSdk(sdkSrc, 15000);
      } catch (err) {
        console.error("[checkout] loadPayPalSdk failed:", formatError(err));
        setError("PayPal SDK not available. " + formatError(err));
        setLoading(false);
        return;
      }

      if (!window.paypal) {
        setError("PayPal SDK not available.");
        setLoading(false);
        return;
      }

      if (!containerRef.current) {
        setError("Checkout container unavailable.");
        setLoading(false);
        return;
      }

      containerRef.current.innerHTML = "";

      try {
        // Allow rendering card/credit buttons explicitly as well (if supported for the merchant)
        const allowedFunding = [window.paypal.FUNDING.CARD, window.paypal.FUNDING.CREDIT].filter(Boolean);

        window.paypal.Buttons({
          funding: { allowed: allowedFunding },

          createOrder: async (data: any, actions: any) => {
            // If we already have a pending payment with an id (from createPendingPaymentOnServer), reuse it
            const existingPendingId = pendingPaymentRef.current?.id ?? pendingPaymentState?.id ?? undefined;
            if (existingPendingId) {
              // If SDK supports client-side order creation using invoice id, attach and return that id to PayPal flow.
              // But safest is to let actions.order.create create a formal order and then attach server-side.
              // We still return the created client-side id when available via actions.order.create below.
            }

            // Try client-side creation first
            if (actions && typeof actions.order?.create === "function") {
              try {
                setCreating(true);

                const invoiceIdToUse = pendingPaymentRef.current?.id ? String(pendingPaymentRef.current.id) : undefined;
                const createPayload: any = {
                  purchase_units: [
                    {
                      amount: { value: String(computedPrice.amount), currency_code: String(computedPrice.currency ?? "USD") },
                      description: `BrainiHi subscription — ${plan} (${billingPeriod ?? "one-off"})`,
                      ...(invoiceIdToUse ? { invoice_id: invoiceIdToUse } : {}),
                    },
                  ],
                };

                const clientOrderId = await actions.order.create(createPayload);
                setOrderID(String(clientOrderId));

                // Attach order to pending payment server-side (authenticated preferred)
                if (pendingPaymentRef.current?.id) {
                  try {
                    const token = getLocalAuthTokenFromStorage();
                    const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
                    const attachUrl = "/api/payments/attach-order";
                    // include raw metadata with reason and client_temp_id if available
                    const rawMeta = { __meta: { reason: reasonQuery ?? null, client_temp_id: pendingPaymentRef.current?.client_temp_id ?? null } };
                    const attachRes = await api.post<AttachOrderResponse>(
                      attachUrl,
                      { paymentId: pendingPaymentRef.current.id, orderID: clientOrderId, raw: rawMeta },
                      opts,
                    );

                    // If server returned shaped invoice, update ref/state and notify other pages
                    const serverPayment = attachRes?.data?.payment ?? null;
                    if (serverPayment) {
                      // normalize
                      const createdAtIso =
                        serverPayment.date ||
                        serverPayment.createdAt ||
                        serverPayment.created_at ||
                        new Date().toISOString();
                      try { serverPayment.createdAt = createdAtIso; } catch {}
                      try { serverPayment.created_at = createdAtIso; } catch {}

                      pendingPaymentRef.current = serverPayment;
                      setPendingPaymentState(serverPayment);

                      try {
                        localStorage.setItem("last_created_payment", JSON.stringify(serverPayment));
                        localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(serverPayment));
                      } catch {}
                      try {
                        window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: serverPayment } }));
                      } catch {}
                      try {
                        if (window.opener) window.opener.postMessage({ type: "payment:created", payment: serverPayment }, window.location.origin ?? "*");
                        else cacheInvoiceLocally(serverPayment);
                      } catch {
                        cacheInvoiceLocally(serverPayment);
                      }
                    }
                  } catch (attachErr) {
                    // If authenticated attach fails (401/403/other), attempt public attach fallback
                    console.warn("attach-order failed (auth), attempting public attach:", formatError(attachErr));
                    try {
                      const pubRes = await publicAttachFallback(clientOrderId);
                      const pubPayment = pubRes?.payment ?? pubRes ?? null;
                      if (pubPayment) {
                        const createdAtIso =
                          pubPayment.date ||
                          pubPayment.createdAt ||
                          pubPayment.created_at ||
                          new Date().toISOString();
                        try { pubPayment.createdAt = createdAtIso; } catch {}
                        try { pubPayment.created_at = createdAtIso; } catch {}

                        pendingPaymentRef.current = pubPayment;
                        setPendingPaymentState(pubPayment);
                        try {
                          localStorage.setItem("last_created_payment", JSON.stringify(pubPayment));
                          localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(pubPayment));
                        } catch {}
                        try {
                          window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: pubPayment } }));
                        } catch {}
                        try {
                          if (window.opener) window.opener.postMessage({ type: "payment:created", payment: pubPayment }, window.location.origin ?? "*");
                          else cacheInvoiceLocally(pubPayment);
                        } catch {
                          cacheInvoiceLocally(pubPayment);
                        }
                      }
                    } catch (pubErr) {
                      console.warn("public attach failed", formatError(pubErr));
                    }
                  }
                }

                return clientOrderId;
              } catch (clientErr) {
                console.warn("[checkout] actions.order.create failed, falling back to serverCreateOrder:", formatError(clientErr));
              } finally {
                setCreating(false);
              }
            }

            // Fallback to server-created order
            setCreating(true);
            try {
              const created = await serverCreateOrder();
              const id = created?.orderID ?? created?.orderId ?? created?.id ?? null;
              if (!id) throw new Error("Payment server did not return an order id");
              setOrderID(String(id));
              const serverPayment = (created as any)?.payment ?? null;
              if (serverPayment) {
                try {
                  localStorage.setItem("last_created_payment", JSON.stringify(serverPayment));
                  localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(serverPayment));
                } catch {}
                try {
                  window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: serverPayment } }));
                } catch {}
                try {
                  if (window.opener) window.opener.postMessage({ type: "payment:created", payment: serverPayment }, window.location.origin ?? "*");
                  else cacheInvoiceLocally(serverPayment);
                } catch {
                  cacheInvoiceLocally(serverPayment);
                }
              }
              return id;
            } catch (err) {
              console.error("[checkout] createOrder fallback failed:", formatError(err));
              throw err;
            } finally {
              setCreating(false);
            }
          },

          // UPDATED onApprove: normalize server response, cache & dispatch events, then redirect to receipt
          onApprove: async (data: any) => {
            setProcessing(true);
            setError(null);
            try {
              const token = getLocalAuthTokenFromStorage();
              const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
              const url = "/api/payments/capture";
              const res = await api.post<CaptureResponse>(url, { orderID: data.orderID }, opts);
              const payment = res?.data ?? {};

              // Normalize response: controller now returns invoice-shaped object, but be defensive.
              const saved =
                payment && typeof payment === "object"
                  ? (payment.payment ?? payment) // accept either wrapped { payment: ... } or direct shape
                  : payment;

              // If server returned a normalized invoice shape, persist & notify other pages immediately.
              try {
                if (saved && Object.keys(saved).length > 0) {
                  // Ensure createdAt fields exist for dedupe
                  const savedCreatedAt =
                    (saved.date && new Date(saved.date).toISOString()) ??
                    (saved.createdAt && new Date(saved.createdAt).toISOString()) ??
                    (saved.created_at && new Date(saved.created_at).toISOString()) ??
                    null;
                  if (savedCreatedAt) {
                    try { saved.createdAt = savedCreatedAt; } catch {}
                    try { saved.created_at = savedCreatedAt; } catch {}
                  }

                  // Persist fallback keys used by subscription page
                  try {
                    localStorage.setItem("last_created_payment", JSON.stringify(saved));
                    localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(saved));
                  } catch {}
                  try {
                    // Also merge into cached invoices list used by subscription page
                    const existingRaw = localStorage.getItem(INVOICES_CACHE_KEY);
                    const existing = existingRaw ? JSON.parse(existingRaw) : [];
                    const normalizedForCache = {
                      id: saved.id ?? `inv-${Math.random().toString(36).slice(2, 9)}`,
                      plan: saved.plan ?? "Unknown",
                      amount: String(saved.amount ?? "0.00"),
                      currency: saved.currency ?? "USD",
                      issuedAt: saved.date ?? saved.createdAt ?? new Date().toISOString(),
                      createdAt: saved.createdAt ?? saved.created_at ?? saved.date ?? new Date().toISOString(),
                      created_at: saved.created_at ?? saved.createdAt ?? saved.date ?? new Date().toISOString(),
                      status: String(saved.status ?? "pending").toLowerCase(),
                      receipt_url: saved.receipt_url ?? `/receipt/${saved.id ?? ""}`,
                      reason: saved.reason ?? saved.__meta?.reason ?? null,
                      change_to: saved.change_to ?? saved.__meta?.change_to ?? null,
                      raw: saved,
                    };
                    const merged = [normalizedForCache, ...(Array.isArray(existing) ? existing : [])];
                    // dedupe by createdAt/issuedAt/date (primary)
                    const seen = new Set<string>();
                    const dedup = merged.filter((m: any) => {
                      const createdAtKey = String(m.createdAt ?? m.issuedAt ?? m.date ?? m.created_at ?? m.id ?? "");
                      if (!createdAtKey) return true;
                      if (seen.has(createdAtKey)) return false;
                      seen.add(createdAtKey);
                      return true;
                    });
                    localStorage.setItem(INVOICES_CACHE_KEY, JSON.stringify(dedup));
                    // ensure last_created_payment also present for storage listeners
                    try { localStorage.setItem(LAST_CREATED_KEY, JSON.stringify(saved)); } catch {}
                  } catch {}

                  // Dispatch events for opener/subscription page
                  try {
                    window.dispatchEvent(new CustomEvent("payments:created", { detail: { payment: saved } }));
                  } catch {}
                  try {
                    if (window.opener) {
                      window.opener.postMessage({ type: "payment:created", payment: saved }, window.location.origin ?? "*");
                    }
                  } catch {}
                }
              } catch (cacheErr) {
                // ignore caching errors
              }

              // Start polling the server invoices endpoint to pick up the authoritative invoice row
              const id = (saved as any)?.id ?? (saved as any)?.paymentId ?? null;
              if (token && id) {
                const found = await pollInvoicesForId(id, opts, 15, 2000);
                if (!found) {
                  // If not found after polling, try up to 2 replay captures and poll again
                  for (let attempt = 0; attempt < 2 && !found; attempt++) {
                    console.warn(`[checkout] authoritative invoice not found after poll; retrying capture attempt=${attempt + 1}`);
                    try {
                      await retryCapture(data.orderID, opts);
                    } catch {}
                    const foundRetry = await pollInvoicesForId(id, opts, 10, 2000);
                    if (foundRetry) break;
                  }
                }
              }

              if (!id) {
                setError("Payment succeeded but server did not return a receipt id.");
                return;
              }
              await router.push(`/receipt/${encodeURIComponent(String(id))}`);
            } catch (err: any) {
              console.error("[checkout] capture failed:", formatError(err));
              setError(err?.response?.data?.message ?? formatError(err) ?? "Capture failed. Please retry.");
            } finally {
              setProcessing(false);
            }
          },

          onCancel: () => {
            setError("Payment cancelled. You can retry.");
          },

          onError: (err: any) => {
            console.error("[checkout] PayPal SDK onError:", err);
            setError("PayPal SDK error: " + formatError(err));
          },
        }).render(containerRef.current);
      } catch (err) {
        console.error("[checkout] error rendering PayPal Buttons:", formatError(err));
        setError("Failed to render PayPal buttons. " + formatError(err));
      } finally {
        setLoading(false);
      }
    }

    renderButtons();

    return () => {
      mounted = false;
    };
    // intentionally NOT including pendingPaymentRef/pendingPaymentState to avoid reinitialising the SDK mid-flow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, clientId, plan, billingPeriod, invoiceId, computedPrice.currency, reasonQuery]);

  // Redirect handlers and utilities
  function handleReturnToAccount() {
    router.push("/subscription");
  }

  function copyEnvSample() {
    const sample = "NEXT_PUBLIC_PAYPAL_CLIENT_ID=Your_PayPal_CLIENT_ID_here";
    try {
      navigator.clipboard.writeText(sample);
      alert(".env sample copied to clipboard.");
    } catch {
      alert(`Please add this in your .env file:\n\n${sample}`);
    }
  }

  // Render Checkout Page
  return (
    <>
      <Head>
        <title>Checkout — BrainiHi</title>
      </Head>

      <Header />

      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Box sx={{ p: 3, borderRadius: 2, boxShadow: 1, bgcolor: "background.paper" }}>
          <Typography variant="h5" sx={{ mb: 2 }}>
            Complete payment
          </Typography>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            You are purchasing <strong>{String(plan ?? "")}</strong> — {String(billingPeriod ?? "")}.
          </Typography>

          <Typography variant="subtitle1" sx={{ mb: 3 }}>
            Amount: <strong>{computedPrice.amount} {computedPrice.currency}</strong>
          </Typography>

          {/* Always render the container so the SDK can mount into it when ready */}
          <div ref={containerRef} />

          {loading && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
              <CircularProgress />
            </Box>
          )}

          {!loading && error && (
            <Stack spacing={2} sx={{ mb: 2 }}>
              <Alert severity="error">{error}</Alert>

              {!clientId && (
                <Box sx={{ display: "flex", gap: 2 }}>
                  <Button variant="contained" color="primary" onClick={copyEnvSample}>
                    Copy .env sample
                  </Button>
                  <Button variant="outlined" onClick={handleReturnToAccount}>
                    Return to account
                  </Button>
                </Box>
              )}

              {clientId && (
                <Box sx={{ display: "flex", gap: 2 }}>
                  <Button
                    variant="contained"
                    color="primary"
                    onClick={() => {
                      setError(null);
                      setLoading(true);
                      setTimeout(() => setLoading(false), 250);
                    }}
                    disabled={creating}
                  >
                    {creating ? "Retrying…" : "Retry payment"}
                  </Button>
                  <Button variant="outlined" onClick={handleReturnToAccount}>
                    Return to account
                  </Button>
                </Box>
              )}
            </Stack>
          )}

          {!loading && !error && (
            <>
              {processing && (
                <Typography variant="body2" sx={{ mt: 2 }}>
                  Processing payment…
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>
                Payments are processed securely via PayPal.
              </Typography>
              <Box sx={{ mt: 3 }}>
                <Button variant="outlined" onClick={handleReturnToAccount} disabled={processing}>
                  Return to account
                </Button>
              </Box>
            </>
          )}

          <Box sx={{ mt: 3 }}>
            <Typography variant="caption" color="text.secondary">
              Need help? Contact{" "}
              <MuiLink
                href="https://developer.paypal.com/docs/checkout/"
                target="_blank"
                rel="noopener"
              >
                developer.paypal.com/docs/checkout
              </MuiLink>
              .
            </Typography>
          </Box>
        </Box>
      </Container>
    </>
  );
}